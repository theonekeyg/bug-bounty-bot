import { z } from "zod";
import { SubagentStatusSchema } from "./state.js";

export const RuntimeEventScopeSchema = z.enum(["session", "subagent"]);
export type RuntimeEventScope = z.infer<typeof RuntimeEventScopeSchema>;

export const RuntimeEventSeveritySchema = z.enum(["info", "success", "warning", "error"]);
export type RuntimeEventSeverity = z.infer<typeof RuntimeEventSeveritySchema>;

export const RuntimeEventKindSchema = z.enum([
  "session_started",
  "stage_changed",
  "heartbeat",
  "subagent_created",
  "subagent_status_changed",
  "waiting",
  "retrying",
  "permission_required",
  "error",
  "session_completed",
]);
export type RuntimeEventKind = z.infer<typeof RuntimeEventKindSchema>;

export const RuntimeEventSchema = z.object({
  id: z.string(),
  timestamp: z.string().datetime(),
  scope: RuntimeEventScopeSchema,
  kind: RuntimeEventKindSchema,
  severity: RuntimeEventSeveritySchema,
  title: z.string(),
  detail: z.string().optional(),
  stage: z.string().optional(),
  subagentId: z.string().optional(),
  status: SubagentStatusSchema.optional(),
});
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

export type RuntimeEventInput = Omit<RuntimeEvent, "id" | "timestamp">;
