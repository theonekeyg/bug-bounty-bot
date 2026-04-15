import { contextBridge, ipcRenderer } from "electron";
import type { SubagentState, PendingInstall, RuntimeEvent } from "../src/types/index.js";
import type { SessionInfo } from "../src/db/sessions.js";
import type { AgentTurnInfo } from "../src/types/activity.js";
import type { AgentThinkingEvent, AgentTurnEvent, AgentToolProgressEvent } from "../src/ipc/bus.js";
import type { CredentialSource, Provider, ProviderStatus } from "../src/types/provider.js";

export type { SessionInfo, AgentTurnInfo };

export interface StoredEvent {
  id: string;
  sessionId: string;
  subagentId?: string;
  kind: string;
  severity: string;
  title: string;
  detail?: string;
  stage?: string;
  status?: string;
  createdAt: string;
}

export interface SubagentFileInfo {
  path: string;
  relativePath: string;
  size: number;
  mtime: string;
}

export interface BugBountyAPI {
  // Session management
  listSessions: () => Promise<SessionInfo[]>;
  getSession: (sessionId: string) => Promise<SessionInfo | null>;
  getSessionEvents: (sessionId: string) => Promise<StoredEvent[]>;
  getSessionStateDir: (sessionId: string) => Promise<string>;
  setActiveSession: (sessionId: string) => Promise<{ ok: boolean }>;
  setMaxSubagents: (sessionId: string, maxSubagents: number) => Promise<{ ok: boolean }>;
  stopResearch: (sessionId: string) => Promise<{ stopped: boolean } | { error: string }>;
  resumeResearch: (sessionId: string) => Promise<{ started: boolean; sessionId: string } | { error: string }>;

  // Research lifecycle
  startResearch: (briefPath: string, boxerUrl: string, model: string, maxSubagents: number) => Promise<{ started: boolean; sessionId: string | null }>;
  writeBrief: (content: string) => Promise<string>;
  readFile: (path: string) => Promise<string | null>;
  pickFile: (filters?: Electron.FileFilter[]) => Promise<string | null>;
  getProgress: (sessionId?: string) => Promise<SubagentState[]>;
  getPendingInstalls: (sessionId?: string) => Promise<PendingInstall[]>;
  resolveInstall: (
    subagentId: string,
    approved: boolean,
    install: PendingInstall,
  ) => Promise<{ approved: boolean; output?: string; exitCode?: number; error?: string }>;

  // Activity
  getAgentActivity: (sessionId: string, subagentId: string) => Promise<AgentTurnInfo[]>;
  listSubagentFiles: (sessionId: string, subagentId: string) => Promise<SubagentFileInfo[]>;
  getProviderStatuses: () => Promise<ProviderStatus[]>;
  getProviderStatus: (provider: Provider) => Promise<ProviderStatus>;
  testProviderCredential: (
    provider: Provider,
    source: CredentialSource,
    secret: string | null,
  ) => Promise<{ ok: boolean; errorMessage?: string }>;
  saveProviderCredential: (
    provider: Provider,
    source: CredentialSource,
    secret: string | null,
  ) => Promise<ProviderStatus>;
  deleteProviderCredential: (
    provider: Provider,
    source: CredentialSource,
  ) => Promise<ProviderStatus>;
  setProviderActiveSource: (
    provider: Provider,
    source: CredentialSource,
  ) => Promise<ProviderStatus>;

  // Event streams
  onResearchError: (cb: (err: string) => void) => void;
  onResearchLog: (cb: (subagentId: string, text: string) => void) => void;
  onRuntimeEvent: (cb: (event: RuntimeEvent) => void) => void;
  onAgentThinking: (cb: (event: AgentThinkingEvent) => void) => void;
  onAgentTurn: (cb: (event: AgentTurnEvent) => void) => void;
  onAgentToolProgress: (cb: (event: AgentToolProgressEvent) => void) => void;

}

contextBridge.exposeInMainWorld("bugBounty", {
  listSessions: () => ipcRenderer.invoke("list-sessions"),
  getSession: (sessionId: string) => ipcRenderer.invoke("get-session", sessionId),
  getSessionEvents: (sessionId: string) => ipcRenderer.invoke("get-session-events", sessionId),
  getSessionStateDir: (sessionId: string) => ipcRenderer.invoke("get-session-state-dir", sessionId),
  setActiveSession: (sessionId: string) => ipcRenderer.invoke("set-active-session", sessionId),
  setMaxSubagents: (sessionId: string, maxSubagents: number) => ipcRenderer.invoke("set-max-subagents", sessionId, maxSubagents),
  stopResearch: (sessionId: string) => ipcRenderer.invoke("stop-research", sessionId),
  resumeResearch: (sessionId: string) => ipcRenderer.invoke("resume-research", sessionId),

  startResearch: (briefPath: string, boxerUrl: string, model: string, maxSubagents: number) =>
    ipcRenderer.invoke("start-research", briefPath, boxerUrl, model, maxSubagents),

  writeBrief: (content: string) => ipcRenderer.invoke("write-brief", content),

  readFile: (path: string) => ipcRenderer.invoke("read-file", path),

  pickFile: (filters?: Electron.FileFilter[]) => ipcRenderer.invoke("pick-file", filters),

  getProgress: (sessionId?: string) => ipcRenderer.invoke("get-progress", sessionId),

  getPendingInstalls: (sessionId?: string) => ipcRenderer.invoke("get-pending-installs", sessionId),

  resolveInstall: (subagentId: string, approved: boolean, install: PendingInstall) =>
    ipcRenderer.invoke("resolve-install", subagentId, approved, install),

  getAgentActivity: (sessionId: string, subagentId: string) =>
    ipcRenderer.invoke("get-agent-activity", sessionId, subagentId),

  listSubagentFiles: (sessionId: string, subagentId: string) =>
    ipcRenderer.invoke("list-subagent-files", sessionId, subagentId),
  getProviderStatuses: () => ipcRenderer.invoke("get-provider-statuses"),
  getProviderStatus: (provider: Provider) => ipcRenderer.invoke("get-provider-status", provider),
  testProviderCredential: (provider: Provider, source: CredentialSource, secret: string | null) =>
    ipcRenderer.invoke("test-provider-credential", provider, source, secret),
  saveProviderCredential: (provider: Provider, source: CredentialSource, secret: string | null) =>
    ipcRenderer.invoke("save-provider-credential", provider, source, secret),
  deleteProviderCredential: (provider: Provider, source: CredentialSource) =>
    ipcRenderer.invoke("delete-provider-credential", provider, source),
  setProviderActiveSource: (provider: Provider, source: CredentialSource) =>
    ipcRenderer.invoke("set-provider-active-source", provider, source),

  onResearchError: (cb: (err: string) => void) =>
    ipcRenderer.on("research-error", (_event, err: string) => cb(err)),

  onResearchLog: (cb: (subagentId: string, text: string) => void) =>
    ipcRenderer.on("research-log", (_event, { subagentId, text }: { subagentId: string; text: string }) =>
      cb(subagentId, text),
    ),

  onRuntimeEvent: (cb: (event: RuntimeEvent) => void) =>
    ipcRenderer.on("runtime-event", (_event, event: RuntimeEvent) => cb(event)),

  onAgentThinking: (cb: (event: AgentThinkingEvent) => void) =>
    ipcRenderer.on("agent-thinking", (_event, event: AgentThinkingEvent) => cb(event)),

  onAgentTurn: (cb: (event: AgentTurnEvent) => void) =>
    ipcRenderer.on("agent-turn", (_event, event: AgentTurnEvent) => cb(event)),

  onAgentToolProgress: (cb: (event: AgentToolProgressEvent) => void) =>
    ipcRenderer.on("agent-tool-progress", (_event, event: AgentToolProgressEvent) => cb(event)),

} satisfies BugBountyAPI);
