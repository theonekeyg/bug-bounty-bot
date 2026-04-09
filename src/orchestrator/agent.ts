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
  await appendProgress(
    "orchestrator",
    `[run] Requested model: ${modelConfig.model} (${modelInfo.label}) via ${provider}`,
  );
  const raw = await readFile(briefPath, "utf-8");
  const brief = parseBrief(raw);
  let tracksCreated = false;

  await runRalphLoop(
    async (): Promise<LoopIteration> => {
      if (tracksCreated) {
        const states = await readAllTrackStates();
        if (allTracksTerminal(states)) {
          await runReporter(boxer, modelConfig);
          return { done: true, reason: "all tracks terminal, report generated" };
        }
        return { done: false };
      }

      const result = await runAgent({
        modelConfig,
        systemPrompt: SYSTEM_PROMPT,
        prompt: buildPrompt(brief, raw),
        cwd: process.cwd(),
        trackId: "orchestrator",
      });

      if (result.result.includes("ORCHESTRATION_DONE")) {
        tracksCreated = true;
        const states = await readAllTrackStates();
        // Spawn researchers concurrently — each runs its own loop
        for (const state of states) {
          runResearcher(state.trackId, brief, boxer, modelConfig).catch((err: unknown) =>
            console.error(`Researcher ${state.trackId} crashed:`, err),
          );
        }
      }

      return { done: false };
    },
    { trackId: "orchestrator", label: "Orchestrator", maxIterations: 100, delayMs: 5000 },
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
