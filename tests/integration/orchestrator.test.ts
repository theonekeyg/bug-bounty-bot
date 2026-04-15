/**
 * Orchestrator agent integration tests.
 *
 * Uses delayMs:0 so the monitoring loop doesn't stall tests.
 * The model writes terminal-status tracks so the loop exits via the reporter path.
 * Only model output is mocked — DB, state files, tool execution are all real.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtemp } from "fs/promises";
import { setupTestEnv, type TestEnv } from "./helpers/test-env.js";
import { toolCallResponse, textResponse } from "./helpers/model-mock.js";
import { runOrchestrator } from "../../src/orchestrator/agent.js";
import { sessionPaths, readPlan } from "../../src/loop/state.js";
import { getDb } from "../../src/db/client.js";

let env: TestEnv;
let briefPath: string;
let briefDir: string;

/** Write terminal status.json so the monitoring loop can exit immediately. */
function terminalStatus(sessionId: string, trackId: string) {
  const now = new Date().toISOString();
  return JSON.stringify({
    trackId,
    sessionId,
    status: "disproven",
    hypothesis: "test hypothesis",
    startedAt: now,
    updatedAt: now,
  });
}

/** Reporter text response — short enough to not need tool calls. */
const reporterDone = textResponse("# Report\nNo findings.\n\nREPORT_COMPLETE");

beforeEach(async () => {
  env = await setupTestEnv();

  briefDir = await mkdtemp(join(tmpdir(), "bug-bounty-brief-"));
  briefPath = join(briefDir, "brief.md");
  await writeFile(
    briefPath,
    ["TARGET: test-app", "SCOPE: all endpoints", "GOAL: find auth bypass"].join("\n"),
    "utf-8",
  );
});

afterEach(async () => {
  await rm(briefDir, { recursive: true, force: true });
  await env.cleanup();
});

// ── Attack surface mapping ─────────────────────────────────────────────────────

describe("attack surface mapping", () => {
  it("writes plan.md via Write tool call", async () => {
    const paths = sessionPaths(env.sessionId);

    env.modelMock.enqueue(
      // Orchestration turn: write plan + one terminal track
      toolCallResponse([
        { name: "Write", args: { file_path: paths.planMd(), content: "# Plan\n- Track A: SQL injection\n- Track B: XSS" } },
        { name: "Write", args: { file_path: paths.hypothesisMd("track-a"), content: "# H\nSQLi" } },
        { name: "Write", args: { file_path: paths.statusJson("track-a"), content: terminalStatus(env.sessionId, "track-a") } },
      ]),
      textResponse("ORCHESTRATION_DONE"),
      // Reporter turn (triggered once monitoring loop sees all tracks terminal)
      reporterDone,
    );

    await runOrchestrator(briefPath, null, env.modelConfig, { sessionId: env.sessionId, delayMs: 0 });

    const plan = await readPlan(env.sessionId);
    expect(plan).toContain("SQL injection");
    expect(plan).toContain("Track B");
  });

  it("creates hypothesis and status files for each track", async () => {
    const paths = sessionPaths(env.sessionId);

    env.modelMock.enqueue(
      toolCallResponse([
        { name: "Write", args: { file_path: paths.planMd(), content: "# Plan" } },
        { name: "Write", args: { file_path: paths.hypothesisMd("track-1"), content: "# H\nSQLi" } },
        { name: "Write", args: { file_path: paths.statusJson("track-1"), content: terminalStatus(env.sessionId, "track-1") } },
        { name: "Write", args: { file_path: paths.hypothesisMd("track-2"), content: "# H\nXSS" } },
        { name: "Write", args: { file_path: paths.statusJson("track-2"), content: terminalStatus(env.sessionId, "track-2") } },
      ]),
      textResponse("ORCHESTRATION_DONE"),
      reporterDone,
    );

    await runOrchestrator(briefPath, null, env.modelConfig, { sessionId: env.sessionId, delayMs: 0 });

    expect(existsSync(paths.hypothesisMd("track-1"))).toBe(true);
    expect(existsSync(paths.hypothesisMd("track-2"))).toBe(true);
    expect(existsSync(paths.statusJson("track-1"))).toBe(true);
  });

  it("registers tracks in the DB after ORCHESTRATION_DONE", async () => {
    const paths = sessionPaths(env.sessionId);

    env.modelMock.enqueue(
      toolCallResponse([
        { name: "Write", args: { file_path: paths.planMd(), content: "# Plan" } },
        { name: "Write", args: { file_path: paths.hypothesisMd("track-db"), content: "# H\nSQLi" } },
        { name: "Write", args: { file_path: paths.statusJson("track-db"), content: terminalStatus(env.sessionId, "track-db") } },
      ]),
      textResponse("ORCHESTRATION_DONE"),
      reporterDone,
    );

    await runOrchestrator(briefPath, null, env.modelConfig, { sessionId: env.sessionId, delayMs: 0 });

    const db = getDb();
    const track = await db.track.findUnique({ where: { id: "track-db" } });
    expect(track).not.toBeNull();
    expect(track?.sessionId).toBe(env.sessionId);
  });
});

// ── Execution flow ─────────────────────────────────────────────────────────────

describe("execution flow", () => {
  it("advertises only file tools — no Bash or WebSearch — to the orchestrator", async () => {
    const paths = sessionPaths(env.sessionId);

    env.modelMock.enqueue(
      toolCallResponse([
        { name: "Write", args: { file_path: paths.planMd(), content: "# Plan" } },
        { name: "Write", args: { file_path: paths.statusJson("t1"), content: terminalStatus(env.sessionId, "t1") } },
      ]),
      textResponse("ORCHESTRATION_DONE"),
      reporterDone,
    );

    await runOrchestrator(briefPath, null, env.modelConfig, { sessionId: env.sessionId, delayMs: 0 });

    const firstCall = env.modelMock.call(0);
    const toolNames = (firstCall.tools ?? []).map(
      (t) => (t as { function?: { name?: string } }).function?.name,
    );
    expect(toolNames).toContain("Write");
    expect(toolNames).toContain("Read");
    expect(toolNames).not.toContain("Bash");
    expect(toolNames).not.toContain("WebSearch");
  });

  it("system prompt contains the session state directory path", async () => {
    const paths = sessionPaths(env.sessionId);

    env.modelMock.enqueue(
      toolCallResponse([
        { name: "Write", args: { file_path: paths.planMd(), content: "# Plan" } },
        { name: "Write", args: { file_path: paths.statusJson("t1"), content: terminalStatus(env.sessionId, "t1") } },
      ]),
      textResponse("ORCHESTRATION_DONE"),
      reporterDone,
    );

    await runOrchestrator(briefPath, null, env.modelConfig, { sessionId: env.sessionId, delayMs: 0 });

    const systemMsg = env.modelMock.call(0).messages.find((m) => m.role === "system");
    expect(String(systemMsg?.content)).toContain(env.sessionId);
  });
});
