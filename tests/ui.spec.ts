/**
 * Electron UI smoke tests using Playwright.
 * Run: bun test:ui
 *
 * Checks that:
 * - The app launches without crashing
 * - Core layout elements are visible
 * - The permission overlay is hidden on startup
 * - The form fields are interactable
 */

import { test, expect, _electron as electron } from "@playwright/test";
import type { ElectronApplication, Page } from "@playwright/test";
import { join } from "path";

const APP_PATH = join(import.meta.dirname, "..", "ui", "main.js");

async function launchApp(): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ["--no-sandbox", APP_PATH],
    executablePath: join(import.meta.dirname, "..", "node_modules", ".bin", "electron"),
  });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  return { app, page };
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
    const title = await page.title();
    expect(title).toBe("Bug Bounty Agent");
  });

  test("sidebar form fields are visible", async () => {
    await expect(page.locator("#target")).toBeVisible();
    await expect(page.locator("#goal")).toBeVisible();
    await expect(page.locator("#scope")).toBeVisible();
    await expect(page.locator("#boxer-url")).toBeVisible();
    await expect(page.locator("#start-btn")).toBeVisible();
  });

  test("permission overlay is hidden on startup", async () => {
    const overlay = page.locator("#permission-overlay");
    await expect(overlay).toBeHidden();
  });

  test("welcome message is visible, progress view is hidden", async () => {
    await expect(page.locator("#welcome")).toBeVisible();
    await expect(page.locator("#progress-view")).toBeHidden();
  });

  test("sidebar and main panel are side by side (flex row layout)", async () => {
    const sidebar = page.locator(".sidebar");
    const main = page.locator(".main");

    const sidebarBox = await sidebar.boundingBox();
    const mainBox = await main.boundingBox();

    expect(sidebarBox).not.toBeNull();
    expect(mainBox).not.toBeNull();

    // Sidebar should be to the LEFT of main (x + width ≈ main.x)
    expect(sidebarBox!.x).toBeLessThan(mainBox!.x);
    // They should be on the same vertical level
    expect(Math.abs(sidebarBox!.y - mainBox!.y)).toBeLessThan(10);
  });

  test("takes screenshot for visual inspection", async () => {
    await page.screenshot({ path: "tests/screenshots/startup.png", fullPage: true });
  });
});
