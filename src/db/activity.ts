/**
 * Agent activity DB operations — insert/query AgentTurns and ToolCalls.
 */

import { getDb } from "./client.js";
import type { AgentTurnInfo, ToolCallInfo } from "../types/activity.js";

const CAP = 32 * 1024; // 32 KB cap on stored text fields

export async function insertAgentTurn(input: {
  sessionId: string;
  trackId: string;
  iteration: number;
  turnIndex: number;
  thinkingText: string;
  textOutput: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): Promise<string> {
  const db = getDb();
  const turn = await db.agentTurn.create({
    data: {
      sessionId: input.sessionId,
      trackId: input.trackId,
      iteration: input.iteration,
      turnIndex: input.turnIndex,
      thinkingText: input.thinkingText.slice(0, CAP),
      textOutput: input.textOutput.slice(0, CAP),
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      completedAt: new Date(),
    },
  });
  return turn.id;
}

export async function insertToolCall(input: {
  turnId: string;
  toolUseId: string;
  toolName: string;
  toolInput: string;
}): Promise<string> {
  const db = getDb();
  const tc = await db.toolCall.create({
    data: {
      turnId: input.turnId,
      toolUseId: input.toolUseId,
      toolName: input.toolName,
      toolInput: input.toolInput.slice(0, CAP),
      outcome: "pending",
    },
  });
  return tc.id;
}

export async function updateToolCallResult(
  id: string,
  patch: { toolOutput: string; outcome: string; elapsedMs: number },
): Promise<void> {
  const db = getDb();
  await db.toolCall.update({
    where: { id },
    data: {
      toolOutput: patch.toolOutput.slice(0, CAP),
      outcome: patch.outcome,
      elapsedMs: patch.elapsedMs,
      completedAt: new Date(),
    },
  });
}

export async function getAgentActivity(
  sessionId: string,
  trackId: string,
): Promise<AgentTurnInfo[]> {
  const db = getDb();
  const turns = await db.agentTurn.findMany({
    where: { sessionId, trackId },
    orderBy: [{ iteration: "asc" }, { turnIndex: "asc" }],
    include: { toolCalls: { orderBy: { startedAt: "asc" } } },
  });
  return turns.map((t) => ({
    id: t.id,
    sessionId: t.sessionId,
    trackId: t.trackId,
    iteration: t.iteration,
    turnIndex: t.turnIndex,
    thinkingText: t.thinkingText,
    textOutput: t.textOutput,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheWriteTokens: t.cacheWriteTokens,
    startedAt: t.startedAt.toISOString(),
    completedAt: t.completedAt?.toISOString() ?? null,
    toolCalls: t.toolCalls.map(
      (tc): ToolCallInfo => ({
        id: tc.id,
        toolUseId: tc.toolUseId,
        toolName: tc.toolName,
        toolInput: tc.toolInput,
        toolOutput: tc.toolOutput,
        outcome: tc.outcome,
        elapsedMs: tc.elapsedMs,
        startedAt: tc.startedAt.toISOString(),
        completedAt: tc.completedAt?.toISOString() ?? null,
      }),
    ),
  }));
}
