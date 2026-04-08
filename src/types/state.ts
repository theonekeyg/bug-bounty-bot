import { z } from "zod";

export const TrackStatusSchema = z.enum([
  "running",
  "found",
  "disproven",
  "blocked",
  "awaiting_permission",
]);

export type TrackStatus = z.infer<typeof TrackStatusSchema>;

export const TrackStateSchema = z.object({
  trackId: z.string(),
  status: TrackStatusSchema,
  hypothesis: z.string(),
  workspaceId: z.string().optional(), // Boxer workspace ID
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type TrackState = z.infer<typeof TrackStateSchema>;

export const PendingInstallSchema = z.object({
  trackId: z.string(),
  packages: z.array(z.string()),
  justification: z.string(),
  installType: z.enum(["npm", "system", "pip", "custom"]),
  command: z.string(), // exact command to run on approval
});

export type PendingInstall = z.infer<typeof PendingInstallSchema>;

export const CommandLogEntrySchema = z.object({
  timestamp: z.string().datetime(),
  trackId: z.string(),
  cwd: z.string(),
  command: z.string(),
  exitCode: z.number().nullable(),
  sandboxed: z.boolean(),
});

export type CommandLogEntry = z.infer<typeof CommandLogEntrySchema>;
