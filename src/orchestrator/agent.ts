/**
 * Orchestrator agent.
 * Uses Claude Code natively — reads brief, maps attack surface, spawns research tracks.
 */

import { readFile } from "fs/promises";
import { runAgent } from "../sdk/client.js";
import {
  appendProgress,
  writePlan,
  readAllTrackStates,
  allTracksTerminal,
  initStateDir,
  paths,
} from "../loop/state.js";
import { BoxerClient } from "../sandbox/boxer.js";
import { parseBrief } from "../types/index.js";
import { runRalphLoop, type LoopIteration } from "../loop/runner.js";
import { runResearcher } from "../researcher/agent.js";
import type { RunModelConfig } from "../types/provider.js";
import { getModelInfo, getModelProvider } from "../types/provider.js";
import { runReporter } from "../reporter/agent.js";
import { emitRuntimeEvent } from "../ipc/bus.js";

const SYSTEM_PROMPT = `You are the Orchestrator in an autonomous security research system.

Your job:
1. Read the user's brief and understand the target, scope, and goal.
2. Identify the attack surface — all vulnerability classes and entry points worth investigating.
3. Define research tracks — one focused, falsifiable hypothesis per track (max 6).
4. Write state/plan.md with the attack surface map and track list.
5. For each track, create:
   - state/research/<track-id>/hypothesis.md  (the hypothesis)
   - state/research/<track-id>/status.json    ({"status":"running","trackId":"<id>","hypothesis":"<one-line>","startedAt":"<iso>","updatedAt":"<iso>"})

Use the Write tool for all file creation.
When all files are written, end your response with: ORCHESTRATION_DONE`;

export async function runOrchestrator(
  briefPath: string,
  boxer: BoxerClient,
  modelConfig: RunModelConfig,
): Promise<void> {
  await initStateDir();
  const provider = getModelProvider(modelConfig.model);
  const modelInfo = getModelInfo(modelConfig.model);
  emitRuntimeEvent({
    scope: "session",
    kind: "session_started",
    severity: "info",
    title: "Research session started",
    detail: `${modelInfo.label} via ${provider}`,
    stage: "Starting",
  });
  emitRuntimeEvent({
    scope: "session",
    kind: "stage_changed",
    severity: "info",
    title: "Preparing environment",
    detail: "Creating session state and loading brief",
    stage: "Preparing Environment",
  });
  await appendProgress(
    "orchestrator",
    `[run] Requested model: ${modelConfig.model} (${modelInfo.label}) via ${provider}`,
  );
  const raw = await readFile(briefPath, "utf-8");
  emitRuntimeEvent({
    scope: "session",
    kind: "stage_changed",
    severity: "info",
    title: "Brief loaded",
    detail: `Target: ${parseBrief(raw).target}`,
    stage: "Loading Brief",
  });
  const brief = parseBrief(raw);
  let tracksCreated = false;

  await runRalphLoop(
    async (): Promise<LoopIteration> => {
      if (tracksCreated) {
        emitRuntimeEvent({
          scope: "session",
          kind: "waiting",
          severity: "info",
          title: "Waiting for researchers",
          detail: "Monitoring track completion before report generation",
          stage: "Research In Progress",
        });
        const states = await readAllTrackStates();
        if (allTracksTerminal(states)) {
          emitRuntimeEvent({
            scope: "session",
            kind: "stage_changed",
            severity: "info",
            title: "All tracks are terminal",
            detail: "Starting report generation",
            stage: "Reporting",
          });
          await runReporter(boxer, modelConfig);
          return { done: true, reason: "all tracks terminal, report generated" };
        }
        return { done: false };
      }

      emitRuntimeEvent({
        scope: "session",
        kind: "stage_changed",
        severity: "info",
        title: "Mapping attack surface",
        detail: brief.target,
        stage: "Mapping Attack Surface",
      });
      const result = await runAgent({
        modelConfig,
        systemPrompt: SYSTEM_PROMPT,
        prompt: buildPrompt(brief, raw),
        cwd: process.cwd(),
        trackId: "orchestrator",
        allowedTools: ["Write", "Read", "Edit", "Glob", "Grep"],
        persistHeartbeats: true,
      });

      if (result.result.includes("ORCHESTRATION_DONE")) {
        tracksCreated = true;
        const states = await readAllTrackStates();
        emitRuntimeEvent({
          scope: "session",
          kind: "stage_changed",
          severity: "info",
          title: "Research tracks created",
          detail: `${states.length} track(s) ready`,
          stage: "Launching Researchers",
        });
        // Spawn researchers concurrently — each runs its own loop
        for (const state of states) {
          emitRuntimeEvent({
            scope: "track",
            kind: "track_created",
            severity: "info",
            trackId: state.trackId,
            title: `Track created: ${state.trackId}`,
            detail: state.hypothesis,
            stage: "Queued",
            status: state.status,
          });
          runResearcher(state.trackId, brief, boxer, modelConfig).catch((err: unknown) =>
            console.error(`Researcher ${state.trackId} crashed:`, err),
          );
        }
        emitRuntimeEvent({
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
    { trackId: "orchestrator", label: "Orchestrator", maxIterations: 100, delayMs: 5000, scope: "session" },
  );
}

function buildPrompt(brief: ReturnType<typeof parseBrief>, rawBrief: string): string {
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

Map the attack surface, define tracks (max 6), write all state files, then respond with ORCHESTRATION_DONE.`;
}
