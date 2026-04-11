/**
 * Ralph Loop runner.
 *
 * The loop keeps invoking an agent function until either:
 *  - it signals completion (returns { done: true })
 *  - maxIterations is reached
 *  - an unrecoverable error occurs
 *
 * Between each iteration, the runner sleeps briefly and re-reads state from disk.
 * This means a fresh agent context on each call is valid — state lives on disk, not in memory.
 */

import { appendProgress, checkStopSignal } from "./state.js";
import { emitRuntimeEvent } from "../ipc/bus.js";

export interface LoopIteration {
  done: boolean;
  reason?: string;
}

export interface RalphLoopOptions {
  sessionId: string;
  trackId: string;
  label: string;
  maxIterations?: number;
  delayMs?: number;
  onIteration?: (iteration: number) => void;
  scope?: "session" | "track";
}

/**
 * Run an agent function in a Ralph Loop until it signals completion.
 *
 * @param agentFn - Async function representing one agent "turn". Must read its own
 *                  state from disk and return { done: true } when finished.
 * @param opts    - Loop configuration.
 */
export async function runRalphLoop(
  agentFn: () => Promise<LoopIteration>,
  opts: RalphLoopOptions,
): Promise<void> {
  const { sessionId, trackId, label, maxIterations = 50, delayMs = 1000, scope = "track" } = opts;
  let iteration = 0;

  await appendProgress(sessionId, trackId, `[loop] Starting "${label}" (maxIterations=${maxIterations})`);

  while (iteration < maxIterations) {
    // Check for user-requested stop before each iteration
    if (checkStopSignal(sessionId)) {
      const msg = `[loop] "${label}" stopped by user request.`;
      await appendProgress(sessionId, trackId, msg);
      emitRuntimeEvent({
        scope,
        kind: "stage_changed",
        severity: "warning",
        trackId: scope === "track" ? trackId : undefined,
        title: `${label} stopped`,
        detail: "Stopped by user — can be resumed.",
        stage: "Stopped",
      });
      console.log(msg);
      return;
    }

    iteration++;
    opts.onIteration?.(iteration);

    let result: LoopIteration;
    try {
      result = await agentFn();
    } catch (err) {
      const msg = `[loop] Iteration ${iteration} threw: ${String(err)}`;
      await appendProgress(sessionId, trackId, msg);
      emitRuntimeEvent({
        scope,
        kind: "retrying",
        severity: "warning",
        trackId: scope === "track" ? trackId : undefined,
        title: `${label} iteration ${iteration} failed`,
        detail: String(err),
      });
      console.error(msg);
      // Continue — one bad iteration should not kill the loop
      await sleep(delayMs * 2);
      continue;
    }

    if (result.done) {
      const msg = `[loop] "${label}" completed after ${iteration} iteration(s). Reason: ${result.reason ?? "done"}`;
      await appendProgress(sessionId, trackId, msg);
      emitRuntimeEvent({
        scope,
        kind: "session_completed",
        severity: "success",
        trackId: scope === "track" ? trackId : undefined,
        title: `${label} completed`,
        detail: result.reason ?? "done",
      });
      console.log(msg);
      return;
    }

    await sleep(delayMs);
  }

  const msg = `[loop] "${label}" hit maxIterations (${maxIterations}). Stopping.`;
  await appendProgress(sessionId, trackId, msg);
  emitRuntimeEvent({
    scope,
    kind: "error",
    severity: "error",
    trackId: scope === "track" ? trackId : undefined,
    title: `${label} stopped after hitting max iterations`,
    detail: `maxIterations=${maxIterations}`,
  });
  console.warn(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
