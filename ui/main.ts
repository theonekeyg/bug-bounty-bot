/**
 * Electron main process.
 * Manages the app window and IPC bridge to the agent backend.
 */

import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join } from "path";
import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { BoxerClient } from "../src/sandbox/boxer.js";
import { runOrchestrator } from "../src/orchestrator/agent.js";
import { readAllTrackStates } from "../src/loop/state.js";
import type { PendingInstall } from "../src/types/state.js";
import { PendingInstallSchema } from "../src/types/state.js";
import { RunModelConfigSchema } from "../src/types/provider.js";

export interface AppSettings {
  openaiKey: string;
  anthropicKey: string;
}

const SETTINGS_FILE = () => join(app.getPath("userData"), "settings.json");

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(SETTINGS_FILE(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { openaiKey: parsed.openaiKey ?? "", anthropicKey: parsed.anthropicKey ?? "" };
  } catch {
    return { openaiKey: "", anthropicKey: "" };
  }
}

async function saveSettings(settings: AppSettings): Promise<void> {
  await writeFile(SETTINGS_FILE(), JSON.stringify(settings, null, 2), "utf-8");
  // Immediately apply to env so running agents pick them up
  if (settings.openaiKey) process.env["OPENAI_API_KEY"] = settings.openaiKey;
  if (settings.anthropicKey) process.env["ANTHROPIC_API_KEY"] = settings.anthropicKey;
}

let mainWindow: BrowserWindow | null = null;
let activeBoxer: BoxerClient | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: process.env["ELECTRON_IS_TEST"] !== "1",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0f0f0f",
  });

  mainWindow.loadFile(join(import.meta.dirname, "renderer", "index.html"));

  if (process.env["NODE_ENV"] === "development") {
    mainWindow.webContents.openDevTools();
  }
}

app.whenReady().then(async () => {
  // Apply saved API keys to env before any agent runs
  const settings = await loadSettings();
  if (settings.openaiKey && !process.env["OPENAI_API_KEY"]) process.env["OPENAI_API_KEY"] = settings.openaiKey;
  if (settings.anthropicKey && !process.env["ANTHROPIC_API_KEY"]) process.env["ANTHROPIC_API_KEY"] = settings.anthropicKey;

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── IPC handlers ──────────────────────────────────────────────────────────────

/** Start a research session from a brief. */
ipcMain.handle("start-research", async (_event, briefPath: string, boxerUrl: string, model: string) => {
  activeBoxer = new BoxerClient(boxerUrl);
  const modelConfig = RunModelConfigSchema.parse({ model });

  runOrchestrator(briefPath, activeBoxer, modelConfig).catch((err: unknown) => {
    mainWindow?.webContents.send("research-error", String(err));
  });

  return { started: true };
});

/** Get persisted API key settings. */
ipcMain.handle("get-settings", async () => loadSettings());

/** Save API key settings and apply to process.env. */
ipcMain.handle("save-settings", async (_event, settings: AppSettings) => {
  await saveSettings(settings);
});

/** Write a brief file and return its path. */
ipcMain.handle("write-brief", async (_event, content: string) => {
  const briefPath = `briefs/session-${Date.now()}.md`;
  await mkdir("briefs", { recursive: true });
  await writeFile(briefPath, content, "utf-8");
  return briefPath;
});

/** Read a file for the renderer (e.g. progress.md). Returns null if not found. */
ipcMain.handle("read-file", async (_event, filePath: string) => {
  try {
    return await readFile(filePath, "utf-8");
  } catch {
    return null;
  }
});

ipcMain.handle("pick-file", async (_event, filters?: Electron.FileFilter[]) => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ["openFile"],
    filters: filters ?? [{ name: "Markdown", extensions: ["md"] }],
  });
  return result.filePaths[0] ?? null;
});

/** Poll current research progress. */
ipcMain.handle("get-progress", async () => {
  const states = await readAllTrackStates();
  return states;
});

/** Check for pending install permission requests. */
ipcMain.handle("get-pending-installs", async () => {
  const researchDir = join("state", "research");
  if (!existsSync(researchDir)) return [];

  const dirs = await readdir(researchDir, { withFileTypes: true });
  const pending: PendingInstall[] = [];

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const installPath = join(researchDir, d.name, "pending_install.json");
    if (!existsSync(installPath)) continue;
    const raw = await readFile(installPath, "utf-8");
    pending.push(PendingInstallSchema.parse(JSON.parse(raw)));
  }

  return pending;
});

/** Approve or reject a pending install. */
ipcMain.handle(
  "resolve-install",
  async (_event, trackId: string, approved: boolean, install: PendingInstall) => {
    if (!activeBoxer) return { error: "No active session" };

    if (approved) {
      // Run the install command inside Boxer sandbox
      const result = await activeBoxer.runShell(install.command, {
        network: "sandbox", // needs network for package downloads
      });
      return { approved: true, output: result.stdout, exitCode: result.exitCode };
    }

    return { approved: false };
  },
);
