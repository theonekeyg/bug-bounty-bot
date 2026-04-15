/**
 * Per-test environment setup.
 *
 * - Fresh SQLite DB (temp file, prisma db push on each setup)
 * - Real state/output dirs under state/sessions/<id>/ (cleaned up on teardown)
 * - Credential resolver overridden to return a fake OpenRouter key
 *   (unique per call → forces a fresh OpenAI client, bypasses the module cache)
 * - ModelMock installed on globalThis.fetch
 * - BoxerMock server started on a free loopback port
 */

import { mkdtemp, rm, mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { randomUUID } from "crypto";
import { initDb, closeDb } from "../../../src/db/client.js";
import { setCredentialResolver, resetCredentialResolver } from "../../../src/credentials/runtime.js";
import { initStateDir, sessionPaths, writeSubagentState } from "../../../src/loop/state.js";
import { createSession, upsertSubagent } from "../../../src/db/sessions.js";
import { ModelMock } from "./model-mock.js";
import { BoxerMock } from "./boxer-mock.js";
import type { Brief } from "../../../src/types/index.js";
import type { RunModelConfig } from "../../../src/types/provider.js";

// Unique counter so each test gets a different API key → fresh OpenAI client
let _keyCounter = 0;

export interface TestEnv {
  sessionId: string;
  modelMock: ModelMock;
  boxer: BoxerMock;
  /** Default RunModelConfig wired to OpenRouter + fake key. */
  modelConfig: RunModelConfig;
  /** A simple valid Brief for use in tests. */
  brief: Brief;
  /** Helpers to prep researcher state before calling runResearcher(). */
  setupSubagent: (subagentId: string, hypothesis: string) => Promise<void>;
  /** Absolute DB file path (useful for direct Prisma queries in assertions). */
  dbPath: string;
  cleanup: () => Promise<void>;
}

export async function setupTestEnv(): Promise<TestEnv> {
  // 1. DB (temp file, fresh schema)
  const dbDir = await mkdtemp(join(tmpdir(), "bug-bounty-test-db-"));
  const dbPath = join(dbDir, "test.db");
  await initDb(dbPath);

  // 2. Session — created in DB first so agents that call updateSessionStatus don't get P2025
  const sessionId = await createSession({
    target: "test-app",
    briefPath: "test/brief.md",
    briefContent: "TARGET: test-app\nSCOPE: all\nGOAL: find vulns",
    model: "qwen/qwen-plus",
    boxerUrl: "",
    maxSubagents: 3,
  });

  // State dirs (relative to project cwd, cleaned up on teardown)
  await initStateDir(sessionId);

  // 3. Credential resolver — unique key per call forces fresh OpenAI SDK client
  const fakeKey = `test-key-${++_keyCounter}`;
  setCredentialResolver(() => ({
    provider: "openrouter",
    source: "api_key",
    secret: fakeKey,
  }));

  // 4. Model mock — installed AFTER credential resolver so the first OpenAI
  //    client construction (which happens lazily on first agent call) sees our fetch.
  const modelMock = new ModelMock();
  modelMock.install();

  // 5. Boxer mock
  const boxer = new BoxerMock();
  await boxer.start();

  const modelConfig: RunModelConfig = {
    model: "qwen/qwen-plus",
    maxSubagents: 3,
    sandbox: false,
  };

  const brief: Brief = {
    target: "test-app",
    scope: "all endpoints",
    goal: "find auth bypass",
  };

  async function setupSubagent(subagentId: string, hypothesis: string): Promise<void> {
    const paths = sessionPaths(sessionId);
    const subagentDir = paths.subagentDir(subagentId);
    await mkdir(subagentDir, { recursive: true });
    await writeFile(paths.hypothesisMd(subagentId), `# Hypothesis\n${hypothesis}`, "utf-8");
    const now = new Date().toISOString();
    await writeSubagentState(sessionId, {
      subagentId,
      status: "running",
      hypothesis,
      startedAt: now,
      updatedAt: now,
    });
    // Register in DB so updateSubagentInDb calls (status updates) don't fail with P2025
    await upsertSubagent({ id: subagentId, sessionId, hypothesis });
  }

  async function cleanup(): Promise<void> {
    modelMock.uninstall();
    boxer.stop();
    resetCredentialResolver();
    await closeDb();
    // Remove state and DB dirs
    await rm(dbDir, { recursive: true, force: true });
    const paths = sessionPaths(sessionId);
    await rm(paths.stateDir(), { recursive: true, force: true });
    await rm(paths.outputDir(), { recursive: true, force: true });
  }

  return { sessionId, modelMock, boxer, modelConfig, brief, setupSubagent, dbPath, cleanup };
}
