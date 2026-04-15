import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { writeFile } from "fs/promises";
import { readAllSubagentStates, readSubagentState, sessionPaths } from "../../src/loop/state.js";
import { setupTestEnv, type TestEnv } from "./helpers/test-env.js";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("state compatibility", () => {
  it("loads legacy JSON5-style subagent status files", async () => {
    const subagentId = "legacy-json5";
    await env.setupSubagent(subagentId, "Legacy single-quoted status file");

    const statusPath = sessionPaths(env.sessionId).statusJson(subagentId);
    await writeFile(
      statusPath,
      [
        "{",
        "  subagentId: 'legacy-json5',",
        "  status: 'running',",
        "  hypothesis: 'Legacy single-quoted status file',",
        "  startedAt: '2026-04-15T00:00:00.000Z',",
        "  updatedAt: '2026-04-15T00:00:00.000Z'",
        "}",
      ].join("\n"),
      "utf-8",
    );

    const state = await readSubagentState(env.sessionId, subagentId);
    const allStates = await readAllSubagentStates(env.sessionId);

    expect(state).toMatchObject({
      subagentId,
      status: "running",
      hypothesis: "Legacy single-quoted status file",
    });
    expect(allStates).toContainEqual(expect.objectContaining({ subagentId, status: "running" }));
  });
});
