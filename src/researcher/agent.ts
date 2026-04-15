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
  readSubagentState,
  writeSubagentState,
  updateSubagentStatus,
  appendProgress,
  readProgress,
  sessionPaths,
} from "../loop/state.js";
import { BoxerClient } from "../sandbox/boxer.js";
import { runRalphLoop, type LoopIteration } from "../loop/runner.js";
import type { Brief } from "../types/index.js";
import type { RunModelConfig } from "../types/provider.js";
import { emitSessionEvent } from "../ipc/bus.js";
import { updateSubagentInDb, upsertSubagent } from "../db/sessions.js";

const SYSTEM_PROMPT_TEMPLATE = (stateDir: string, subagentId: string, sandbox: boolean) =>
  `You are a Subagent in an autonomous security research system.

You own one specific vulnerability hypothesis. Each time you run, read your state files and continue exactly where you left off.

## Tools available
- Bash — run shell commands${sandbox ? " inside an isolated Boxer (gVisor) sandbox. No host filesystem access. Network defaults to \"none\"; pass network:\"sandbox\" for outbound access." : " directly on the local machine."}
- Read / Write / Edit — manage state and output files on the host filesystem
- Grep / Glob — search codebases on the host filesystem
- WebFetch / WebSearch — research CVEs, techniques, documentation

## Your loop
1. Read ${stateDir}/subagents/${subagentId}/hypothesis.md and ${stateDir}/subagents/${subagentId}/progress.md to understand current state.
2. Plan the next investigation step.
3. Execute it (use Bash/Grep/Read/WebFetch etc).
4. Append findings to ${stateDir}/subagents/${subagentId}/progress.md after EVERY significant action.
5. When conclusion reached:

   Found vulnerability → write full details to ${stateDir}/subagents/${subagentId}/findings.md, create output/ with:
     - README.md (setup + step-by-step reproduction)
     - setup.sh (environment setup)
     - exploit.ts (TypeScript PoC — mark [UNTESTED] if not run)
   Then end response with: STATUS:found

   Hypothesis disproven → write evidence to ${stateDir}/subagents/${subagentId}/findings.md, end with: STATUS:disproven

   Blocked → write blocker to ${stateDir}/subagents/${subagentId}/progress.md, end with: STATUS:blocked:<reason>

Never end a turn without appending to ${stateDir}/subagents/${subagentId}/progress.md.`;

export interface ResearcherOpts {
  /** Override the inter-iteration delay in ms (default 2000). Useful in tests. */
  delayMs?: number;
}

export async function runResearcher(
  sessionId: string,
  subagentId: string,
  brief: Brief,
  boxer: BoxerClient | null,
  modelConfig: RunModelConfig,
  opts: ResearcherOpts = {},
): Promise<void> {
  const paths = sessionPaths(sessionId);

  emitSessionEvent(sessionId, {
    scope: "subagent",
    kind: "stage_changed",
    severity: "info",
    subagentId,
    title: `Subagent ${subagentId} starting`,
    detail: "Preparing workspace and reading subagent state",
    stage: "Preparing Subagent",
  });
  // Pre-create a Boxer workspace for this subagent so the agent has a persistent filesystem.
  // Skipped when sandbox is disabled — commands run on the local machine instead.
  let workspaceId: string | undefined;
  if (modelConfig.sandbox && boxer) {
    try {
      const ws = await boxer.createWorkspace(`subagent-${subagentId}`, "ubuntu:22.04");
      workspaceId = ws.workspaceId;
      const state = await readSubagentState(sessionId, subagentId);
      if (state) await writeSubagentState(sessionId, { ...state, workspaceId });
      await updateSubagentInDb(subagentId, { workspaceId });
      emitSessionEvent(sessionId, {
        scope: "subagent",
        kind: "stage_changed",
        severity: "info",
        subagentId,
        title: "Workspace ready",
        detail: workspaceId,
        stage: "Reading Hypothesis",
      });
    } catch {
      console.warn(`[researcher:${subagentId}] Boxer workspace creation failed — continuing without`);
      emitSessionEvent(sessionId, {
        scope: "subagent",
        kind: "error",
        severity: "warning",
        subagentId,
        title: "Workspace creation failed",
        detail: "Continuing without persistent Boxer workspace",
        stage: "Reading Hypothesis",
      });
    }
  }

  let currentIteration = 1;

  await runRalphLoop(
    async (abortController): Promise<LoopIteration> => {
      const state = await readSubagentState(sessionId, subagentId);
      if (!state) throw new Error(`Subagent ${subagentId} has no state`);
      if (state.status === "found" || state.status === "disproven" || state.status === "blocked") {
        return { done: true, reason: state.status };
      }

      emitSessionEvent(sessionId, {
        scope: "subagent",
        kind: "stage_changed",
        severity: "info",
        subagentId,
        title: "Reading hypothesis and prior progress",
        detail: state.hypothesis,
        stage: "Reading Hypothesis",
      });

      const hypothesis = await readFile(paths.hypothesisMd(subagentId), "utf-8");
      const progress = await readProgress(sessionId, subagentId);
      const findings = existsSync(paths.findingsMd(subagentId))
        ? await readFile(paths.findingsMd(subagentId), "utf-8")
        : "";

      emitSessionEvent(sessionId, {
        scope: "subagent",
        kind: "stage_changed",
        severity: "info",
        subagentId,
        title: "Planning next investigation step",
        detail: hypothesis.split("\n")[0] ?? state.hypothesis,
        stage: "Planning Next Step",
      });
      const result = await runAgent({
        modelConfig,
        systemPrompt: SYSTEM_PROMPT_TEMPLATE(paths.stateDir(), subagentId, modelConfig.sandbox),
        prompt: buildPrompt({
          sessionId,
          subagentId,
          brief,
          hypothesis,
          progress,
          findings,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
        }),
        cwd: process.cwd(),
        sessionId,
        subagentId,
        iteration: currentIteration,
        allowedTools: ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch"],
        sandbox: modelConfig.sandbox,
        ...(modelConfig.sandbox && boxer ? { boxerUrl: boxer.baseUrl } : {}),
        ...(workspaceId !== undefined ? { workspaceId } : {}),
        abortController,
      });

      const response = result.result;

      if (response.includes("STATUS:found")) {
        await updateSubagentStatus(sessionId, subagentId, "found");
        await updateSubagentInDb(subagentId, { status: "found" });
        await appendProgress(sessionId, subagentId, "[runner] Status → found");
        emitSessionEvent(sessionId, {
          scope: "subagent",
          kind: "subagent_status_changed",
          severity: "success",
          subagentId,
          title: "Subagent concluded with a finding",
          detail: "Vulnerability evidence captured",
          stage: "Done",
          status: "found",
        });
        return { done: true, reason: "found" };
      }
      if (response.includes("STATUS:disproven")) {
        await updateSubagentStatus(sessionId, subagentId, "disproven");
        await updateSubagentInDb(subagentId, { status: "disproven" });
        await appendProgress(sessionId, subagentId, "[runner] Status → disproven");
        emitSessionEvent(sessionId, {
          scope: "subagent",
          kind: "subagent_status_changed",
          severity: "info",
          subagentId,
          title: "Subagent disproven",
          detail: "Hypothesis did not hold under investigation",
          stage: "Done",
          status: "disproven",
        });
        return { done: true, reason: "disproven" };
      }
      const blocked = response.match(/STATUS:blocked:(.+)/);
      if (blocked) {
        await updateSubagentStatus(sessionId, subagentId, "blocked");
        await updateSubagentInDb(subagentId, {
          status: "blocked",
          blockedReason: blocked[1]?.trim() ?? "blocked",
        });
        await appendProgress(sessionId, subagentId, `[runner] Status → blocked: ${blocked[1] ?? ""}`);
        emitSessionEvent(sessionId, {
          scope: "subagent",
          kind: "subagent_status_changed",
          severity: "warning",
          subagentId,
          title: "Subagent blocked",
          detail: blocked[1]?.trim() || "Blocked by runtime condition",
          stage: "Blocked",
          status: "blocked",
        });
        return { done: true, reason: "blocked" };
      }

      emitSessionEvent(sessionId, {
        scope: "subagent",
        kind: "retrying",
        severity: "info",
        subagentId,
        title: "Subagent continues",
        detail: "The subagent will continue automatically",
        stage: "Research In Progress",
      });

      await upsertSubagent({
        id: subagentId,
        sessionId,
        hypothesis: state.hypothesis,
        status: state.status,
        ...(workspaceId !== undefined ? { workspaceId } : {}),
      });
      return { done: false };
    },
    {
      sessionId,
      subagentId,
      label: `Subagent:${subagentId}`,
      ...(opts.delayMs !== undefined ? { delayMs: opts.delayMs } : {}),
      scope: "subagent",
    },
  );
}

interface PromptArgs {
  sessionId: string;
  subagentId: string;
  brief: Brief;
  hypothesis: string;
  progress: string;
  findings: string;
  workspaceId?: string;
}

function buildPrompt(args: PromptArgs): string {
  return `## Your Research Subagent
Subagent ID: ${args.subagentId}

Brief:
${JSON.stringify(args.brief, null, 2)}

Hypothesis:
${args.hypothesis}

Progress log:
${args.progress || "(none)"}

Current findings:
${args.findings || "(none)"}

${args.workspaceId ? `Workspace ID: ${args.workspaceId}` : ""}

Continue investigating. Use the allowed tools as needed.`;
}
