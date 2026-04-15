/**
 * Session, Subagent, and EventRecord CRUD operations.
 */

import { getDb } from "./client.js";
import type { RuntimeEventInput } from "../ipc/bus.js";

// ── Public DTOs (serialisable over IPC) ──────────────────────────────────────

export interface SessionInfo {
  id: string;
  target: string;
  status: "running" | "completed" | "failed" | "crashed";
  model: string;
  briefPath: string;
  briefContent: string;
  boxerUrl: string;
  maxSubagents: number;
  createdAt: string;
  completedAt: string | null;
  subagentCount: number;
}

// ── Session ───────────────────────────────────────────────────────────────────

export async function createSession(input: {
  target: string;
  briefPath: string;
  briefContent: string;
  model: string;
  boxerUrl: string;
  maxSubagents: number;
}): Promise<string> {
  const db = getDb();
  const session = await db.session.create({
    data: {
      target: input.target,
      briefPath: input.briefPath,
      briefContent: input.briefContent,
      model: input.model,
      boxerUrl: input.boxerUrl,
      maxSubagents: input.maxSubagents,
      status: "running",
    },
  });
  return session.id;
}

export async function updateSessionMaxSubagents(id: string, maxSubagents: number): Promise<void> {
  const db = getDb();
  await db.session.update({ where: { id }, data: { maxSubagents } });
}

export async function updateSessionStatus(
  id: string,
  status: "running" | "completed" | "failed" | "crashed",
): Promise<void> {
  const db = getDb();
  await db.session.update({
    where: { id },
    data: {
      status,
      ...(status === "completed" || status === "failed" ? { completedAt: new Date() } : {}),
    },
  });
}

export async function listSessions(): Promise<SessionInfo[]> {
  const db = getDb();
  const sessions = await db.session.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { subagents: true } } },
  });
  return sessions.map((s) => ({
    id: s.id,
    target: s.target,
    status: s.status as SessionInfo["status"],
    model: s.model,
    briefPath: s.briefPath,
    briefContent: s.briefContent,
    boxerUrl: s.boxerUrl,
    maxSubagents: s.maxSubagents,
    createdAt: s.createdAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    subagentCount: s._count.subagents,
  }));
}

export async function getSession(id: string): Promise<SessionInfo | null> {
  const db = getDb();
  const s = await db.session.findUnique({
    where: { id },
    include: { _count: { select: { subagents: true } } },
  });
  if (!s) return null;
  return {
    id: s.id,
    target: s.target,
    status: s.status as SessionInfo["status"],
    model: s.model,
    briefPath: s.briefPath,
    briefContent: s.briefContent,
    boxerUrl: s.boxerUrl,
    maxSubagents: s.maxSubagents,
    createdAt: s.createdAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    subagentCount: s._count.subagents,
  };
}

/**
 * Mark all sessions with status "running" as "crashed".
 * Called on app startup to reflect that a previous run died unexpectedly.
 */
export async function markCrashedSessions(): Promise<void> {
  const db = getDb();
  await db.session.updateMany({
    where: { status: "running" },
    data: { status: "crashed" },
  });
}

// ── Subagent ─────────────────────────────────────────────────────────────────

export async function upsertSubagent(input: {
  id: string;
  sessionId: string;
  hypothesis: string;
  status?: string;
  workspaceId?: string;
}): Promise<void> {
  const db = getDb();
  await db.subagent.upsert({
    where: { id: input.id },
    create: {
      id: input.id,
      sessionId: input.sessionId,
      hypothesis: input.hypothesis,
      status: input.status ?? "running",
      workspaceId: input.workspaceId ?? null,
    },
    update: {
      hypothesis: input.hypothesis,
      status: input.status ?? "running",
      workspaceId: input.workspaceId ?? null,
    },
  });
}

export async function updateSubagentInDb(
  id: string,
  patch: { status?: string; workspaceId?: string; blockedReason?: string },
): Promise<void> {
  const db = getDb();
  await db.subagent.update({ where: { id }, data: patch });
}

export async function getSessionSubagents(sessionId: string) {
  return getDb().subagent.findMany({ where: { sessionId } });
}

// ── Events ────────────────────────────────────────────────────────────────────

export async function appendSessionEvent(
  sessionId: string,
  event: RuntimeEventInput,
): Promise<void> {
  const db = getDb();
  await db.eventRecord.create({
    data: {
      sessionId,
      subagentId: event.subagentId ?? null,
      kind: event.kind,
      severity: event.severity,
      title: event.title,
      detail: event.detail ?? null,
      stage: event.stage ?? null,
      status: event.status ?? null,
    },
  });
}

export async function getSessionEvents(sessionId: string) {
  const db = getDb();
  const records = await db.eventRecord.findMany({
    where: { sessionId },
    orderBy: { createdAt: "asc" },
  });
  return records.map((r) => ({
    id: r.id,
    sessionId: r.sessionId,
    subagentId: r.subagentId ?? undefined,
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    detail: r.detail ?? undefined,
    stage: r.stage ?? undefined,
    status: r.status ?? undefined,
    createdAt: r.createdAt.toISOString(),
  }));
}
