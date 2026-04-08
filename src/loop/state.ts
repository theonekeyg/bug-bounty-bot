/**
 * State read/write utilities.
 * Every agent must use these — never raw fs calls — so state format stays consistent.
 */

import { readFile, writeFile, mkdir, appendFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { z } from "zod";
import { TrackStateSchema, type TrackState, type TrackStatus } from "../types/index.js";

const STATE_DIR = "state";
const OUTPUT_DIR = "output";

// ── Paths ─────────────────────────────────────────────────────────────────────

export const paths = {
  stateDir: () => STATE_DIR,
  outputDir: () => OUTPUT_DIR,
  planMd: () => join(STATE_DIR, "plan.md"),
  commandLog: () => join(STATE_DIR, "command_log.jsonl"),
  trackDir: (trackId: string) => join(STATE_DIR, "research", trackId),
  statusJson: (trackId: string) => join(STATE_DIR, "research", trackId, "status.json"),
  hypothesisMd: (trackId: string) => join(STATE_DIR, "research", trackId, "hypothesis.md"),
  progressMd: (trackId: string) => join(STATE_DIR, "research", trackId, "progress.md"),
  findingsMd: (trackId: string) => join(STATE_DIR, "research", trackId, "findings.md"),
  pendingInstall: (trackId: string) => join(STATE_DIR, "research", trackId, "pending_install.json"),
  reportMd: () => join(OUTPUT_DIR, "report.md"),
  reproDir: (vulnId: string) => join(OUTPUT_DIR, "repro", vulnId),
};

// ── Track state ───────────────────────────────────────────────────────────────

export async function readTrackState(trackId: string): Promise<TrackState | null> {
  const p = paths.statusJson(trackId);
  if (!existsSync(p)) return null;
  const raw = await readFile(p, "utf-8");
  return TrackStateSchema.parse(JSON.parse(raw));
}

export async function writeTrackState(state: TrackState): Promise<void> {
  const p = paths.statusJson(state.trackId);
  await mkdir(dirname(p), { recursive: true });
  const updated: TrackState = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(p, JSON.stringify(updated, null, 2), "utf-8");
}

export async function updateTrackStatus(trackId: string, status: TrackStatus): Promise<void> {
  const current = await readTrackState(trackId);
  if (!current) throw new Error(`Track ${trackId} not found`);
  await writeTrackState({ ...current, status });
}

// ── Plan ──────────────────────────────────────────────────────────────────────

export async function readPlan(): Promise<string | null> {
  if (!existsSync(paths.planMd())) return null;
  return readFile(paths.planMd(), "utf-8");
}

export async function writePlan(content: string): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(paths.planMd(), content, "utf-8");
}

// ── Progress log (append-only) ────────────────────────────────────────────────

export async function appendProgress(trackId: string, entry: string): Promise<void> {
  const p = paths.progressMd(trackId);
  await mkdir(dirname(p), { recursive: true });
  const line = `\n---\n**${new Date().toISOString()}**\n${entry}\n`;
  await appendFile(p, line, "utf-8");
}

export async function readProgress(trackId: string): Promise<string> {
  const p = paths.progressMd(trackId);
  if (!existsSync(p)) return "";
  return readFile(p, "utf-8");
}

// ── All tracks ────────────────────────────────────────────────────────────────

export async function readAllTrackStates(): Promise<TrackState[]> {
  const researchDir = join(STATE_DIR, "research");
  if (!existsSync(researchDir)) return [];

  const { readdir } = await import("fs/promises");
  const dirs = await readdir(researchDir, { withFileTypes: true });
  const states: TrackState[] = [];

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const state = await readTrackState(d.name);
    if (state) states.push(state);
  }

  return states;
}

export function allTracksTerminal(states: TrackState[]): boolean {
  return (
    states.length > 0 &&
    states.every((s) => s.status === "found" || s.status === "disproven" || s.status === "blocked")
  );
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initStateDir(): Promise<void> {
  await mkdir(join(STATE_DIR, "research"), { recursive: true });
  await mkdir(OUTPUT_DIR, { recursive: true });
}

// ── Zod passthrough for status.json ──────────────────────────────────────────
const _guard: z.ZodType<TrackState> = TrackStateSchema;
void _guard;
