import { z } from "zod";

// ── Run request / response ────────────────────────────────────────────────────

export const NetworkModeSchema = z.enum(["none", "sandbox", "host"]);
export type NetworkMode = z.infer<typeof NetworkModeSchema>;

export const RunRequestSchema = z.object({
  image: z.string(),
  cmd: z.array(z.string()),
  workspaceId: z.string().optional(),
  network: NetworkModeSchema.default("none"),
  files: z
    .array(
      z.object({
        fileId: z.string(),
        mountPath: z.string(),
      }),
    )
    .optional(),
  limits: z
    .object({
      cpuCores: z.number().optional(),
      memoryMb: z.number().optional(),
      timeoutSecs: z.number().optional(),
      pidsLimit: z.number().optional(),
    })
    .optional(),
});

export type RunRequest = z.infer<typeof RunRequestSchema>;

export const RunResponseSchema = z.object({
  execId: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number(),
  wallTimeMs: z.number(),
});

export type RunResponse = z.infer<typeof RunResponseSchema>;

// ── Workspace ─────────────────────────────────────────────────────────────────

export const WorkspaceSchema = z.object({
  workspaceId: z.string(),
  name: z.string(),
  image: z.string(),
  createdAt: z.string(),
});

export type Workspace = z.infer<typeof WorkspaceSchema>;

export const SnapshotSchema = z.object({
  snapshotId: z.string(),
  workspaceId: z.string(),
  sizeMb: z.number(),
  createdAt: z.string(),
});

export type Snapshot = z.infer<typeof SnapshotSchema>;

// ── File upload ───────────────────────────────────────────────────────────────

export const UploadedFileSchema = z.object({
  fileId: z.string(),
  path: z.string(),
  sizeBytes: z.number(),
});

export type UploadedFile = z.infer<typeof UploadedFileSchema>;
