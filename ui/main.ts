/**
 * Electron main process.
 * Manages the app window and IPC bridge to the agent backend.
 */

import { app, BrowserWindow, ipcMain, dialog } from "electron";
import { join } from "path";
import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { BoxerClient } from "../src/sandbox/boxer.ts";
import { runOrchestrator } from "../src/orchestrator/agent.ts";
import { ipcBus, type ResearchLogEvent } from "../src/ipc/bus.ts";
import { readAllTrackStates, sessionPaths } from "../src/loop/state.ts";
import type { PendingInstall } from "../src/types/state.ts";
import { PendingInstallSchema } from "../src/types/state.ts";
import { RunModelConfigSchema } from "../src/types/provider.ts";
import type { RuntimeEvent } from "../src/types/runtime.ts";
import {
  initDb,
  markCrashedSessions,
  listSessions,
  getSession,
  updateSessionStatus,
} from "../src/db/index.ts";

export interface AppSettings {
  openaiKey: string;
}

const SETTINGS_FILE = () => join(app.getPath("userData"), "settings.json");

async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(SETTINGS_FILE(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return { openaiKey: parsed.openaiKey ?? "" };
  } catch {
    return { openaiKey: "" };
  }
}

async function saveSettings(settings: AppSettings): Promise<void> {
  await writeFile(SETTINGS_FILE(), JSON.stringify(settings, null, 2), "utf-8");
  // Immediately apply to env so running agents pick them up
  if (settings.openaiKey) process.env["OPENAI_API_KEY"] = settings.openaiKey;
}

let mainWindow: BrowserWindow | null = null;
let activeBoxer: BoxerClient | null = null;
/** Session currently being researched (used to scope polling and pending installs). */
let activeSessionId: string | null = null;

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

// Forward streaming log chunks from agents → renderer
ipcBus.on("research-log", (event: ResearchLogEvent) => {
  mainWindow?.webContents.send("research-log", event);
});

ipcBus.on("runtime-event", (event: RuntimeEvent) => {
  mainWindow?.webContents.send("runtime-event", event);
});

app.whenReady().then(async () => {
  // Initialise SQLite database in the user data directory
  const dbPath = join(app.getPath("userData"), "bugbounty.db");
  await initDb(dbPath);

  // Any session that was "running" when the process died is now "crashed"
  await markCrashedSessions();

  // Apply saved API keys to env before any agent runs
  const settings = await loadSettings();
  if (settings.openaiKey && !process.env["OPENAI_API_KEY"]) process.env["OPENAI_API_KEY"] = settings.openaiKey;

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// ── IPC handlers ──────────────────────────────────────────────────────────────

/** List all sessions (newest first). */
ipcMain.handle("list-sessions", async () => listSessions());

/** Get a single session by ID. */
ipcMain.handle("get-session", async (_event, sessionId: string) => getSession(sessionId));

/** Get all persisted events for a session (for replaying on resume). */
ipcMain.handle("get-session-events", async (_event, sessionId: string) => {
  const { getSessionEvents } = await import("../src/db/sessions.ts");
  return getSessionEvents(sessionId);
});

/** Start a new research session from a brief. */
ipcMain.handle("start-research", async (_event, briefPath: string, boxerUrl: string, model: string) => {
  activeBoxer = new BoxerClient(boxerUrl);
  const modelConfig = RunModelConfigSchema.parse({ model });

  // runOrchestrator creates the session in DB and returns after session is complete.
  // We don't await here — fire and forget so the IPC call returns immediately.
  let capturedSessionId: string | null = null;

  // We need the sessionId before the orchestrator returns. Since createSession
  // is called inside runOrchestrator, we listen for the first runtime-event which
  // carries enough info. Instead, let's create the session here and pass it in.
  // Simpler: run orchestrator normally, sessionId is emitted via the first event.
  // The renderer will know it from the list-sessions call.
  runOrchestrator(briefPath, activeBoxer, modelConfig)
    .then(() => {
      void capturedSessionId;
    })
    .catch((err: unknown) => {
      mainWindow?.webContents.send("research-error", String(err));
      if (activeSessionId) {
        updateSessionStatus(activeSessionId, "failed").catch(console.error);
      }
    });

  // Give the orchestrator a moment to create the session, then return its ID
  await new Promise((resolve) => setTimeout(resolve, 500));
  const sessions = await listSessions();
  const newest = sessions[0];
  if (newest) {
    activeSessionId = newest.id;
    return { started: true, sessionId: newest.id };
  }
  return { started: true, sessionId: null };
});

/** Resume a previously crashed or interrupted session. */
ipcMain.handle("resume-research", async (_event, sessionId: string) => {
  const session = await getSession(sessionId);
  if (!session) return { error: "Session not found" };

  activeBoxer = new BoxerClient(session.boxerUrl);
  activeSessionId = sessionId;
  const modelConfig = RunModelConfigSchema.parse({ model: session.model });

  runOrchestrator(session.briefPath, activeBoxer, modelConfig, { sessionId })
    .catch((err: unknown) => {
      mainWindow?.webContents.send("research-error", String(err));
      updateSessionStatus(sessionId, "failed").catch(console.error);
    });

  return { started: true, sessionId };
});

/** Set the active session for polling (when user clicks into a historical session). */
ipcMain.handle("set-active-session", async (_event, sessionId: string) => {
  activeSessionId = sessionId;
  return { ok: true };
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

/** Poll current research progress for the active session. */
ipcMain.handle("get-progress", async (_event, sessionId?: string) => {
  const sid = sessionId ?? activeSessionId;
  if (!sid) return [];
  return readAllTrackStates(sid);
});

/** Get the state directory path for a session (so renderer can construct file paths). */
ipcMain.handle("get-session-state-dir", async (_event, sessionId: string) => {
  return sessionPaths(sessionId).stateDir();
});

/** Check for pending install permission requests. */
ipcMain.handle("get-pending-installs", async (_event, sessionId?: string) => {
  const sid = sessionId ?? activeSessionId;
  if (!sid) return [];
  const researchDir = join(sessionPaths(sid).stateDir(), "research");
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
