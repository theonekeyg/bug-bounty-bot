/**
 * Reporter agent.
 * Triggered when all research tracks are terminal.
 * Reads all state/research/ directories and produces output/report.md.
 */

import { readFile, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { runAgent } from "../sdk/client.js";
import { readAllTrackStates, paths } from "../loop/state.js";
import { BoxerClient } from "../sandbox/boxer.js";
import type { TrackState } from "../types/state.js";
import type { RunModelConfig } from "../types/provider.js";

const SYSTEM_PROMPT = `You are the Reporter in an autonomous security research system.

All research tracks have completed. Synthesise a final vulnerability report.

Write output/report.md using the Write tool. Structure:

# Security Research Report: <Target>
## Executive Summary
## Attack Surface Map
## Findings
### <VULN-ID>: <Title>
**Severity:** Critical / High / Medium / Low / Info
**CWE:** CWE-XXX
**Description:** ...
**Impact:** ...
**Reproduction:** see output/repro/<vuln-id>/
## Dead Ends
## Methodology

Be precise. No filler. End response with: REPORT_COMPLETE`;

export async function runReporter(boxer: BoxerClient, modelConfig: RunModelConfig): Promise<void> {
  void boxer; // reserved for future tool use
  await mkdir(paths.outputDir(), { recursive: true });
  const states = await readAllTrackStates();

  const result = await runAgent({
    modelConfig,
    systemPrompt: SYSTEM_PROMPT,
    prompt: await buildPrompt(states),
    cwd: process.cwd(),
  });

  // Fallback: write the raw response if the agent didn't use the Write tool
  if (!existsSync(paths.reportMd()) && result.result) {
    await writeFile(paths.reportMd(), result.result, "utf-8");
  }
}

async function buildPrompt(states: TrackState[]): Promise<string> {
  const summaries = await Promise.all(
    states.map(async (s) => {
      const hypo = existsSync(paths.hypothesisMd(s.trackId))
        ? await readFile(paths.hypothesisMd(s.trackId), "utf-8")
        : "(missing)";
      const findings = existsSync(paths.findingsMd(s.trackId))
        ? await readFile(paths.findingsMd(s.trackId), "utf-8")
        : "(none)";
      return `### ${s.trackId} [${s.status}]\n**Hypothesis:**\n${hypo}\n**Findings:**\n${findings}`;
    }),
  );

  return `All tracks complete. Write output/report.md.\n\n## Results\n${summaries.join("\n\n---\n\n")}\n\nEnd with: REPORT_COMPLETE`;
}
