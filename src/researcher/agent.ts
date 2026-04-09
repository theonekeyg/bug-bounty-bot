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
  paths,
} from "../loop/state.js";
import { BoxerClient } from "../sandbox/boxer.js";
import { runRalphLoop, type LoopIteration } from "../loop/runner.js";
import type { Brief } from "../types/index.js";
import type { RunModelConfig } from "../types/provider.js";

const SYSTEM_PROMPT = `You are a Researcher in an autonomous security research system.

You own one specific vulnerability hypothesis. Each time you run, read your state files and continue exactly where you left off.

## Tools available (Claude Code native)
- Bash — run shell commands, curl Boxer API for sandboxed execution
- Read / Write / Edit — manage state and output files
- Grep / Glob — search codebases
- WebFetch / WebSearch — research CVEs, techniques, documentation

## Boxer sandbox (sandboxed execution)
Run commands in isolation via:
\`\`\`bash
curl -s -X POST http://localhost:8080/run \\
  -H 'Content-Type: application/json' \\
  -d '{"image":"ubuntu:22.04","cmd":["bash","-c","your command"],"network":"none"}'
\`\`\`
Network modes: none (default), sandbox (outbound NAT), host.
Always use "none" unless external access is necessary.

## Your loop
1. Read hypothesis.md and progress.md to understand current state.
2. Plan the next investigation step.
3. Execute it (use Bash/Grep/Read/WebFetch etc).
4. Append findings to state/research/<trackId>/progress.md after EVERY significant action.
5. When conclusion reached:

   Found vulnerability → write full details to findings.md, create output/repro/<vuln-id>/ with:
     - README.md (setup + step-by-step reproduction)
     - setup.sh (environment setup)
     - exploit.ts (TypeScript PoC — mark [UNTESTED] if not run)
   Then end response with: STATUS:found

   Hypothesis disproven → write evidence to findings.md, end with: STATUS:disproven

   Blocked → write blocker to progress.md, end with: STATUS:blocked:<reason>

Never end a turn without appending to progress.md.`;

export async function runResearcher(
  trackId: string,
  brief: Brief,
  boxer: BoxerClient,
  modelConfig: RunModelConfig,
): Promise<void> {
  // Pre-create a Boxer workspace for this track so Claude can reference it
  let workspaceId: string | undefined;
  try {
    const ws = await boxer.createWorkspace(`track-${trackId}`, "ubuntu:22.04");
    workspaceId = ws.workspaceId;
    const state = await readTrackState(trackId);
    if (state) await writeTrackState({ ...state, workspaceId });
  } catch {
    console.warn(`[researcher:${trackId}] Boxer workspace creation failed — continuing without`);
  }

  await runRalphLoop(
    async (): Promise<LoopIteration> => {
      const state = await readTrackState(trackId);
      if (!state) throw new Error(`Track ${trackId} has no state`);
      if (state.status === "found" || state.status === "disproven" || state.status === "blocked") {
        return { done: true, reason: state.status };
      }

      const hypothesis = await readFile(paths.hypothesisMd(trackId), "utf-8");
      const progress = await readProgress(trackId);
      const findings = existsSync(paths.findingsMd(trackId))
        ? await readFile(paths.findingsMd(trackId), "utf-8")
        : "";

      const result = await runAgent({
        modelConfig,
        systemPrompt: SYSTEM_PROMPT,
        prompt: buildPrompt({
          trackId,
          brief,
          hypothesis,
          progress,
          findings,
          ...(workspaceId !== undefined ? { workspaceId } : {}),
        }),
        cwd: process.cwd(),
        trackId,
      });

      const response = result.result;

      if (response.includes("STATUS:found")) {
        await updateTrackStatus(trackId, "found");
        await appendProgress(trackId, "[runner] Status → found");
        return { done: true, reason: "found" };
      }
      if (response.includes("STATUS:disproven")) {
        await updateTrackStatus(trackId, "disproven");
        await appendProgress(trackId, "[runner] Status → disproven");
        return { done: true, reason: "disproven" };
      }
      const blocked = response.match(/STATUS:blocked:(.+)/);
      if (blocked) {
        await updateTrackStatus(trackId, "blocked");
        await appendProgress(trackId, `[runner] Status → blocked: ${blocked[1] ?? ""}`);
        return { done: true, reason: `blocked: ${blocked[1] ?? ""}` };
      }

      return { done: false };
    },
    { trackId, label: `Researcher:${trackId}`, maxIterations: 50, delayMs: 2000 },
  );

  if (workspaceId) {
    try { await boxer.deleteWorkspace(workspaceId); } catch { /* non-critical */ }
  }
}

interface PromptArgs {
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
