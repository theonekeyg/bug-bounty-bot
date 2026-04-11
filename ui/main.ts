/**
 * Electron main process.
 * Manages the app window and IPC bridge to the agent backend.
 */

import { app, BrowserWindow, ipcMain, dialog, safeStorage } from "electron";
import { join } from "path";
import { readFile, readdir, writeFile, mkdir } from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createDecipheriv, createCipheriv, randomBytes } from "crypto";
import OpenAI from "openai";
import { Anthropic } from "@anthropic-ai/sdk";
import { BoxerClient } from "../src/sandbox/boxer.ts";
import { runOrchestrator } from "../src/orchestrator/agent.ts";
import { ProviderCredentialStore, type CredentialValidationResult } from "../src/credentials/store.ts";
import { setCredentialResolver } from "../src/credentials/runtime.ts";
import {
  ipcBus,
  type ResearchLogEvent,
  type AgentThinkingEvent,
  type AgentTurnEvent,
  type AgentToolProgressEvent,
} from "../src/ipc/bus.ts";
import { readAllTrackStates, sessionPaths, writeStopSignal, clearStopSignal } from "../src/loop/state.ts";
import type { PendingInstall } from "../src/types/state.ts";
import { PendingInstallSchema } from "../src/types/state.ts";
import {
  type CredentialSource,
  type Provider,
  RunModelConfigSchema,
} from "../src/types/provider.ts";
import type { RuntimeEvent } from "../src/types/runtime.ts";
import {
  initDb,
  markCrashedSessions,
  listSessions,
  getSession,
  updateSessionStatus,
  getAgentActivity,
} from "../src/db/index.ts";

const execFileAsync = promisify(execFile);

const USER_DATA_DIR = () => app.getPath("userData");
const PROVIDER_METADATA_FILE = () => join(USER_DATA_DIR(), "provider-credentials.json");
const PROVIDER_SECRET_FILE = () => join(USER_DATA_DIR(), "provider-secrets.enc");
const LOCAL_SECRET_KEY_FILE = () => join(USER_DATA_DIR(), "provider-secret.key");

let credentialStore: ProviderCredentialStore | null = null;

function ensureCredentialStore(): ProviderCredentialStore {
  if (!credentialStore) {
    throw new Error("Credential store not initialised");
  }
  return credentialStore;
}

function buildCredentialCodec() {
  if (!safeStorage.isEncryptionAvailable()) {
    return buildFallbackCodec();
  }

  return {
    isAvailable: () => safeStorage.isEncryptionAvailable(),
    encrypt: (value: string) => safeStorage.encryptString(value).toString("base64"),
    decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, "base64")),
  };
}

function buildFallbackCodec() {
  const key = loadOrCreateFallbackKey();

  return {
    isAvailable: () => true,
    encrypt: (value: string) => {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      const authTag = cipher.getAuthTag();
      return JSON.stringify({
        iv: iv.toString("base64"),
        authTag: authTag.toString("base64"),
        ciphertext: encrypted.toString("base64"),
      });
    },
    decrypt: (value: string) => {
      const payload = JSON.parse(value) as { iv: string; authTag: string; ciphertext: string };
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        Buffer.from(payload.iv, "base64"),
      );
      decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(payload.ciphertext, "base64")),
        decipher.final(),
      ]);
      return decrypted.toString("utf8");
    },
  };
}

function loadOrCreateFallbackKey(): Buffer {
  const keyPath = LOCAL_SECRET_KEY_FILE();
  if (existsSync(keyPath)) {
    return Buffer.from(readFileSync(keyPath, "utf-8"), "base64");
  }

  const key = randomBytes(32);
  mkdirSync(join(USER_DATA_DIR()), { recursive: true });
  writeFileSync(keyPath, key.toString("base64"), { mode: 0o600 });
  return key;
}

async function validateOpenAIKey(secret: string): Promise<CredentialValidationResult> {
  if (process.env["ELECTRON_IS_TEST"] === "1") {
    return secret.trim().length > 0 ? { ok: true } : { ok: false, errorMessage: "OpenAI key is required." };
  }
  try {
    const client = new OpenAI({ apiKey: secret });
    await client.models.list();
    return { ok: true };
  } catch (error) {
    return { ok: false, errorMessage: humanizeCredentialError("OpenAI", error) };
  }
}

async function validateOpenRouterKey(secret: string): Promise<CredentialValidationResult> {
  if (process.env["ELECTRON_IS_TEST"] === "1") {
    return secret.trim().length > 0 ? { ok: true } : { ok: false, errorMessage: "OpenRouter key is required." };
  }
  try {
    const client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: secret,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/bug-bounty-agent",
        "X-Title": "Bug Bounty Agent",
      },
    });
    await client.models.list();
    return { ok: true };
  } catch (error) {
    return { ok: false, errorMessage: humanizeCredentialError("OpenRouter", error) };
  }
}

async function validateAnthropicApiKey(secret: string): Promise<CredentialValidationResult> {
  if (process.env["ELECTRON_IS_TEST"] === "1") {
    return secret.trim().length > 0 ? { ok: true } : { ok: false, errorMessage: "Anthropic key is required." };
  }
  try {
    const client = new Anthropic({ apiKey: secret });
    await client.models.list();
    return { ok: true };
  } catch (error) {
    return { ok: false, errorMessage: humanizeCredentialError("Anthropic", error) };
  }
}

async function validateClaudeAuth(): Promise<CredentialValidationResult> {
  if (process.env["ELECTRON_IS_TEST"] === "1") {
    return { ok: true };
  }
  try {
    await execFileAsync("claude", ["auth", "status", "--json"], {
      env: process.env,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, errorMessage: humanizeCredentialError("Claude auth", error) };
  }
}

function humanizeCredentialError(provider: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/not found/i.test(raw) || /enoent/i.test(raw)) {
    return `${provider} is unavailable on this machine.`;
  }
  if (/unauthorized|authentication|api key|403|401/i.test(raw)) {
    return `${provider} credentials were rejected. Check the key or auth session.`;
  }
  if (/rate limit|quota|billing|payment/i.test(raw)) {
    return `${provider} access looks valid, but the account is rate-limited or out of quota.`;
  }
  return raw;
}

async function validateProviderCredential(input: {
  provider: Provider;
  source: CredentialSource;
  secret: string | null;
}): Promise<CredentialValidationResult> {
  switch (input.provider) {
    case "openai":
      return validateOpenAIKey(input.secret ?? "");
    case "openrouter":
      return validateOpenRouterKey(input.secret ?? "");
    case "anthropic":
      return input.source === "api_key" ? validateAnthropicApiKey(input.secret ?? "") : validateClaudeAuth();
  }

  throw new Error(`Unsupported provider: ${input.provider}`);
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

ipcBus.on("agent-thinking", (event: AgentThinkingEvent) => {
  mainWindow?.webContents.send("agent-thinking", event);
});

ipcBus.on("agent-turn", (event: AgentTurnEvent) => {
  mainWindow?.webContents.send("agent-turn", event);
});

ipcBus.on("agent-tool-progress", (event: AgentToolProgressEvent) => {
  mainWindow?.webContents.send("agent-tool-progress", event);
});

app.whenReady().then(async () => {
  // Initialise SQLite database in the user data directory
  const dbPath = join(app.getPath("userData"), "bugbounty.db");
  await initDb(dbPath);

  // Any session that was "running" when the process died is now "crashed"
  await markCrashedSessions();

  credentialStore = new ProviderCredentialStore({
    metadataPath: PROVIDER_METADATA_FILE(),
    secretPath: PROVIDER_SECRET_FILE(),
    codec: buildCredentialCodec(),
    validator: validateProviderCredential,
  });
  await credentialStore.load();
  setCredentialResolver((provider) => credentialStore?.resolveRuntimeCredential(provider) ?? null);

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
ipcMain.handle("start-research", async (_event, briefPath: string, boxerUrl: string, model: string, maxTracks: number) => {
  activeBoxer = new BoxerClient(boxerUrl);
  const modelConfig = RunModelConfigSchema.parse({ model, maxTracks: maxTracks ?? 6 });

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

/** Stop the active research session gracefully (can be resumed later). */
ipcMain.handle("stop-research", async (_event, sessionId: string) => {
  try {
    await writeStopSignal(sessionId);
    await updateSessionStatus(sessionId, "crashed");
    activeSessionId = null;
    return { stopped: true };
  } catch (err) {
    return { error: String(err) };
  }
});

/** Resume a previously crashed or interrupted session. */
ipcMain.handle("resume-research", async (_event, sessionId: string) => {
  const session = await getSession(sessionId);
  if (!session) return { error: "Session not found" };

  // Clear any previous stop signal so the loop can run
  await clearStopSignal(sessionId);

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

ipcMain.handle("get-provider-statuses", async () => ensureCredentialStore().getAllProviderStatuses());

ipcMain.handle("get-provider-status", async (_event, provider: Provider) =>
  ensureCredentialStore().getProviderStatus(provider),
);

ipcMain.handle(
  "test-provider-credential",
  async (_event, provider: Provider, source: CredentialSource, secret: string | null) => {
    const store = ensureCredentialStore();
    return store.testCredential({ provider, source, secret });
  },
);

ipcMain.handle(
  "save-provider-credential",
  async (_event, provider: Provider, source: CredentialSource, secret: string | null) => {
    const store = ensureCredentialStore();
    return store.saveCredential({ provider, source, secret });
  },
);

ipcMain.handle(
  "delete-provider-credential",
  async (_event, provider: Provider, source: CredentialSource) => {
    const store = ensureCredentialStore();
    return store.deleteCredential({ provider, source });
  },
);

ipcMain.handle(
  "set-provider-active-source",
  async (_event, provider: Provider, source: CredentialSource) => {
    const store = ensureCredentialStore();
    return store.setActiveSource(provider, source);
  },
);

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

/** Get full agent activity (turns + tool calls) for a track. */
ipcMain.handle("get-agent-activity", async (_event, sessionId: string, trackId: string) => {
  return getAgentActivity(sessionId, trackId);
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
