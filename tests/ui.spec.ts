/**
 * Electron UI smoke tests using Playwright.
 * Run: bun test:ui
 */

import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtempSync } from "fs";
import { rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { initDb, closeDb, getDb } from "../src/db/client.js";
import { createSession, updateSessionStatus, upsertSubagent } from "../src/db/sessions.js";
import { initStateDir, sessionPaths, writeSubagentState } from "../src/loop/state.js";

const APP_PATH = join(import.meta.dirname, "..", "ui", "main.js");

function buildToolCall(id: string, index: number) {
  return {
    id,
    toolUseId: `tool-use-${id}`,
    toolName: "Write",
    toolInput: JSON.stringify({ file_path: `state/output-${index}.md` }),
    toolOutput: `output-${index}`,
    outcome: "ok",
    elapsedMs: index + 1,
    startedAt: new Date(2026, 0, 1, 0, 0, index).toISOString(),
    completedAt: new Date(2026, 0, 1, 0, 0, index + 1).toISOString(),
  };
}

function buildLongOutput(length: number) {
  return Array.from({ length }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
}

function buildTurn(toolCallCount: number) {
  return [{
    id: "turn-1",
    sessionId: "session-1",
    subagentId: "orchestrator",
    iteration: 1,
    turnIndex: 1,
    thinkingText: "",
    textOutput: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    startedAt: new Date(2026, 0, 1).toISOString(),
    completedAt: new Date(2026, 0, 1, 0, 1).toISOString(),
    toolCalls: Array.from({ length: toolCallCount }, (_, index) => buildToolCall(`tool-${index + 1}`, index + 1)),
  }];
}

function makeUserDataDir(): string {
  return mkdtempSync(join(tmpdir(), "bug-bounty-ui-"));
}

async function launchApp(userDataDir = makeUserDataDir()): Promise<{ app: ElectronApplication; page: Page; userDataDir: string }> {
  const app = await electron.launch({
    args: ["--no-sandbox", `--user-data-dir=${userDataDir}`, APP_PATH],
    executablePath: join(import.meta.dirname, "..", "node_modules", ".bin", "electron"),
    env: { ...process.env, ELECTRON_IS_TEST: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page, userDataDir };
}

async function seedCompletedSessionWithToolActivity(userDataDir: string): Promise<{
  sessionId: string;
  subagentId: string;
  target: string;
  progressLogText: string;
  firstToolOutput: string;
  secondToolOutput: string;
}> {
  const dbPath = join(userDataDir, "bugbounty.db");
  const sessionTarget = "seeded-ui-session";
  const subagentId = "logic-001";
  const now = new Date();
  const progressLogText = [
    "---",
    "**2026-01-01T00:00:00.000Z**",
    "Seeded debug log entry",
    "Second line of debug output",
  ].join("\n");
  const firstToolOutput = [
    "line 1",
    "\u001b[31mansi-like output\u001b[0m",
    "<trace>expanded tool output</trace>",
    buildLongOutput(6000),
  ].join("\n");
  const secondToolOutput = `secondary output\n${buildLongOutput(2500)}`;

  await initDb(dbPath);
  try {
    const sessionId = await createSession({
      target: sessionTarget,
      briefPath: "briefs/test-seeded.md",
      briefContent: "TARGET: seeded-ui-session\nSCOPE: ui\nGOAL: verify tools panel",
      model: "qwen/qwen-plus",
      boxerUrl: "",
      maxSubagents: 1,
    });

    await initStateDir(sessionId);
    await writeSubagentState(sessionId, {
      subagentId,
      status: "found",
      hypothesis: "Seeded tool output regression coverage",
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await writeFile(sessionPaths(sessionId).progressMd(subagentId), progressLogText, "utf-8");
    await upsertSubagent({
      id: subagentId,
      sessionId,
      hypothesis: "Seeded tool output regression coverage",
      status: "found",
    });

    await getDb().agentTurn.create({
      data: {
        sessionId,
        subagentId,
        iteration: 1,
        turnIndex: 1,
        thinkingText: "",
        textOutput: "",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        startedAt: now,
        completedAt: now,
        toolCalls: {
          create: [
            {
              toolUseId: `${sessionId}-tool-1`,
              toolName: "Bash",
              toolInput: JSON.stringify({ command: "printf 'seeded output'" }),
              toolOutput: firstToolOutput,
              outcome: "ok",
              elapsedMs: 123,
              startedAt: now,
              completedAt: now,
            },
            {
              toolUseId: `${sessionId}-tool-2`,
              toolName: "Read",
              toolInput: JSON.stringify({ file_path: "output/repro/seeded/report.txt" }),
              toolOutput: secondToolOutput,
              outcome: "ok",
              elapsedMs: 98,
              startedAt: now,
              completedAt: now,
            },
          ],
        },
      },
    });

    await updateSessionStatus(sessionId, "completed");
    return { sessionId, subagentId, target: sessionTarget, progressLogText, firstToolOutput, secondToolOutput };
  } finally {
    await closeDb();
  }
}

async function getProviderStatus(page: Page, provider: "openai" | "anthropic" | "openrouter") {
  return page.evaluate((selectedProvider) => window.bugBounty.getProviderStatus(selectedProvider), provider);
}

test.describe("Bug Bounty Agent UI", () => {
  let app: ElectronApplication;
  let page: Page;
  let userDataDirs: string[] = [];
  let seededSessionIds: string[] = [];

  test.beforeEach(async () => {
    const launched = await launchApp();
    app = launched.app;
    page = launched.page;
    userDataDirs.push(launched.userDataDir);
  });

  test.afterEach(async () => {
    await app.close().catch(() => undefined);
    await Promise.all(userDataDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    await Promise.all(seededSessionIds.flatMap((sessionId) => {
      const paths = sessionPaths(sessionId);
      return [
        rm(paths.stateDir(), { recursive: true, force: true }),
        rm(paths.outputDir(), { recursive: true, force: true }),
      ];
    }));
    userDataDirs = [];
    seededSessionIds = [];
  });

  test("launches without crash and shows title", async () => {
    expect(await page.title()).toBe("Bug Bounty Agent");
  });

  test("provider access is visible and the start action is locked on first launch", async () => {
    await expect(page.locator("#provider-access")).toBeVisible();
    await expect(page.locator("#provider-access-summary")).toHaveText(/\d\/3 ready/);
    await expect(page.locator("#start-btn")).toBeVisible();
    await expect(page.locator("#start-btn")).toBeDisabled();
    await expect(page.locator("#start-btn")).toHaveText("Set up Anthropic to continue");
    await expect(page.locator("#start-hint")).toContainText("Anthropic");
    await expect(page.locator("#subagent-list")).toBeHidden();
  });

  test("session-live mode hides the sessions list and keeps the runtime view active", async () => {
    await page.evaluate(() => document.body.classList.add("session-live"));
    await expect(page.locator("#sessions-view")).toBeHidden();
    await expect(page.locator("#runtime-session-card")).toBeVisible();
    await expect(page.locator("#subagent-list")).toBeVisible();
  });

  test("resume controls use compact primary buttons", async () => {
    await expect(page.locator("#new-session-btn")).toHaveClass(/btn-compact/);
    await expect(page.locator("#resume-session-btn")).toHaveClass(/btn-compact/);
  });

  test("stopped sessions render a resumable paused state", async () => {
    await page.evaluate(() => {
      const testWindow = window as unknown as {
        __bugBountyTest?: { simulateStoppedSessionUi: () => void };
      };
      if (!testWindow.__bugBountyTest) throw new Error("Missing __bugBountyTest hook");
      testWindow.__bugBountyTest.simulateStoppedSessionUi();
    });

    await expect(page.locator("#resume-session-btn")).toBeVisible();
    await expect(page.locator("#resume-session-btn")).toBeEnabled();
    await expect(page.locator("#resume-session-btn")).toHaveText("Resume");
    await expect(page.locator("#stop-session-btn")).toBeHidden();
    await expect(page.locator("#session-health-pill")).toHaveText("Stopped");
    await expect(page.locator("#session-action-state")).toHaveText("Resume available");
    await expect(page.locator("#subagents-container")).toContainText("stopped");
    await expect(page.locator("#subagents-container")).toContainText("Research session stopped");
  });

  test("provider cards surface every provider with explicit readiness", async () => {
    const statuses = await page.evaluate(() => window.bugBounty.getProviderStatuses());
    expect(statuses).toHaveLength(3);
    expect(statuses.find((status) => status.provider === "openai")?.supportedSources).toContain("codex_auth");
    expect(statuses.find((status) => status.provider === "anthropic")?.supportedSources).toContain("claude_auth");
    await expect(page.locator("#provider-cards")).toContainText("Codex login");
    await expect(page.locator("#provider-cards")).toContainText("OpenAI");
    await expect(page.locator("#provider-cards")).toContainText("Anthropic");
    await expect(page.locator("#provider-cards")).toContainText("OpenRouter");
  });

  test("openai setup exposes codex login and API key sources", async () => {
    await page.locator("#provider-cards .provider-card").filter({ hasText: "OpenAI" }).first().click();
    await expect(page.locator("#provider-setup-provider")).toHaveText("OpenAI");
    await expect(page.locator("#provider-source-switch")).toContainText("Codex login");
    await expect(page.locator("#provider-source-switch")).toContainText("API key");
  });

  test("anthropic setup exposes both supported access sources", async () => {
    await page.locator("#provider-cards .provider-card").filter({ hasText: "Anthropic" }).first().click();
    await expect(page.locator("#provider-setup-provider")).toHaveText("Anthropic");
    await expect(page.locator("#provider-source-switch")).toContainText("Claude auth");
    await expect(page.locator("#provider-source-switch")).toContainText("API key");

    await page.locator("#provider-source-switch").getByText("API key").click();
    await expect(page.locator("#provider-secret-field")).toBeVisible();
    await expect(page.locator("#provider-secret-label")).toHaveText("API key");

    await page.locator("#provider-source-switch").getByText("Claude auth").click();
    await expect(page.locator("#provider-secret-field")).toBeHidden();
    await expect(page.locator("#provider-secret-label")).toHaveText("Claude auth");
  });

  test("model picker shows all providers and their model groups", async () => {
    await page.locator("#model-trigger").click();
    await expect(page.locator("#model-menu")).toBeVisible();
    await expect(page.locator("#model-menu").getByText("OpenAI")).toBeVisible();
    await expect(page.locator("#model-menu").getByText("Anthropic")).toBeVisible();
    await expect(page.locator("#model-menu").getByText("OpenRouter")).toBeVisible();

    await page.locator("#model-menu").getByText("OpenAI").click();
    await expect(page.locator("#model-menu").getByText("GPT-5.4 Mini")).toBeVisible();
    await expect(page.locator("#model-menu").getByText("GPT-5.3 Codex")).toBeVisible();

    await page.locator(".dropdown-back").click();
    await page.locator("#model-menu").getByText("Anthropic").click();
    await expect(page.locator("#model-menu").getByText("Claude Opus 4.6")).toBeVisible();
    await expect(page.locator("#model-menu").getByText("Claude Haiku 4.5")).toBeVisible();

    await page.locator(".dropdown-back").click();
    await page.locator("#model-menu").getByText("OpenRouter").click();
    await expect(page.locator("#model-menu").getByText("Qwen3 Plus")).toBeVisible();
    await expect(page.locator("#model-menu").getByRole("button", { name: /GLM-4 Plus/ })).toBeVisible();
  });

  test("selecting a locked model opens its provider setup without closing the picker", async () => {
    await page.locator("#model-trigger").click();
    await page.locator("#model-menu").getByText("Anthropic").click();
    await page.locator("#model-menu").getByText("Claude Sonnet 4.6").click();

    await expect(page.locator("#model-menu")).toBeVisible();
    await expect(page.locator("#provider-setup-provider")).toHaveText("Anthropic");
    await expect(page.locator("#provider-setup-state")).toHaveText("Not set");
    await expect(page.locator("#start-btn")).toHaveText("Set up Anthropic to continue");
    await expect(page.locator("#start-btn")).toBeDisabled();
  });

  test("saving anthropic Claude auth unlocks start and survives a reload", async () => {
    await expect(page.locator("#provider-setup-provider")).toHaveText("Anthropic");
    await page.locator("#provider-source-switch").getByText("Claude auth").click();
    await page.locator("#provider-save").click();

    await expect(page.locator("#provider-setup-state")).toHaveText("Ready");
    await expect(page.locator("#start-btn")).toHaveText("Start Research");
    await expect(page.locator("#start-btn")).toBeEnabled();

    const status = await getProviderStatus(page, "anthropic");
    expect(status.state).toBe("ready");
    expect(status.activeSource).toBe("claude_auth");

    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.locator("#provider-setup-provider")).toHaveText("Anthropic");
    await expect(page.locator("#provider-setup-state")).toHaveText("Ready");
    await expect(page.locator("#start-btn")).toHaveText("Start Research");
    expect((await getProviderStatus(page, "anthropic")).state).toBe("ready");
  });

  test("tools panel preserves expansion and scroll on refresh", async () => {
    const initialTurns = buildTurn(40);
    const refreshedTurns = buildTurn(41);

    await page.evaluate((turns) => {
      const testWindow = window as unknown as {
        __bugBountyTest?: { renderToolsPanel: (subagentId: string, turns: unknown[]) => void };
      };
      if (!testWindow.__bugBountyTest) throw new Error("Missing __bugBountyTest hook");
      testWindow.__bugBountyTest.renderToolsPanel("orchestrator", turns);
    }, initialTurns);

    const firstRow = page.locator("#tools-list .tools-row").first();
    await firstRow.click();
    await expect(firstRow).toHaveClass(/expanded/);

    const beforeScrollTop = await page.locator("#tools-list").evaluate((el) => {
      el.scrollTop = Math.max(0, el.scrollHeight - el.clientHeight - 120);
      return el.scrollTop;
    });
    expect(beforeScrollTop).toBeGreaterThan(0);

    await page.evaluate((turns) => {
      const testWindow = window as unknown as {
        __bugBountyTest?: { renderToolsPanel: (subagentId: string, turns: unknown[]) => void };
      };
      if (!testWindow.__bugBountyTest) throw new Error("Missing __bugBountyTest hook");
      testWindow.__bugBountyTest.renderToolsPanel("orchestrator", turns);
    }, refreshedTurns);

    const afterScrollTop = await page.locator("#tools-list").evaluate((el) => el.scrollTop);
    expect(Math.abs(afterScrollTop - beforeScrollTop)).toBeLessThan(5);
    await expect(page.locator("#tools-list .tools-row").first()).toHaveClass(/expanded/);
  });

  test("tools panel keeps full long output when several rows are expanded", async () => {
    const turns = buildTurn(3);
    const longOutput = buildLongOutput(7000);
    turns[0]!.toolCalls[0]!.toolOutput = longOutput;
    turns[0]!.toolCalls[1]!.toolOutput = `second-${longOutput}`;

    await page.evaluate((toolTurns) => {
      const testWindow = window as unknown as {
        __bugBountyTest?: { renderToolsPanel: (subagentId: string, turns: unknown[]) => void };
      };
      if (!testWindow.__bugBountyTest) throw new Error("Missing __bugBountyTest hook");
      testWindow.__bugBountyTest.renderToolsPanel("orchestrator", toolTurns);
    }, turns);

    await page.locator("#tools-list .tools-row").nth(0).click();
    await page.locator("#tools-list .tools-row").nth(1).click();

    const firstOutputText = await page.locator("#tools-list .tool-detail .tool-detail-code").nth(1).textContent();
    const secondOutputText = await page.locator("#tools-list .tool-detail .tool-detail-code").nth(3).textContent();

    expect(firstOutputText).toContain(longOutput.slice(-200));
    expect(secondOutputText).toContain(longOutput.slice(-200));
  });

  test("tools panel renders control characters and ansi-like output as text", async () => {
    const turns = buildTurn(1);
    const noisyOutput = `line 1\n\u001b[31mansi\u001b[0m\nbinary:\u0000done\n<trace>`;
    turns[0]!.toolCalls[0]!.toolOutput = noisyOutput;

    await page.evaluate((toolTurns) => {
      const testWindow = window as unknown as {
        __bugBountyTest?: { renderToolsPanel: (subagentId: string, turns: unknown[]) => void };
      };
      if (!testWindow.__bugBountyTest) throw new Error("Missing __bugBountyTest hook");
      testWindow.__bugBountyTest.renderToolsPanel("orchestrator", toolTurns);
    }, turns);

    await page.locator("#tools-list .tools-row").first().click();

    const outputText = await page.locator("#tools-list .tool-detail .tool-detail-code").nth(1).textContent();
    expect(outputText).toContain("line 1");
    expect(outputText).toContain("ansi");
    expect(outputText).toContain("binary:");
    expect(outputText).toContain("done");
    expect(outputText).toContain("<trace>");
  });

  test("real session flow shows expanded tool output in tools tab", async () => {
    await app.close();

    const seededUserDataDir = makeUserDataDir();
    userDataDirs.push(seededUserDataDir);
    const seeded = await seedCompletedSessionWithToolActivity(seededUserDataDir);
    seededSessionIds.push(seeded.sessionId);

    const relaunched = await launchApp(seededUserDataDir);
    app = relaunched.app;
    page = relaunched.page;

    await expect(page.locator("#sessions-view")).toBeVisible();
    await page.locator("#sessions-list .dashboard-card").filter({ hasText: seeded.target }).getByRole("button", { name: "View" }).click();

    await expect(page.locator("#progress-view")).toBeVisible();
    await page.locator("#sidebar-subagent-list .sidebar-subagent-item").filter({ hasText: "Logic 001" }).click();
    await page.locator("#tools-tab").click();

    const toolRows = page.locator("#tools-list .tools-row");
    await expect(toolRows).toHaveCount(2);

    await toolRows.nth(0).click();
    await toolRows.nth(1).click();

    const outputBlocks = page.locator("#tools-list .tool-detail .tool-detail-code");
    await expect(outputBlocks.nth(1)).toBeVisible();
    await expect(outputBlocks.nth(1)).toContainText("ansi-like output");
    await expect(outputBlocks.nth(1)).toContainText("<trace>expanded tool output</trace>");
    await expect(outputBlocks.nth(1)).toContainText(seeded.firstToolOutput.slice(-200));
    await expect(outputBlocks.nth(3)).toBeVisible();
    await expect(outputBlocks.nth(3)).toContainText(seeded.secondToolOutput.slice(-200));
  });

  test("debug view is available as a subview tab", async () => {
    await app.close();

    const seededUserDataDir = makeUserDataDir();
    userDataDirs.push(seededUserDataDir);
    const seeded = await seedCompletedSessionWithToolActivity(seededUserDataDir);
    seededSessionIds.push(seeded.sessionId);

    const relaunched = await launchApp(seededUserDataDir);
    app = relaunched.app;
    page = relaunched.page;

    await page.locator("#sessions-list .dashboard-card").filter({ hasText: seeded.target }).getByRole("button", { name: "View" }).click();
    await page.locator("#sidebar-subagent-list .sidebar-subagent-item").filter({ hasText: "Logic 001" }).click();

    await expect(page.locator("#debug-tab")).toBeVisible();
    await page.locator("#debug-tab").click();

    await expect(page.locator("#debug-tab")).toHaveClass(/active/);
    await expect(page.locator("#debug-panel-new")).toBeVisible();
    await expect(page.locator("#progress-log")).toContainText("Seeded debug log entry");
    await expect(page.locator("#progress-log")).toContainText("Second line of debug output");
  });

  test("debug view is not overwritten by live research-log events", async () => {
    await app.close();

    const seededUserDataDir = makeUserDataDir();
    userDataDirs.push(seededUserDataDir);
    const seeded = await seedCompletedSessionWithToolActivity(seededUserDataDir);
    seededSessionIds.push(seeded.sessionId);

    const relaunched = await launchApp(seededUserDataDir);
    app = relaunched.app;
    page = relaunched.page;

    await page.locator("#sessions-list .dashboard-card").filter({ hasText: seeded.target }).getByRole("button", { name: "View" }).click();
    await page.locator("#sidebar-subagent-list .sidebar-subagent-item").filter({ hasText: "Logic 001" }).click();
    await page.locator("#debug-tab").click();

    const progressLog = page.locator("#progress-log");
    await expect(progressLog).toContainText("Seeded debug log entry");

    await app.evaluate(({ BrowserWindow }, payload) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send("research-log", payload);
    }, {
      subagentId: seeded.subagentId,
      text: "\ntransient streamed model output\n",
    });

    await expect(progressLog).toContainText("Seeded debug log entry");
    await expect(progressLog).not.toContainText("transient streamed model output");
  });
});
