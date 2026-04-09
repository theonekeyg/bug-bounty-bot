/**
 * State read/write utilities.
 * All state is scoped to a session — pass sessionId to every function.
 * Never use raw fs calls in agents — use these helpers to keep state consistent.
 */

import { readFile, writeFile, mkdir, appendFile, rm } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { z } from "zod";
import { TrackStateSchema, type TrackState, type TrackStatus } from "../types/index.js";

const SESSIONS_DIR = join("state", "sessions");
const OUTPUT_BASE = join("output", "sessions");

// ── Session-scoped paths ──────────────────────────────────────────────────────

export function sessionPaths(sessionId: string) {
  const base = join(SESSIONS_DIR, sessionId);
  const out = join(OUTPUT_BASE, sessionId);
  return {
    stateDir: () => base,
    outputDir: () => out,
    planMd: () => join(base, "plan.md"),
    commandLog: () => join(base, "command_log.jsonl"),
    trackDir: (trackId: string) => join(base, "research", trackId),
    statusJson: (trackId: string) => join(base, "research", trackId, "status.json"),
    hypothesisMd: (trackId: string) => join(base, "research", trackId, "hypothesis.md"),
    progressMd: (trackId: string) => join(base, "research", trackId, "progress.md"),
    findingsMd: (trackId: string) => join(base, "research", trackId, "findings.md"),
    pendingInstall: (trackId: string) => join(base, "research", trackId, "pending_install.json"),
    reportMd: () => join(out, "report.md"),
    reproDir: (vulnId: string) => join(out, "repro", vulnId),
  };
}

// ── Track state ───────────────────────────────────────────────────────────────

export async function readTrackState(sessionId: string, trackId: string): Promise<TrackState | null> {
  const p = sessionPaths(sessionId).statusJson(trackId);
  if (!existsSync(p)) return null;
  const raw = await readFile(p, "utf-8");
  return TrackStateSchema.parse(JSON.parse(raw));
}

export async function writeTrackState(sessionId: string, state: TrackState): Promise<void> {
  const p = sessionPaths(sessionId).statusJson(state.trackId);
  await mkdir(dirname(p), { recursive: true });
  const updated: TrackState = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(p, JSON.stringify(updated, null, 2), "utf-8");
}

export async function updateTrackStatus(
  sessionId: string,
  trackId: string,
  status: TrackStatus,
): Promise<void> {
  const current = await readTrackState(sessionId, trackId);
  if (!current) throw new Error(`Track ${trackId} not found in session ${sessionId}`);
  await writeTrackState(sessionId, { ...current, status });
}

// ── Plan ──────────────────────────────────────────────────────────────────────

export async function readPlan(sessionId: string): Promise<string | null> {
  const p = sessionPaths(sessionId).planMd();
  if (!existsSync(p)) return null;
  return readFile(p, "utf-8");
}

export async function writePlan(sessionId: string, content: string): Promise<void> {
  const p = sessionPaths(sessionId).planMd();
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content, "utf-8");
}

// ── Progress log (append-only) ────────────────────────────────────────────────

export async function appendProgress(sessionId: string, trackId: string, entry: string): Promise<void> {
  const p = sessionPaths(sessionId).progressMd(trackId);
  await mkdir(dirname(p), { recursive: true });
  const line = `\n---\n**${new Date().toISOString()}**\n${entry}\n`;
  await appendFile(p, line, "utf-8");
}

export async function readProgress(sessionId: string, trackId: string): Promise<string> {
  const p = sessionPaths(sessionId).progressMd(trackId);
  if (!existsSync(p)) return "";
  return readFile(p, "utf-8");
}

// ── All tracks ────────────────────────────────────────────────────────────────

export async function readAllTrackStates(sessionId: string): Promise<TrackState[]> {
  const researchDir = join(SESSIONS_DIR, sessionId, "research");
  if (!existsSync(researchDir)) return [];

  const { readdir } = await import("fs/promises");
  const dirs = await readdir(researchDir, { withFileTypes: true });
  const states: TrackState[] = [];

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const state = await readTrackState(sessionId, d.name);
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

export async function initStateDir(sessionId: string): Promise<void> {
  const p = sessionPaths(sessionId);
  await mkdir(join(p.stateDir(), "research"), { recursive: true });
  await mkdir(p.outputDir(), { recursive: true });
}

export async function resetSessionState(sessionId: string): Promise<void> {
  await rm(sessionPaths(sessionId).stateDir(), { recursive: true, force: true });
  await initStateDir(sessionId);
}

// ── Zod passthrough for status.json ──────────────────────────────────────────
const _guard: z.ZodType<TrackState> = TrackStateSchema;
void _guard;
