import { z } from "zod";

export const ToolCallInfoSchema = z.object({
  id: z.string(),
  toolUseId: z.string(),
  toolName: z.string(),
  toolInput: z.string(),
  toolOutput: z.string(),
  outcome: z.string(),
  elapsedMs: z.number(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});
export type ToolCallInfo = z.infer<typeof ToolCallInfoSchema>;

export const AgentTurnInfoSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  trackId: z.string(),
  iteration: z.number(),
  turnIndex: z.number(),
  thinkingText: z.string(),
  textOutput: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  toolCalls: z.array(ToolCallInfoSchema),
});
export type AgentTurnInfo = z.infer<typeof AgentTurnInfoSchema>;
