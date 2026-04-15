import { z } from "zod";

export const SubagentStatusSchema = z.enum([
  "running",
  "found",
  "disproven",
  "blocked",
  "awaiting_permission",
]);

export type SubagentStatus = z.infer<typeof SubagentStatusSchema>;

export const SubagentStateSchema = z.object({
  subagentId: z.string(),
  status: SubagentStatusSchema,
  hypothesis: z.string(),
  workspaceId: z.string().optional(), // Boxer workspace ID
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type SubagentState = z.infer<typeof SubagentStateSchema>;

export const PendingInstallSchema = z.object({
  subagentId: z.string(),
  packages: z.array(z.string()),
  justification: z.string(),
  installType: z.enum(["npm", "system", "pip", "custom"]),
  command: z.string(), // exact command to run on approval
});

export type PendingInstall = z.infer<typeof PendingInstallSchema>;

export const CommandLogEntrySchema = z.object({
  timestamp: z.string().datetime(),
  subagentId: z.string(),
  cwd: z.string(),
  command: z.string(),
  exitCode: z.number().nullable(),
  sandboxed: z.boolean(),
});

export type CommandLogEntry = z.infer<typeof CommandLogEntrySchema>;
