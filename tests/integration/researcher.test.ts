/**
 * Researcher agent integration tests.
 *
 * Only the model output is mocked (ModelMock intercepts fetch to OpenRouter).
 * Everything else is real: tool execution, DB writes, state file I/O, loop runner.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { setupTestEnv, type TestEnv } from "./helpers/test-env.js";
import { toolCallResponse, textResponse } from "./helpers/model-mock.js";
import { runResearcher } from "../../src/researcher/agent.js";
import { readSubagentState, sessionPaths } from "../../src/loop/state.js";
import { getDb } from "../../src/db/client.js";

let env: TestEnv;

beforeEach(async () => {
  env = await setupTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

// ── Tool call execution ────────────────────────────────────────────────────────

describe("tool call execution", () => {
  it("executes a Write tool call and feeds the result back to the model", async () => {
    const subagentId = "subagent-write-test";
    await env.setupSubagent(subagentId, "Test if the app is vulnerable to path traversal");

    const findingsPath = sessionPaths(env.sessionId).findingsMd(subagentId);

    // Turn 1: model asks to write findings
    // Turn 2: model signals done
    env.modelMock.enqueue(
      toolCallResponse([
        {
          name: "Write",
          args: { file_path: findingsPath, content: "# Findings\nVulnerable endpoint found." },
        },
      ]),
      textResponse("STATUS:found"),
    );

    await runResearcher(env.sessionId, subagentId, env.brief, null, env.modelConfig, { delayMs: 0 });

    // Tool actually wrote the file
    expect(existsSync(findingsPath)).toBe(true);
    const content = await readFile(findingsPath, "utf-8");
    expect(content).toContain("Vulnerable endpoint found.");

    // Model was called twice: once for the tool call, once for the final response
    expect(env.modelMock.callCount).toBe(2);

    // Second call's messages include the tool result
    const secondCall = env.modelMock.call(1);
    const toolResultMsg = secondCall.messages.find((m) => m.role === "tool");
    expect(toolResultMsg).toBeDefined();
    expect(String(toolResultMsg?.content)).toContain("Wrote");
  });

  it("executes a Read tool call and returns file contents to the model", async () => {
    const subagentId = "subagent-read-test";
    await env.setupSubagent(subagentId, "Check the hypothesis file");

    const hypothesisPath = sessionPaths(env.sessionId).hypothesisMd(subagentId);

    env.modelMock.enqueue(
      toolCallResponse([{ name: "Read", args: { file_path: hypothesisPath } }]),
      textResponse("STATUS:disproven"),
    );

    await runResearcher(env.sessionId, subagentId, env.brief, null, env.modelConfig, { delayMs: 0 });

    // Second call includes the file contents as a tool result
    const secondCall = env.modelMock.call(1);
    const toolResult = secondCall.messages.find((m) => m.role === "tool");
    expect(String(toolResult?.content)).toContain("Check the hypothesis file");
  });

  it("executes multiple tool calls in a single turn", async () => {
    const subagentId = "subagent-multi-tool";
    await env.setupSubagent(subagentId, "Multi-tool test");

    const paths = sessionPaths(env.sessionId);

    env.modelMock.enqueue(
      // Single turn with two tool calls
      toolCallResponse([
        { name: "Write", args: { file_path: paths.findingsMd(subagentId), content: "Finding A" } },
        { name: "Write", args: { file_path: paths.progressMd(subagentId), content: "Progress note" } },
      ]),
      textResponse("STATUS:found"),
    );

    await runResearcher(env.sessionId, subagentId, env.brief, null, env.modelConfig, { delayMs: 0 });

    expect(await readFile(paths.findingsMd(subagentId), "utf-8")).toContain("Finding A");

    // Second call has two tool result messages
    const secondCall = env.modelMock.call(1);
    const toolResults = secondCall.messages.filter((m) => m.role === "tool");
    expect(toolResults).toHaveLength(2);
  });

  it("routes Bash through BoxerMock when sandbox is enabled", async () => {
    const subagentId = "subagent-bash-sandbox";
    await env.setupSubagent(subagentId, "Test bash sandbox routing");

    env.boxer.onRun = () => ({ stdout: "uid=0(root)", stderr: "", exitCode: 0 });

    env.modelMock.enqueue(
      toolCallResponse([{ name: "Bash", args: { command: "id" } }]),
      textResponse("STATUS:disproven"),
    );

    const sandboxConfig = { ...env.modelConfig, sandbox: true };
    const { BoxerClient } = await import("../../src/sandbox/boxer.js");
    const boxerClient = new BoxerClient(env.boxer.baseUrl);

    await runResearcher(env.sessionId, subagentId, env.brief, boxerClient, sandboxConfig, { delayMs: 0 });

    // Boxer received the run request — cmd is ["bash", "-c", "<command>"]
    expect(env.boxer.runRequests).toHaveLength(1);
    expect(env.boxer.runRequests[0]?.cmd).toEqual(["bash", "-c", "id"]);

    // Model got back the stdout
    const secondCall = env.modelMock.call(1);
    const toolResult = secondCall.messages.find((m) => m.role === "tool");
    expect(String(toolResult?.content)).toContain("uid=0(root)");
  });
});

// ── Status transitions ────────────────────────────────────────────────────────

describe("status transitions", () => {
  it("sets subagent status to 'found' on STATUS:found signal", async () => {
    const subagentId = "subagent-found";
    await env.setupSubagent(subagentId, "SQL injection hypothesis");

    env.modelMock.enqueue(textResponse("Confirmed vuln.\n\nSTATUS:found"));

    await runResearcher(env.sessionId, subagentId, env.brief, null, env.modelConfig, { delayMs: 0 });

    const state = await readSubagentState(env.sessionId, subagentId);
    expect(state?.status).toBe("found");
  });

  it("sets subagent status to 'disproven' on STATUS:disproven signal", async () => {
    const subagentId = "subagent-disproven";
    await env.setupSubagent(subagentId, "XSS hypothesis");

    env.modelMock.enqueue(textResponse("No XSS found.\n\nSTATUS:disproven"));

    await runResearcher(env.sessionId, subagentId, env.brief, null, env.modelConfig, { delayMs: 0 });

    const state = await readSubagentState(env.sessionId, subagentId);
    expect(state?.status).toBe("disproven");
  });

  it("sets subagent status to 'blocked' on STATUS:blocked signal", async () => {
    const subagentId = "subagent-blocked";
    await env.setupSubagent(subagentId, "RCE hypothesis");

    env.modelMock.enqueue(textResponse("Cannot proceed.\n\nSTATUS:blocked:need source code access"));

    await runResearcher(env.sessionId, subagentId, env.brief, null, env.modelConfig, { delayMs: 0 });

    const state = await readSubagentState(env.sessionId, subagentId);
    expect(state?.status).toBe("blocked");
  });
});

// ── DB persistence ────────────────────────────────────────────────────────────

describe("DB persistence", () => {
  it("persists AgentTurn records for each model call", async () => {
    const subagentId = "subagent-db-turns";
    await env.setupSubagent(subagentId, "DB persistence test");

    env.modelMock.enqueue(
      toolCallResponse([
        { name: "Read", args: { file_path: sessionPaths(env.sessionId).hypothesisMd(subagentId) } },
      ]),
      textResponse("STATUS:disproven"),
    );

    // env.sessionId already has a DB Session record and setupSubagent registered the subagent
    await runResearcher(env.sessionId, subagentId, env.brief, null, env.modelConfig, { delayMs: 0 });

    const db = getDb();
    const turns = await db.agentTurn.findMany({ where: { sessionId: env.sessionId, subagentId } });
    expect(turns.length).toBeGreaterThanOrEqual(2); // one per model call

    const toolCalls = await db.toolCall.findMany({
      where: { turn: { sessionId: env.sessionId, subagentId } },
    });
    expect(toolCalls.length).toBeGreaterThanOrEqual(1);
    expect(toolCalls[0]?.toolName).toBe("Read");
    expect(toolCalls[0]?.outcome).toBe("ok");
  });

  it("records elapsed time and output on tool call records", async () => {
    const subagentId = "subagent-db-elapsed";
    await env.setupSubagent(subagentId, "Elapsed time test");

    env.modelMock.enqueue(
      toolCallResponse([
        {
          name: "Write",
          args: {
            file_path: sessionPaths(env.sessionId).findingsMd(subagentId),
            content: "done",
          },
        },
      ]),
      textResponse("STATUS:found"),
    );

    await runResearcher(env.sessionId, subagentId, env.brief, null, env.modelConfig, { delayMs: 0 });

    const db = getDb();
    const [tc] = await db.toolCall.findMany({
      where: { turn: { sessionId: env.sessionId, subagentId } },
    });
    expect(tc).toBeDefined();
    expect(tc!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(tc!.toolOutput).toContain("Wrote");
  });
});
