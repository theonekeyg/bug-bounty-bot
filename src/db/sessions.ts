/**
 * Session, Track, and EventRecord CRUD operations.
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
  createdAt: string;
  completedAt: string | null;
  trackCount: number;
}

// ── Session ───────────────────────────────────────────────────────────────────

export async function createSession(input: {
  target: string;
  briefPath: string;
  briefContent: string;
  model: string;
  boxerUrl: string;
}): Promise<string> {
  const db = getDb();
  const session = await db.session.create({
    data: {
      target: input.target,
      briefPath: input.briefPath,
      briefContent: input.briefContent,
      model: input.model,
      boxerUrl: input.boxerUrl,
      status: "running",
    },
  });
  return session.id;
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
    include: { _count: { select: { tracks: true } } },
  });
  return sessions.map((s) => ({
    id: s.id,
    target: s.target,
    status: s.status as SessionInfo["status"],
    model: s.model,
    briefPath: s.briefPath,
    briefContent: s.briefContent,
    boxerUrl: s.boxerUrl,
    createdAt: s.createdAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    trackCount: s._count.tracks,
  }));
}

export async function getSession(id: string): Promise<SessionInfo | null> {
  const db = getDb();
  const s = await db.session.findUnique({
    where: { id },
    include: { _count: { select: { tracks: true } } },
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
    createdAt: s.createdAt.toISOString(),
    completedAt: s.completedAt?.toISOString() ?? null,
    trackCount: s._count.tracks,
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

// ── Track ─────────────────────────────────────────────────────────────────────

export async function upsertTrack(input: {
  id: string;
  sessionId: string;
  hypothesis: string;
  status?: string;
  workspaceId?: string;
}): Promise<void> {
  const db = getDb();
  await db.track.upsert({
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

export async function updateTrackInDb(
  id: string,
  patch: { status?: string; workspaceId?: string; blockedReason?: string },
): Promise<void> {
  const db = getDb();
  await db.track.update({ where: { id }, data: patch });
}

export async function getSessionTracks(sessionId: string) {
  return getDb().track.findMany({ where: { sessionId } });
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
      trackId: event.trackId ?? null,
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
    trackId: r.trackId ?? undefined,
    kind: r.kind,
    severity: r.severity,
    title: r.title,
    detail: r.detail ?? undefined,
    stage: r.stage ?? undefined,
    status: r.status ?? undefined,
    createdAt: r.createdAt.toISOString(),
  }));
}
