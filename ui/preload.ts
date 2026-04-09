import { contextBridge, ipcRenderer } from "electron";
import type { TrackState, PendingInstall } from "../src/types/index.js";

export interface AppSettings {
  openaiKey: string;
  anthropicKey: string;
}

export interface BugBountyAPI {
  startResearch: (briefPath: string, boxerUrl: string, model: string) => Promise<{ started: boolean }>;
  writeBrief: (content: string) => Promise<string>;
  readFile: (path: string) => Promise<string | null>;
  pickFile: (filters?: Electron.FileFilter[]) => Promise<string | null>;
  getProgress: () => Promise<TrackState[]>;
  getPendingInstalls: () => Promise<PendingInstall[]>;
  resolveInstall: (
    trackId: string,
    approved: boolean,
    install: PendingInstall,
  ) => Promise<{ approved: boolean; output?: string; exitCode?: number; error?: string }>;
  onResearchError: (cb: (err: string) => void) => void;
  getSettings: () => Promise<AppSettings>;
  saveSettings: (settings: AppSettings) => Promise<void>;
}

contextBridge.exposeInMainWorld("bugBounty", {
  startResearch: (briefPath: string, boxerUrl: string, model: string) =>
    ipcRenderer.invoke("start-research", briefPath, boxerUrl, model),

  writeBrief: (content: string) => ipcRenderer.invoke("write-brief", content),

  readFile: (path: string) => ipcRenderer.invoke("read-file", path),

  pickFile: (filters?: Electron.FileFilter[]) => ipcRenderer.invoke("pick-file", filters),

  getProgress: () => ipcRenderer.invoke("get-progress"),

  getPendingInstalls: () => ipcRenderer.invoke("get-pending-installs"),

  resolveInstall: (trackId: string, approved: boolean, install: PendingInstall) =>
    ipcRenderer.invoke("resolve-install", trackId, approved, install),

  onResearchError: (cb: (err: string) => void) =>
    ipcRenderer.on("research-error", (_event, err: string) => cb(err)),

  getSettings: () => ipcRenderer.invoke("get-settings"),
  saveSettings: (settings: AppSettings) => ipcRenderer.invoke("save-settings", settings),
} satisfies BugBountyAPI);
