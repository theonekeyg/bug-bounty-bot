/**
 * Researcher agent.
 * Owns one vulnerability hypothesis. Loops until found / disproven / blocked.
 * Uses Claude Code native tools (Bash, Read, Write, Grep, etc.)
 * Boxer is accessed via: curl http://localhost:8080/run
 */

import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { runAgent } from "../sdk/client.js";
import {
  readTrackState,
  writeTrackState,
  updateTrackStatus,
  appendProgress,
  readProgress,
  sessionPaths,
} from "../loop/state.js";
import { BoxerClient } from "../sandbox/boxer.js";
import { runRalphLoop, type LoopIteration } from "../loop/runner.js";
import type { Brief } from "../types/index.js";
import type { RunModelConfig } from "../types/provider.js";
import { emitSessionEvent } from "../ipc/bus.js";
import { updateTrackInDb, upsertTrack } from "../db/sessions.js";

const SYSTEM_PROMPT_TEMPLATE = (stateDir: string, trackId: string) =>
  `You are a Researcher in an autonomous security research system.

You own one specific vulnerability hypothesis. Each time you run, read your state files and continue exactly where you left off.

## Tools available
- Bash — run shell commands inside an isolated Boxer (gVisor) sandbox. No host filesystem access. Network defaults to "none"; pass network:"sandbox" for outbound access.
- Read / Write / Edit — manage state and output files on the host filesystem
- Grep / Glob — search codebases on the host filesystem
- WebFetch / WebSearch — research CVEs, techniques, documentation

## Your loop
1. Read ${stateDir}/research/${trackId}/hypothesis.md and ${stateDir}/research/${trackId}/progress.md to understand current state.
2. Plan the next investigation step.
3. Execute it (use Bash/Grep/Read/WebFetch etc).
4. Append findings to ${stateDir}/research/${trackId}/progress.md after EVERY significant action.
5. When conclusion reached:

   Found vulnerability → write full details to ${stateDir}/research/${trackId}/findings.md, create output/ with:
     - README.md (setup + step-by-step reproduction)
     - setup.sh (environment setup)
     - exploit.ts (TypeScript PoC — mark [UNTESTED] if not run)
   Then end response with: STATUS:found

   Hypothesis disproven → write evidence to ${stateDir}/research/${trackId}/findings.md, end with: STATUS:disproven

   Blocked → write blocker to ${stateDir}/research/${trackId}/progress.md, end with: STATUS:blocked:<reason>

Never end a turn without appending to ${stateDir}/research/${trackId}/progress.md.`;

export async function runResearcher(
  sessionId: string,
  trackId: string,
  brief: Brief,
  boxer: BoxerClient,
  modelConfig: RunModelConfig,
): Promise<void> {
  const paths = sessionPaths(sessionId);

  emitSessionEvent(sessionId, {
    scope: "track",
    kind: "stage_changed",
    severity: "info",
    trackId,
    title: `Track ${trackId} starting`,
    detail: "Preparing workspace and reading track state",
    stage: "Preparing Track",
  });
  // Pre-create a Boxer workspace for this track so Claude can reference it
  let workspaceId: string | undefined;
  try {
    const ws = await boxer.createWorkspace(`track-${trackId}`, "ubuntu:22.04");
    workspaceId = ws.workspaceId;
    const state = await readTrackState(sessionId, trackId);
    if (state) await writeTrackState(sessionId, { ...state, workspaceId });
    await updateTrackInDb(trackId, { workspaceId });
    emitSessionEvent(sessionId, {
      scope: "track",
      kind: "stage_changed",
      severity: "info",
      trackId,
      title: "Workspace ready",
      detail: workspaceId,
      stage: "Reading Hypothesis",
    });
  } catch {
    console.warn(`[researcher:${trackId}] Boxer workspace creation failed — continuing without`);
    emitSessionEvent(sessionId, {
      scope: "track",
      kind: "error",
      severity: "warning",
      trackId,
      title: "Workspace creation failed",
      detail: "Continuing without persistent Boxer workspace",
      stage: "Reading Hypothesis",
    });
  }

  let currentIteration = 1;

  await runRalphLoop(
    async (): Promise<LoopIteration> => {
      const state = await readTrackState(sessionId, trackId);
      if (!state) throw new Error(`Track ${trackId} has no state`);
      if (state.status === "found" || state.status === "disproven" || state.status === "blocked") {
        return { done: true, reason: state.status };
      }

      emitSessionEvent(sessionId, {
        scope: "track",
        kind: "stage_changed",
        severity: "info",
        trackId,
        title: "Reading hypothesis and prior progress",
        detail: state.hypothesis,
        stage: "Reading Hypothesis",
      });

      const hypothesis = await readFile(paths.hypothesisMd(trackId), "utf-8");
      const progress = await readProgress(sessionId, trackId);
      const findings = existsSync(paths.findingsMd(trackId))
        ? await readFile(paths.findingsMd(trackId), "utf-8")
        : "";

      emitSessionEvent(sessionId, {
        scope: "track",
        kind: "stage_changed",
        severity: "info",
        trackId,
        title: "Planning next investigation step",
        detail: hypothesis.split("\n")[0] ?? state.hypothesis,
        stage: "Planning Next Step",
      });
      const result = await runAgent({
        modelConfig,
        systemPrompt: SYSTEM_PROMPT_TEMPLATE(paths.stateDir(), trackId),
        prompt: buildPrompt({
          sessionId,
          trackId,
          brief,
          hypothesis,
          progress,
          findings,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
        }),
        cwd: process.cwd(),
        sessionId,
        trackId,
        iteration: currentIteration,
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
        boxerUrl: boxer.baseUrl,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });

      const response = result.result;

      if (response.includes("STATUS:found")) {
        await updateTrackStatus(sessionId, trackId, "found");
        await updateTrackInDb(trackId, { status: "found" });
        await appendProgress(sessionId, trackId, "[runner] Status → found");
        emitSessionEvent(sessionId, {
          scope: "track",
          kind: "track_status_changed",
          severity: "success",
          trackId,
          title: "Track concluded with a finding",
          detail: "Vulnerability evidence captured",
          stage: "Done",
          status: "found",
        });
        return { done: true, reason: "found" };
      }
      if (response.includes("STATUS:disproven")) {
        await updateTrackStatus(sessionId, trackId, "disproven");
        await updateTrackInDb(trackId, { status: "disproven" });
        await appendProgress(sessionId, trackId, "[runner] Status → disproven");
        emitSessionEvent(sessionId, {
          scope: "track",
          kind: "track_status_changed",
          severity: "info",
          trackId,
          title: "Track disproven",
          detail: "Hypothesis did not hold under investigation",
          stage: "Done",
          status: "disproven",
        });
        return { done: true, reason: "disproven" };
      }
      const blocked = response.match(/STATUS:blocked:(.+)/);
      if (blocked) {
        await updateTrackStatus(sessionId, trackId, "blocked");
        await updateTrackInDb(trackId, {
          status: "blocked",
          blockedReason: blocked[1]?.trim() ?? "blocked",
        });
        await appendProgress(sessionId, trackId, `[runner] Status → blocked: ${blocked[1] ?? ""}`);
        emitSessionEvent(sessionId, {
          scope: "track",
          kind: "track_status_changed",
          severity: "warning",
          trackId,
          title: "Track blocked",
          detail: blocked[1]?.trim() || "Blocked by runtime condition",
          stage: "Blocked",
          status: "blocked",
        });
        return { done: true, reason: `blocked: ${blocked[1] ?? ""}` };
      }

      emitSessionEvent(sessionId, {
        scope: "track",
        kind: "waiting",
        severity: "info",
        trackId,
        title: "Waiting for next researcher iteration",
        detail: "The track will continue automatically",
        stage: "Investigating",
      });
      return { done: false };
    },
    {
      sessionId,
      trackId,
      label: `Researcher:${trackId}`,
      maxIterations: 50,
      delayMs: 2000,
      onIteration: (i) => { currentIteration = i; },
    },
  );

  if (workspaceId) {
    try {
      await boxer.deleteWorkspace(workspaceId);
    } catch {
      /* non-critical */
    }
  }
}

interface PromptArgs {
  sessionId: string;
  trackId: string;
  brief: Brief;
  hypothesis: string;
  progress: string;
  findings: string;
  workspaceId?: string;
}

function buildPrompt(args: PromptArgs): string {
  return `## Your Research Track
Track ID: ${args.trackId}
${args.workspaceId ? `Boxer Workspace ID: ${args.workspaceId} — include in Boxer API calls as "workspaceId" field for persistent filesystem` : "No Boxer workspace — use stateless sandbox executions."}

## Target Brief
- Target: ${args.brief.target}
- Scope: ${args.brief.scope}
- Goal: ${args.brief.goal}
${args.brief.code ? `- Code: ${args.brief.code.join(", ")}` : ""}
${args.brief.links ? `- Links: ${args.brief.links.join(", ")}` : ""}

## Your Hypothesis
${args.hypothesis}

## Progress So Far
${args.progress || "(none — first iteration)"}

## Findings So Far
${args.findings || "(none yet)"}

---
Continue the investigation. Read progress.md, pick up where you left off, and append to it after every action.`;
}
