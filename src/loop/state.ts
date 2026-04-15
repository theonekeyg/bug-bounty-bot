/**
 * State read/write utilities.
 * All state is scoped to a session — pass sessionId to every function.
 * Never use raw fs calls in agents — use these helpers to keep state consistent.
 */

import { readFile, writeFile, mkdir, appendFile, rm, rename, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import JSON5 from "json5";
import { z } from "zod";
import { SubagentStateSchema, type SubagentState, type SubagentStatus } from "../types/index.js";

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
    subagentDir: (subagentId: string) => join(base, "subagents", subagentId),
    statusJson: (subagentId: string) => join(base, "subagents", subagentId, "status.json"),
    hypothesisMd: (subagentId: string) => join(base, "subagents", subagentId, "hypothesis.md"),
    progressMd: (subagentId: string) => join(base, "subagents", subagentId, "progress.md"),
    findingsMd: (subagentId: string) => join(base, "subagents", subagentId, "findings.md"),
    pendingInstall: (subagentId: string) => join(base, "subagents", subagentId, "pending_install.json"),
    reportMd: () => join(out, "report.md"),
    reproDir: (vulnId: string) => join(out, "repro", vulnId),
  };
}

async function migrateLegacySubagentLayout(sessionId: string): Promise<void> {
  const base = sessionPaths(sessionId).stateDir();
  const oldDir = join(base, "research");
  const newDir = join(base, "subagents");

  if (!existsSync(oldDir)) return;

  if (!existsSync(newDir)) {
    await rename(oldDir, newDir);
    return;
  }

  const entries = await readdir(oldDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const from = join(oldDir, entry.name);
    const to = join(newDir, entry.name);
    if (!existsSync(to)) {
      await rename(from, to);
    }
  }

  await rm(oldDir, { recursive: true, force: true });
}

async function ensureStateLayout(sessionId: string): Promise<void> {
  await migrateLegacySubagentLayout(sessionId);
}

function parseSubagentState(raw: string): SubagentState {
  try {
    return SubagentStateSchema.parse(JSON.parse(raw));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return SubagentStateSchema.parse(JSON5.parse(raw));
  }
}

// ── Subagent state ────────────────────────────────────────────────────────────

export async function readSubagentState(sessionId: string, subagentId: string): Promise<SubagentState | null> {
  await ensureStateLayout(sessionId);
  const p = sessionPaths(sessionId).statusJson(subagentId);
  if (!existsSync(p)) return null;
  const raw = await readFile(p, "utf-8");
  return parseSubagentState(raw);
}

export async function writeSubagentState(sessionId: string, state: SubagentState): Promise<void> {
  await ensureStateLayout(sessionId);
  const p = sessionPaths(sessionId).statusJson(state.subagentId);
  await mkdir(dirname(p), { recursive: true });
  const updated: SubagentState = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(p, JSON.stringify(updated, null, 2), "utf-8");
}

export async function updateSubagentStatus(
  sessionId: string,
  subagentId: string,
  status: SubagentStatus,
): Promise<void> {
  const current = await readSubagentState(sessionId, subagentId);
  if (!current) throw new Error(`Subagent ${subagentId} not found in session ${sessionId}`);
  await writeSubagentState(sessionId, { ...current, status });
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

export async function appendProgress(sessionId: string, subagentId: string, entry: string): Promise<void> {
  await ensureStateLayout(sessionId);
  const p = sessionPaths(sessionId).progressMd(subagentId);
  await mkdir(dirname(p), { recursive: true });
  const line = `\n---\n**${new Date().toISOString()}**\n${entry}\n`;
  await appendFile(p, line, "utf-8");
}

export async function readProgress(sessionId: string, subagentId: string): Promise<string> {
  await ensureStateLayout(sessionId);
  const p = sessionPaths(sessionId).progressMd(subagentId);
  if (!existsSync(p)) return "";
  return readFile(p, "utf-8");
}

// ── All subagents ────────────────────────────────────────────────────────────

export async function readAllSubagentStates(sessionId: string): Promise<SubagentState[]> {
  await ensureStateLayout(sessionId);
  const subagentDir = join(SESSIONS_DIR, sessionId, "subagents");
  if (!existsSync(subagentDir)) return [];

  const dirs = await readdir(subagentDir, { withFileTypes: true });
  const states: SubagentState[] = [];

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const state = await readSubagentState(sessionId, d.name);
    if (state) states.push(state);
  }

  return states;
}

export function allSubagentsTerminal(states: SubagentState[]): boolean {
  return (
    states.length > 0 &&
    states.every((s) => s.status === "found" || s.status === "disproven" || s.status === "blocked")
  );
}

// ── Stop signal ───────────────────────────────────────────────────────────────

function stopSignalPath(sessionId: string): string {
  return join(SESSIONS_DIR, sessionId, "STOP");
}

export async function writeStopSignal(sessionId: string): Promise<void> {
  const p = stopSignalPath(sessionId);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, new Date().toISOString(), "utf-8");
}

export function checkStopSignal(sessionId: string): boolean {
  return existsSync(stopSignalPath(sessionId));
}

export async function clearStopSignal(sessionId: string): Promise<void> {
  const p = stopSignalPath(sessionId);
  if (existsSync(p)) await rm(p, { force: true });
}

// ── Init ──────────────────────────────────────────────────────────────────────

export async function initStateDir(sessionId: string): Promise<void> {
  await ensureStateLayout(sessionId);
  const p = sessionPaths(sessionId);
  await mkdir(join(p.stateDir(), "subagents"), { recursive: true });
  await mkdir(p.outputDir(), { recursive: true });
}

export async function resetSessionState(sessionId: string): Promise<void> {
  await rm(sessionPaths(sessionId).stateDir(), { recursive: true, force: true });
  await initStateDir(sessionId);
}

// ── Zod passthrough for status.json ──────────────────────────────────────────
const _guard: z.ZodType<SubagentState> = SubagentStateSchema;
void _guard;
