/**
 * Orchestrator agent.
 * Uses Claude Code natively — reads brief, maps attack surface, spawns research tracks.
 */

import { readFile } from "fs/promises";
import { runAgent } from "../sdk/client.js";
import {
  appendProgress,
  readAllTrackStates,
  allTracksTerminal,
  initStateDir,
  sessionPaths,
} from "../loop/state.js";
import { BoxerClient } from "../sandbox/boxer.js";
import { parseBrief } from "../types/index.js";
import { runRalphLoop, type LoopIteration } from "../loop/runner.js";
import { runResearcher } from "../researcher/agent.js";
import type { RunModelConfig } from "../types/provider.js";
import { getModelInfo, getModelProvider } from "../types/provider.js";
import { runReporter } from "../reporter/agent.js";
import { emitSessionEvent } from "../ipc/bus.js";
import { createSession, updateSessionStatus, upsertTrack } from "../db/sessions.js";

const SYSTEM_PROMPT_TEMPLATE = (stateDir: string, maxTracks: number) => `You are the Orchestrator in an autonomous security research system.

Your job:
1. Read the user's brief and understand the target, scope, and goal.
2. Identify the attack surface — all vulnerability classes and entry points worth investigating.
3. Define research tracks — one focused, falsifiable hypothesis per track (max ${maxTracks}).
4. Write ${stateDir}/plan.md with the attack surface map and track list.
5. For each track, create:
   - ${stateDir}/research/<track-id>/hypothesis.md  (the hypothesis)
   - ${stateDir}/research/<track-id>/status.json    ({"status":"running","trackId":"<id>","hypothesis":"<one-line>","startedAt":"<iso>","updatedAt":"<iso>"})

Use the Write tool for all file creation.
When all files are written, end your response with: ORCHESTRATION_DONE`;

export interface OrchestratorOpts {
  /** Resume an existing session instead of creating a new one. */
  sessionId?: string;
}

export async function runOrchestrator(
  briefPath: string,
  boxer: BoxerClient,
  modelConfig: RunModelConfig,
  opts: OrchestratorOpts = {},
): Promise<void> {
  const provider = getModelProvider(modelConfig.model);
  const modelInfo = getModelInfo(modelConfig.model);
  const raw = await readFile(briefPath, "utf-8");
  const brief = parseBrief(raw);

  // ── Session setup ───────────────────────────────────────────────────────────
  let sessionId: string;
  let resuming = false;

  if (opts.sessionId) {
    // Resume an interrupted session — reuse existing state on disk.
    sessionId = opts.sessionId;
    resuming = true;
    await updateSessionStatus(sessionId, "running");
    await initStateDir(sessionId);
  } else {
    // New session — create DB record and fresh state directory.
    sessionId = await createSession({
      target: brief.target,
      briefPath,
      briefContent: raw,
      model: modelConfig.model,
      boxerUrl: boxer.baseUrl ?? "http://localhost:8080",
      maxTracks: modelConfig.maxTracks,
    });
    await initStateDir(sessionId);
  }

  const paths = sessionPaths(sessionId);

  emitSessionEvent(sessionId, {
    scope: "session",
    kind: "session_started",
    severity: "info",
    title: resuming ? "Research session resumed" : "Research session started",
    detail: `${modelInfo.label} via ${provider}`,
    stage: "Starting",
  });
  emitSessionEvent(sessionId, {
    scope: "session",
    kind: "stage_changed",
    severity: "info",
    title: "Preparing environment",
    detail: "Creating session state and loading brief",
    stage: "Preparing Environment",
  });
  await appendProgress(
    sessionId,
    "orchestrator",
    `[run] Requested model: ${modelConfig.model} (${modelInfo.label}) via ${provider}${resuming ? " (RESUMED)" : ""}`,
  );
  emitSessionEvent(sessionId, {
    scope: "session",
    kind: "stage_changed",
    severity: "info",
    title: "Brief loaded",
    detail: `Target: ${brief.target}`,
    stage: "Loading Brief",
  });

  let tracksCreated = false;
  let currentIteration = 1;

  // If resuming and plan already exists, skip orchestration and go to research.
  const existingStates = await readAllTrackStates(sessionId);
  if (resuming && existingStates.length > 0) {
    tracksCreated = true;
    const nonTerminal = existingStates.filter(
      (s) => s.status !== "found" && s.status !== "disproven" && s.status !== "blocked",
    );
    emitSessionEvent(sessionId, {
      scope: "session",
      kind: "stage_changed",
      severity: "info",
      title: "Resuming research",
      detail: `${nonTerminal.length} track(s) need resumption, ${existingStates.length - nonTerminal.length} already terminal`,
      stage: "Launching Researchers",
    });
    for (const state of nonTerminal) {
      emitSessionEvent(sessionId, {
        scope: "track",
        kind: "track_created",
        severity: "info",
        trackId: state.trackId,
        title: `Track resumed: ${state.trackId}`,
        detail: state.hypothesis,
        stage: "Queued",
        status: state.status,
      });
      runResearcher(sessionId, state.trackId, brief, boxer, modelConfig).catch((err: unknown) =>
        console.error(`Researcher ${state.trackId} crashed:`, err),
      );
    }
    emitSessionEvent(sessionId, {
      scope: "session",
      kind: "stage_changed",
      severity: "info",
      title: "Researchers re-launched",
      detail: "Investigation resumed across active tracks",
      stage: "Research In Progress",
    });
  }

  await runRalphLoop(
    async (): Promise<LoopIteration> => {
      if (tracksCreated) {
        emitSessionEvent(sessionId, {
          scope: "session",
          kind: "waiting",
          severity: "info",
          title: "Waiting for researchers",
          detail: "Monitoring track completion before report generation",
          stage: "Research In Progress",
        });
        const states = await readAllTrackStates(sessionId);
        if (allTracksTerminal(states)) {
          emitSessionEvent(sessionId, {
            scope: "session",
            kind: "stage_changed",
            severity: "info",
            title: "All tracks are terminal",
            detail: "Starting report generation",
            stage: "Reporting",
          });
          await runReporter(sessionId, boxer, modelConfig);
          await updateSessionStatus(sessionId, "completed");
          return { done: true, reason: "all tracks terminal, report generated" };
        }
        return { done: false };
      }

      emitSessionEvent(sessionId, {
        scope: "session",
        kind: "stage_changed",
        severity: "info",
        title: "Mapping attack surface",
        detail: brief.target,
        stage: "Mapping Attack Surface",
      });
      const result = await runAgent({
        modelConfig,
        systemPrompt: SYSTEM_PROMPT_TEMPLATE(paths.stateDir(), modelConfig.maxTracks),
        prompt: buildPrompt(brief, raw, modelConfig.maxTracks),
        cwd: process.cwd(),
        sessionId,
        trackId: "orchestrator",
        iteration: currentIteration,
        allowedTools: ["Write", "Read", "Edit", "Glob", "Grep"],
        persistHeartbeats: true,
      });

      if (result.result.includes("ORCHESTRATION_DONE")) {
        tracksCreated = true;
        const states = await readAllTrackStates(sessionId);
        emitSessionEvent(sessionId, {
          scope: "session",
          kind: "stage_changed",
          severity: "info",
          title: "Research tracks created",
          detail: `${states.length} track(s) ready`,
          stage: "Launching Researchers",
        });
        // Register tracks in DB and spawn researchers concurrently
        for (const state of states) {
          await upsertTrack({
            id: state.trackId,
            sessionId,
            hypothesis: state.hypothesis,
            status: state.status,
          });
          emitSessionEvent(sessionId, {
            scope: "track",
            kind: "track_created",
            severity: "info",
            trackId: state.trackId,
            title: `Track created: ${state.trackId}`,
            detail: state.hypothesis,
            stage: "Queued",
            status: state.status,
          });
          runResearcher(sessionId, state.trackId, brief, boxer, modelConfig).catch((err: unknown) =>
            console.error(`Researcher ${state.trackId} crashed:`, err),
          );
        }
        emitSessionEvent(sessionId, {
          scope: "session",
          kind: "stage_changed",
          severity: "info",
          title: "Researchers launched",
          detail: "Investigation is now running across active tracks",
          stage: "Research In Progress",
        });
      }

      return { done: false };
    },
    {
      sessionId,
      trackId: "orchestrator",
      label: "Orchestrator",
      maxIterations: 100,
      delayMs: 5000,
      scope: "session",
      onIteration: (i) => { currentIteration = i; },
    },
  );
}

function buildPrompt(brief: ReturnType<typeof parseBrief>, rawBrief: string, maxTracks: number): string {
  return `Start a new security research engagement.

## Raw Brief
${rawBrief}

## Parsed
- Target: ${brief.target}
- Scope: ${brief.scope}
- Goal: ${brief.goal}
${brief.code ? `- Code: ${brief.code.join(", ")}` : ""}
${brief.links ? `- Links: ${brief.links.join(", ")}` : ""}
${brief.context ? `- Context: ${brief.context}` : ""}

Map the attack surface, define tracks (max ${maxTracks}), write all state files, then respond with ORCHESTRATION_DONE.`;
}
