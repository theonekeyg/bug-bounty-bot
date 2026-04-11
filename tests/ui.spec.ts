/**
 * Electron UI smoke tests using Playwright.
 * Run: bun test:ui
 */

import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const APP_PATH = join(import.meta.dirname, "..", "ui", "main.js");

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const userDataDir = mkdtempSync(join(tmpdir(), "bug-bounty-ui-"));
  const app = await electron.launch({
    args: ["--no-sandbox", `--user-data-dir=${userDataDir}`, APP_PATH],
    executablePath: join(import.meta.dirname, "..", "node_modules", ".bin", "electron"),
    env: { ...process.env, ELECTRON_IS_TEST: "1" },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
}

async function getProviderStatus(page: Page, provider: "openai" | "anthropic" | "openrouter") {
  return page.evaluate((selectedProvider) => window.bugBounty.getProviderStatus(selectedProvider), provider);
}

test.describe("Bug Bounty Agent UI", () => {
  let app: ElectronApplication;
  let page: Page;

  test.beforeEach(async () => {
    ({ app, page } = await launchApp());
  });

  test.afterEach(async () => {
    await app.close();
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
    await expect(page.locator("#track-list")).toBeHidden();
  });

  test("session-live mode hides the sessions list and keeps the runtime view active", async () => {
    await page.evaluate(() => document.body.classList.add("session-live"));
    await expect(page.locator("#sessions-view")).toBeHidden();
    await expect(page.locator("#runtime-session-card")).toBeVisible();
    await expect(page.locator("#track-list")).toBeVisible();
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
});
