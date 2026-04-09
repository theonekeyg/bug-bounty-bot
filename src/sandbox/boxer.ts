/**
 * Typed HTTP client for the Boxer REST API.
 * Wraps the REST API directly (fetch-based) until the npm package name is confirmed.
 * See: https://github.com/theonekeyg/boxer
 *      https://theonekeyg.github.io/boxer/docs/intro
 */

import { readFile } from "fs/promises";
import {
  NetworkMode,
  RunRequest,
  RunRequestSchema,
  RunResponse,
  RunResponseSchema,
  Snapshot,
  SnapshotSchema,
  UploadedFile,
  UploadedFileSchema,
  Workspace,
  WorkspaceSchema,
} from "./types.js";
import { emitRuntimeEvent } from "../ipc/bus.js";

export class BoxerClient {
  readonly baseUrl: string;

  constructor(baseUrl = "http://localhost:8080") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  // ── Core execution ──────────────────────────────────────────────────────────

  async run(request: RunRequest): Promise<RunResponse> {
    const validated = RunRequestSchema.parse(request);
    const res = await this.post("/run", validated);
    return RunResponseSchema.parse(res);
  }

  /** Convenience: run a shell command string in a workspace. */
  async runShell(
    cmd: string,
    opts: {
      workspaceId?: string;
      network?: NetworkMode;
      image?: string;
      timeoutSecs?: number;
    } = {},
  ): Promise<RunResponse> {
    return this.run({
      image: opts.image ?? "ubuntu:22.04",
      cmd: ["bash", "-c", cmd],
      ...(opts.workspaceId !== undefined ? { workspaceId: opts.workspaceId } : {}),
      network: opts.network ?? "none",
      ...(opts.timeoutSecs !== undefined ? { limits: { timeoutSecs: opts.timeoutSecs } } : {}),
    });
  }

  // ── Workspaces ──────────────────────────────────────────────────────────────

  async createWorkspace(name: string, image: string): Promise<Workspace> {
    const res = await this.post("/workspaces", { name, image });
    return WorkspaceSchema.parse(res);
  }

  async listWorkspaces(): Promise<Workspace[]> {
    const res = await this.get("/workspaces");
    return WorkspaceSchema.array().parse(res);
  }

  async deleteWorkspace(workspaceId: string): Promise<void> {
    await this.delete(`/workspaces/${workspaceId}`);
  }

  // ── Snapshots (boxer#26 — pending implementation) ───────────────────────────

  async snapshotWorkspace(workspaceId: string): Promise<Snapshot> {
    const res = await this.post(`/workspaces/${workspaceId}/snapshot`, {});
    return SnapshotSchema.parse(res);
  }

  async restoreWorkspace(snapshotId: string, name: string): Promise<Workspace> {
    const res = await this.post("/workspaces", { snapshotId, name });
    return WorkspaceSchema.parse(res);
  }

  // ── File upload ─────────────────────────────────────────────────────────────

  async uploadFile(localPath: string, remotePath: string): Promise<UploadedFile> {
    const content = await readFile(localPath);
    const form = new FormData();
    form.append("file", new Blob([content]), remotePath);
    form.append("path", remotePath);

    const res = await fetch(`${this.baseUrl}/files`, { method: "POST", body: form });
    if (!res.ok) throw new BoxerError(`Upload failed: ${res.status} ${await res.text()}`);
    return UploadedFileSchema.parse(await res.json());
  }

  async uploadContent(content: string, remotePath: string): Promise<UploadedFile> {
    const form = new FormData();
    form.append("file", new Blob([content], { type: "text/plain" }), remotePath);
    form.append("path", remotePath);

    const res = await fetch(`${this.baseUrl}/files`, { method: "POST", body: form });
    if (!res.ok) throw new BoxerError(`Upload failed: ${res.status} ${await res.text()}`);
    return UploadedFileSchema.parse(await res.json());
  }

  async downloadFile(execId: string, remotePath: string): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}/files?path=output/${execId}/${remotePath}`,
    );
    if (!res.ok) throw new BoxerError(`Download failed: ${res.status}`);
    return res.text();
  }

  // ── HTTP helpers ────────────────────────────────────────────────────────────

  private async get(path: string): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`);
    if (!res.ok) {
      if (res.status === 429 || res.status === 402) {
        const errorText = await res.text();
        emitRuntimeEvent({
          scope: "session",
          kind: "error",
          severity: "error",
          title: "API limit reached",
          detail: `Boxer API rate limit exceeded (HTTP ${res.status})`,
          stage: "API Limit",
        });
        throw new BoxerError(`API limit reached (HTTP ${res.status}): ${errorText}`);
      }
      throw new BoxerError(`GET ${path}: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      if (res.status === 429 || res.status === 402) {
        const errorText = await res.text();
        emitRuntimeEvent({
          scope: "session",
          kind: "error",
          severity: "error",
          title: "API limit reached",
          detail: `Boxer API rate limit exceeded (HTTP ${res.status})`,
          stage: "API Limit",
        });
        throw new BoxerError(`API limit reached (HTTP ${res.status}): ${errorText}`);
      }
      throw new BoxerError(`POST ${path}: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }

  private async delete(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, { method: "DELETE" });
    if (!res.ok) {
      if (res.status === 429 || res.status === 402) {
        const errorText = await res.text();
        emitRuntimeEvent({
          scope: "session",
          kind: "error",
          severity: "error",
          title: "API limit reached",
          detail: `Boxer API rate limit exceeded (HTTP ${res.status})`,
          stage: "API Limit",
        });
        throw new BoxerError(`API limit reached (HTTP ${res.status}): ${errorText}`);
      }
      throw new BoxerError(`DELETE ${path}: ${res.status} ${await res.text()}`);
    }
  }
}

export class BoxerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoxerError";
  }
}
