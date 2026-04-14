/**
 * Reporter agent.
 * Triggered when all research tracks are terminal.
 * Reads all state/sessions/<id>/research/ directories and produces output/sessions/<id>/report.md.
 */

import { readFile, mkdir, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { runAgent } from "../sdk/client.js";
import { readAllTrackStates, sessionPaths } from "../loop/state.js";
import { BoxerClient } from "../sandbox/boxer.js";
import type { TrackState } from "../types/state.js";
import type { RunModelConfig } from "../types/provider.js";
import { emitSessionEvent } from "../ipc/bus.js";

const SYSTEM_PROMPT = `You are the Reporter in an autonomous security research system.

All research tracks have completed. Synthesise a final vulnerability report.

Use the Write tool to create the report at the path specified in the prompt. Structure:

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

export async function runReporter(
  sessionId: string,
  boxer: BoxerClient | null,
  modelConfig: RunModelConfig,
): Promise<void> {
  void boxer; // reserved for future tool use
  const paths = sessionPaths(sessionId);
  await mkdir(paths.outputDir(), { recursive: true });
  const states = await readAllTrackStates(sessionId);
  emitSessionEvent(sessionId, {
    scope: "session",
    kind: "stage_changed",
    severity: "info",
    title: "Generating final report",
    detail: `${states.length} completed track(s) will be synthesised`,
    stage: "Generating Report",
  });

  const result = await runAgent({
    modelConfig,
    systemPrompt: SYSTEM_PROMPT,
    prompt: await buildPrompt(sessionId, states),
    cwd: process.cwd(),
    allowedTools: ["Write", "Read"],
  });

  // Fallback: write the raw response if the agent didn't use the Write tool
  if (!existsSync(paths.reportMd()) && result.result) {
    await writeFile(paths.reportMd(), result.result, "utf-8");
  }
}

async function buildPrompt(sessionId: string, states: TrackState[]): Promise<string> {
  const paths = sessionPaths(sessionId);
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

  return `All tracks complete. Write the report to: ${paths.reportMd()}\n\n## Results\n${summaries.join("\n\n---\n\n")}\n\nEnd with: REPORT_COMPLETE`;
}
