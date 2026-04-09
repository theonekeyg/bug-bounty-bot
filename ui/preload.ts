import { contextBridge, ipcRenderer } from "electron";
import type { TrackState, PendingInstall, RuntimeEvent } from "../src/types/index.js";
import type { SessionInfo } from "../src/db/sessions.js";

export type { SessionInfo };

export interface AppSettings {
  openaiKey: string;
}

export interface StoredEvent {
  id: string;
  sessionId: string;
  trackId?: string;
  kind: string;
  severity: string;
  title: string;
  detail?: string;
  stage?: string;
  status?: string;
  createdAt: string;
}

export interface BugBountyAPI {
  // Session management
  listSessions: () => Promise<SessionInfo[]>;
  getSession: (sessionId: string) => Promise<SessionInfo | null>;
  getSessionEvents: (sessionId: string) => Promise<StoredEvent[]>;
  getSessionStateDir: (sessionId: string) => Promise<string>;
  setActiveSession: (sessionId: string) => Promise<{ ok: boolean }>;
  resumeResearch: (sessionId: string) => Promise<{ started: boolean; sessionId: string } | { error: string }>;

  // Research lifecycle
  startResearch: (briefPath: string, boxerUrl: string, model: string) => Promise<{ started: boolean; sessionId: string | null }>;
  writeBrief: (content: string) => Promise<string>;
  readFile: (path: string) => Promise<string | null>;
  pickFile: (filters?: Electron.FileFilter[]) => Promise<string | null>;
  getProgress: (sessionId?: string) => Promise<TrackState[]>;
  getPendingInstalls: (sessionId?: string) => Promise<PendingInstall[]>;
  resolveInstall: (
    trackId: string,
    approved: boolean,
    install: PendingInstall,
  ) => Promise<{ approved: boolean; output?: string; exitCode?: number; error?: string }>;

  // Event streams
  onResearchError: (cb: (err: string) => void) => void;
  onResearchLog: (cb: (trackId: string, text: string) => void) => void;
  onRuntimeEvent: (cb: (event: RuntimeEvent) => void) => void;

  // Settings
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<void>;
}

contextBridge.exposeInMainWorld("bugBounty", {
  listSessions: () => ipcRenderer.invoke("list-sessions"),
  getSession: (sessionId: string) => ipcRenderer.invoke("get-session", sessionId),
  getSessionEvents: (sessionId: string) => ipcRenderer.invoke("get-session-events", sessionId),
  getSessionStateDir: (sessionId: string) => ipcRenderer.invoke("get-session-state-dir", sessionId),
  setActiveSession: (sessionId: string) => ipcRenderer.invoke("set-active-session", sessionId),
  resumeResearch: (sessionId: string) => ipcRenderer.invoke("resume-research", sessionId),

  startResearch: (briefPath: string, boxerUrl: string, model: string) =>
    ipcRenderer.invoke("start-research", briefPath, boxerUrl, model),

  writeBrief: (content: string) => ipcRenderer.invoke("write-brief", content),

  readFile: (path: string) => ipcRenderer.invoke("read-file", path),

  pickFile: (filters?: Electron.FileFilter[]) => ipcRenderer.invoke("pick-file", filters),

  getProgress: (sessionId?: string) => ipcRenderer.invoke("get-progress", sessionId),

  getPendingInstalls: (sessionId?: string) => ipcRenderer.invoke("get-pending-installs", sessionId),

  resolveInstall: (trackId: string, approved: boolean, install: PendingInstall) =>
    ipcRenderer.invoke("resolve-install", trackId, approved, install),

  onResearchError: (cb: (err: string) => void) =>
    ipcRenderer.on("research-error", (_event, err: string) => cb(err)),

  onResearchLog: (cb: (trackId: string, text: string) => void) =>
    ipcRenderer.on("research-log", (_event, { trackId, text }: { trackId: string; text: string }) =>
      cb(trackId, text),
    ),

  onRuntimeEvent: (cb: (event: RuntimeEvent) => void) =>
    ipcRenderer.on("runtime-event", (_event, event: RuntimeEvent) => cb(event)),

  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke("save-settings", settings),
} satisfies BugBountyAPI);
