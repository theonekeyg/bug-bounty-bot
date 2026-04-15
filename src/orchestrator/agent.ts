/**
 * Orchestrator agent.
 * Uses Claude Code natively — reads brief, maps attack surface, spawns subagents.
 */

import { readFile } from "fs/promises";
import { runAgent } from "../sdk/client.js";
import {
  appendProgress,
  readAllSubagentStates,
  allSubagentsTerminal,
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
import { createSession, updateSessionStatus, upsertSubagent } from "../db/sessions.js";

const SYSTEM_PROMPT_TEMPLATE = (stateDir: string, maxSubagents: number) => `You are the Orchestrator in an autonomous security research system.

Your job:
1. Read the user's brief and understand the target, scope, and goal.
2. Identify the attack surface — all vulnerability classes and entry points worth investigating.
3. Define subagents — one focused, falsifiable hypothesis per subagent (max ${maxSubagents}).
4. Write ${stateDir}/plan.md with the attack surface map and subagent list.
5. For each subagent, create:
   - ${stateDir}/subagents/<subagent-id>/hypothesis.md  (the hypothesis)
   - ${stateDir}/subagents/<subagent-id>/status.json    ({"status":"running","subagentId":"<id>","hypothesis":"<one-line>","startedAt":"<iso>","updatedAt":"<iso>"})

Use the Write tool for all file creation.
When all files are written, end your response with: ORCHESTRATION_DONE`;

export interface OrchestratorOpts {
  /** Resume an existing session instead of creating a new one. */
  sessionId?: string;
  /** Override the inter-iteration delay in ms (default 5000). Useful in tests. */
  delayMs?: number;
}

export async function runOrchestrator(
  briefPath: string,
  boxer: BoxerClient | null,
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
      boxerUrl: boxer?.baseUrl ?? "",
      maxSubagents: modelConfig.maxSubagents,
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

  let subagentsCreated = false;
  let currentIteration = 1;

  // If resuming and plan already exists, skip orchestration and go to research.
  const existingStates = await readAllSubagentStates(sessionId);
  if (resuming && existingStates.length > 0) {
    subagentsCreated = true;
    const nonTerminal = existingStates.filter(
      (s) => s.status !== "found" && s.status !== "disproven" && s.status !== "blocked",
    );
    emitSessionEvent(sessionId, {
      scope: "session",
      kind: "stage_changed",
      severity: "info",
      title: "Resuming research",
      detail: `${nonTerminal.length} subagent(s) need resumption, ${existingStates.length - nonTerminal.length} already terminal`,
      stage: "Launching Subagents",
    });
    for (const state of nonTerminal) {
      emitSessionEvent(sessionId, {
        scope: "subagent",
        kind: "subagent_created",
        severity: "info",
        subagentId: state.subagentId,
        title: `Subagent resumed: ${state.subagentId}`,
        detail: state.hypothesis,
        stage: "Queued",
        status: state.status,
      });
      runResearcher(sessionId, state.subagentId, brief, boxer, modelConfig).catch((err: unknown) =>
        console.error(`Researcher ${state.subagentId} crashed:`, err),
      );
    }
    emitSessionEvent(sessionId, {
      scope: "session",
      kind: "stage_changed",
      severity: "info",
      title: "Subagents re-launched",
      detail: "Investigation resumed across active subagents",
      stage: "Research In Progress",
    });
  }

  await runRalphLoop(
    async (abortController): Promise<LoopIteration> => {
      if (subagentsCreated) {
        emitSessionEvent(sessionId, {
          scope: "session",
          kind: "waiting",
          severity: "info",
          title: "Waiting for subagents",
          detail: "Monitoring subagent completion before report generation",
          stage: "Research In Progress",
        });
        const states = await readAllSubagentStates(sessionId);
        if (allSubagentsTerminal(states)) {
          emitSessionEvent(sessionId, {
            scope: "session",
            kind: "stage_changed",
            severity: "info",
            title: "All subagents are terminal",
            detail: "Starting report generation",
            stage: "Reporting",
          });
          await runReporter(sessionId, boxer, modelConfig);
          await updateSessionStatus(sessionId, "completed");
          return { done: true, reason: "all subagents terminal, report generated" };
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
        systemPrompt: SYSTEM_PROMPT_TEMPLATE(paths.stateDir(), modelConfig.maxSubagents),
        prompt: buildPrompt(brief, raw, modelConfig.maxSubagents),
        cwd: process.cwd(),
        sessionId,
        subagentId: "orchestrator",
        iteration: currentIteration,
        allowedTools: ["Write", "Read", "Edit", "Glob", "Grep"],
        persistHeartbeats: true,
        abortController,
      });

      if (result.result.includes("ORCHESTRATION_DONE")) {
        subagentsCreated = true;
        const states = await readAllSubagentStates(sessionId);
        emitSessionEvent(sessionId, {
          scope: "session",
          kind: "stage_changed",
          severity: "info",
          title: "Subagents created",
          detail: `${states.length} subagent(s) ready`,
          stage: "Launching Subagents",
        });
        // Register subagents in DB and spawn researchers concurrently
        for (const state of states) {
          await upsertSubagent({
            id: state.subagentId,
            sessionId,
            hypothesis: state.hypothesis,
            status: state.status,
            ...(state.workspaceId !== undefined ? { workspaceId: state.workspaceId } : {}),
          });
          emitSessionEvent(sessionId, {
            scope: "subagent",
            kind: "subagent_created",
            severity: "info",
            subagentId: state.subagentId,
            title: `Subagent created: ${state.subagentId}`,
            detail: state.hypothesis,
            stage: "Queued",
            status: state.status,
          });
          runResearcher(sessionId, state.subagentId, brief, boxer, modelConfig).catch((err: unknown) =>
            console.error(`Researcher ${state.subagentId} crashed:`, err),
          );
        }
        emitSessionEvent(sessionId, {
          scope: "session",
          kind: "stage_changed",
          severity: "info",
          title: "Subagents launched",
          detail: "Investigation is now running across active subagents",
          stage: "Research In Progress",
        });
        return { done: false };
      }

      return { done: false };
    },
    {
      sessionId,
      subagentId: "orchestrator",
      label: "Orchestrator",
      ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
      scope: "session",
    },
  );
}

function buildPrompt(brief: { target: string; scope: string; goal: string }, rawBrief: string, maxSubagents: number): string {
  return `You are the Orchestrator.

Brief:
${rawBrief}

Task:
Map the attack surface, define subagents (max ${maxSubagents}), write all state files, then respond with ORCHESTRATION_DONE.`;
}
