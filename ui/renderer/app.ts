/**
 * Renderer process — UI logic.
 * Communicates with main process via window.bugBounty (preload bridge).
 */

import type { BugBountyAPI, SessionInfo, AgentTurnInfo, TrackFileInfo } from "../preload.js";
import type { TrackState, PendingInstall, RuntimeEvent } from "../../src/types/index.js";
import type { AgentThinkingEvent, AgentTurnEvent, AgentToolProgressEvent } from "../../src/ipc/bus.js";
import {
  DEFAULT_MODEL,
  PROVIDER_CAPABILITIES,
  PROVIDER_MODELS,
  PROVIDERS,
  type CredentialSource,
  type Provider,
  type ProviderStatus,
  type SupportedModel,
  getCredentialSourceLabel,
  getModelProvider,
  getModelInfo,
  getProviderLabel,
} from "../../src/types/provider.js";

declare const window: Window & { bugBounty: BugBountyAPI };

const api = window.bugBounty;

type DropdownOption = {
  value: string;
  label: string;
  description?: string;
};

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ── Sidebar (brief form) ─────────────────────────────────────────────────────
const sessionsView = el("sessions-view");
const sessionsList = el("sessions-list");
const newSessionBtn = el<HTMLButtonElement>("new-session-btn");
const startBtn = el<HTMLButtonElement>("start-btn");
const targetInput = el<HTMLInputElement>("target");
const goalInput = el<HTMLInputElement>("goal");
const scopeInput = el<HTMLTextAreaElement>("scope");
const codePathInput = el<HTMLInputElement>("code-path");
const pickCodeBtn = el<HTMLButtonElement>("pick-code");
const linksInput = el<HTMLInputElement>("links");
const contextInput = el<HTMLTextAreaElement>("context");
const modelTrigger = el<HTMLButtonElement>("model-trigger");
const boxerUrlInput = el<HTMLInputElement>("boxer-url");
const tracksContainer = el("tracks-container");
const providerAccessSummary = el("provider-access-summary");
const providerCards = el("provider-cards");
const providerSetupCard = el("provider-setup-card");
const providerSetupProvider = el("provider-setup-provider");
const providerSetupState = el("provider-setup-state");
const providerSetupCopy = el("provider-setup-copy");
const providerSetupHint = el("provider-setup-hint");
const providerSourceSwitch = el("provider-source-switch");
const providerSecretField = el("provider-secret-field");
const providerSecretInput = el<HTMLInputElement>("provider-secret");
const providerSecretLabel = el("provider-secret-label");
const providerTestBtn = el<HTMLButtonElement>("provider-test");
const providerSaveBtn = el<HTMLButtonElement>("provider-save");
const providerDeleteBtn = el<HTMLButtonElement>("provider-delete");
const startHint = el("start-hint");
const welcome = el("welcome");
const progressView = el("progress-view");

// ── Session header ───────────────────────────────────────────────────────────
const sessionStagePill = el("session-stage-pill");
const sessionHealthPill = el("session-health-pill");
const sessionElapsed = el("session-elapsed");
const sessionCost = el("session-cost");
const activeTitle = el("active-track-title");
const debugToggleBtn = el<HTMLButtonElement>("debug-toggle-btn");
const backToSessionsBtn = el<HTMLButtonElement>("back-to-sessions");
const stopSessionBtn = el<HTMLButtonElement>("stop-session-btn");
const resumeSessionBtn = el<HTMLButtonElement>("resume-session-btn");
const sessionActionState = el("session-action-state");
const sessionMaxTracksInput = el<HTMLInputElement>("session-max-tracks");

// ── Session layout ───────────────────────────────────────────────────────────
const sidebarTrackList = el("sidebar-track-list");
const actionBanner = el("action-banner");
const tracksOverview = el("tracks-overview");
const trackDetail = el("track-detail");
const trackTokenStats = el("track-token-stats");
const stepsTab = el<HTMLButtonElement>("steps-tab");
const filesTab = el<HTMLButtonElement>("files-tab");
const toolsTab = el<HTMLButtonElement>("tools-tab");
const stepsPanel = el("steps-panel");
const filesPanel = el("files-panel");
const toolsPanel = el("tools-panel");
const toolsList = el("tools-list");
const toolsCallCount = el("tools-call-count");
const toolsTypeDropdown = el("tools-type-dropdown");
const toolsTypeTrigger = el<HTMLButtonElement>("tools-type-trigger");
const toolsTypeLabel = el("tools-type-label");
const toolsTypeMenu = el("tools-type-menu");
const fileList = el("file-list");
const fileViewer = el("file-viewer");
const timelineIterations = el("timeline-iterations");
const debugPanelNew = el("debug-panel-new");
const progressLog = el("progress-log");

// ── Permission overlay ───────────────────────────────────────────────────────
const permissionOverlay = el("permission-overlay");
const permJustification = el("perm-justification");
const permCommand = el("perm-command");
const permApprove = el<HTMLButtonElement>("perm-approve");
const permDeny = el<HTMLButtonElement>("perm-deny");

// ── Sidebar form misc ────────────────────────────────────────────────────────
const modelInput = el<HTMLInputElement>("model-name");
const maxTracksInput = el<HTMLInputElement>("max-tracks");
const maxTracksLabel = el("max-tracks-label");
const runtimeSessionCard = el("runtime-session-card");
const runtimeHealthDot = el("runtime-health-dot");
const runtimeTarget = el("runtime-target");
const runtimeModel = el("runtime-model");
const runtimeBoxer = el("runtime-boxer");
const runtimeHealthLabel = el("runtime-health-label");

// ── State ────────────────────────────────────────────────────────────────────
let activeSessionId: string | null = null;
let activeSessionStateDir: string | null = null;
let activeSessionModel = "";
let activeTrackId: string | null = null;  // kept for progress-log polling
let selectedTrackId: string | null = null; // null = "All Tracks"
let subView: "steps" | "files" | "tools" = "steps";
let toolsFilterType = "all";
let toolsFilterOutcomes: Set<string> = new Set(["ok", "error", "pending"]);
let debugMode = false;
let pendingInstall: PendingInstall | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let runtimeEvents: RuntimeEvent[] = [];
let sessionStage = "Starting";
let sessionHeadlineText = "Preparing session...";
let sessionLastUpdated: string | null = null;
let sessionStartedAt: string | null = null;
let activeSessionStatus: SessionInfo["status"] | "idle" = "idle";
let currentStates: TrackState[] = [];
const trackHeadlineById = new Map<string, string>();
const trackStageById = new Map<string, string>();

// Token accumulation
let sessionInputTokens = 0;
let sessionOutputTokens = 0;
let sessionCacheReadTokens = 0;
let sessionCacheWriteTokens = 0;
const trackTokensById = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();

// Live iteration streaming
let liveIterationEl: HTMLElement | null = null;
let liveThinkingStreamEl: HTMLElement | null = null;
let liveThinkingTextEl: HTMLElement | null = null;
let providerStatuses: ProviderStatus[] = [];
let providerSetupTarget: Provider | null = null;
let providerSetupSourceByProvider = new Map<Provider, CredentialSource>();
let refreshModelPickerUI: (() => void) | null = null;
let refreshStartActionUI: (() => void) | null = null;

function createDefaultProviderStatus(provider: Provider): ProviderStatus {
  const supportedSources = PROVIDER_CAPABILITIES[provider].supportedSources;
  const sources = Object.fromEntries(
    supportedSources.map((source) => [
      source,
      {
        source,
        state: "missing",
        lastValidatedAt: null,
        errorMessage: null,
      },
    ]),
  ) as ProviderStatus["sources"];

  return {
    provider,
    state: "missing",
    source: null,
    activeSource: null,
    lastValidatedAt: null,
    errorMessage: null,
    supportedSources,
    sources,
  };
}

function getProviderStatus(provider: Provider): ProviderStatus {
  return providerStatuses.find((status) => status.provider === provider) ?? createDefaultProviderStatus(provider);
}

function getProviderStateLabel(state: ProviderStatus["state"]): string {
  return {
    missing: "Not set",
    testing: "Testing",
    ready: "Ready",
    invalid: "Invalid",
  }[state];
}

function getProviderSetupSource(provider: Provider): CredentialSource {
  const status = getProviderStatus(provider);
  if (providerSetupSourceByProvider.has(provider)) {
    return providerSetupSourceByProvider.get(provider) ?? status.activeSource ?? PROVIDER_CAPABILITIES[provider].defaultSource;
  }
  return status.activeSource ?? PROVIDER_CAPABILITIES[provider].defaultSource;
}

function isProviderReady(provider: Provider): boolean {
  return getProviderStatus(provider).state === "ready";
}

function getSelectedModel(): SupportedModel {
  return (modelInput.value || DEFAULT_MODEL) as SupportedModel;
}

function getSelectedProvider(): Provider {
  return getModelProvider(getSelectedModel());
}

function getProviderSetupInstructions(provider: Provider, source: CredentialSource): string {
  if (provider === "anthropic" && source === "claude_auth") {
    return "This uses your local Claude Code login. Save will mark the provider ready once the auth session is available.";
  }
  if (provider === "openai" && source === "codex_auth") {
    return "This uses your local Codex login. If you are not signed in yet, run `codex login` in a terminal first, then save here.";
  }
  return "Enter the credential, test it, and save it to unlock this provider.";
}

function getProviderSourcePlaceholder(provider: Provider, source: CredentialSource): string {
  if (source === "codex_auth") return "No API key needed";
  if (source === "claude_auth") return "No API key needed";
  if (provider === "openai") return "sk-...";
  if (provider === "openrouter") return "sk-or-...";
  return "sk-ant-...";
}

function isAuthSource(source: CredentialSource): boolean {
  return source === "claude_auth" || source === "codex_auth";
}

function openProviderSetup(provider: Provider, source?: CredentialSource): void {
  providerSetupTarget = provider;
  const nextSource = source ?? providerSetupSourceByProvider.get(provider) ?? getProviderSetupSource(provider);
  providerSetupSourceByProvider.set(provider, nextSource);
  renderProviderAccess();
  providerSetupCard.scrollIntoView({ block: "nearest" });
}

function setStartActionState(disabled: boolean, label: string, detail: string): void {
  startBtn.disabled = disabled;
  startBtn.textContent = label;
  startHint.textContent = detail;
}

function renderStartAction(): void {
  const provider = getSelectedProvider();
  const status = getProviderStatus(provider);
  const providerLabel = getProviderLabel(provider);

  if (!status.state || status.state !== "ready") {
    setStartActionState(true, `Set up ${providerLabel} to continue`, `${providerLabel} is ${getProviderStateLabel(status.state).toLowerCase()}.`);
    startHint.textContent = status.errorMessage ?? `Open Provider Access to unlock ${providerLabel} before starting research.`;
    return;
  }

  setStartActionState(false, "Start Research", `${providerLabel} is ready. Fill in the brief and launch when you are ready.`);
}

function renderProviderSetup(): void {
  const provider = providerSetupTarget ?? getSelectedProvider();
  const status = getProviderStatus(provider);
  const source = getProviderSetupSource(provider);
  const sourceLabel = getCredentialSourceLabel(source);
  const providerLabel = getProviderLabel(provider);
  const activeStatus = status.sources[source];
  const panelState = activeStatus?.state ?? status.state;

  providerSetupCard.dataset.provider = provider;
  providerSetupProvider.textContent = providerLabel;
  providerSetupState.textContent = getProviderStateLabel(panelState);
  providerSetupState.className = `provider-status-badge ${panelState}`;
  providerSetupCopy.textContent = getProviderSetupInstructions(provider, source);

  providerSourceSwitch.innerHTML = "";
  for (const candidate of status.supportedSources) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `provider-source-chip ${candidate === source ? "selected" : ""}`;
    button.textContent = getCredentialSourceLabel(candidate);
    button.addEventListener("click", () => {
      const candidateStatus = status.sources[candidate];
      if (candidateStatus?.state === "ready" && candidate !== status.activeSource) {
        providerSetupSourceByProvider.set(provider, candidate);
        void api.setProviderActiveSource(provider, candidate).then(() => refreshProviderStatuses());
        return;
      }
      providerSetupSourceByProvider.set(provider, candidate);
      renderProviderAccess();
    });
    providerSourceSwitch.appendChild(button);
  }

  providerSecretLabel.textContent = sourceLabel;
  if (isAuthSource(source)) {
    providerSecretInput.value = "";
  }
  providerSecretInput.placeholder = getProviderSourcePlaceholder(provider, source);
  providerSecretField.classList.toggle("hidden", isAuthSource(source));

  providerSetupHint.textContent =
    status.state === "ready"
      ? `Active source: ${sourceLabel}. Last validated ${status.lastValidatedAt ? formatRelativeTime(status.lastValidatedAt) : "just now"}.`
      : activeStatus?.errorMessage ?? (source === "codex_auth"
          ? "No Codex login is saved yet."
          : source === "claude_auth"
            ? "No Claude auth session is saved yet."
            : `No ${sourceLabel} is saved yet.`);

  providerTestBtn.textContent = isAuthSource(source) ? "Test login" : "Test";
  providerSaveBtn.textContent = isAuthSource(source) ? `Save ${sourceLabel}` : "Save";
  providerDeleteBtn.textContent = isAuthSource(source) ? "Clear login" : "Delete";
  providerDeleteBtn.disabled = activeStatus?.state === "missing";
  providerSaveBtn.disabled = false;
  providerTestBtn.disabled = false;

  providerSetupCard.classList.toggle("is-target", providerSetupTarget === provider);
  providerSetupCard.classList.toggle("is-empty", providerSetupTarget === null);
}

async function refreshProviderStatuses(): Promise<void> {
  providerStatuses = await api.getProviderStatuses();

  if (!providerSetupTarget) {
    providerSetupTarget = getSelectedProvider();
  }

  if (providerSetupTarget && !providerSetupSourceByProvider.has(providerSetupTarget)) {
    providerSetupSourceByProvider.set(providerSetupTarget, getProviderSetupSource(providerSetupTarget));
  }

  renderProviderAccess();
  refreshModelPickerUI?.();
  refreshStartActionUI?.();
}

function renderProviderAccess(): void {
  const readyCount = providerStatuses.filter((status) => status.state === "ready").length;
  providerAccessSummary.textContent = `${readyCount}/${PROVIDERS.length} ready`;
  providerCards.innerHTML = "";

  for (const provider of PROVIDERS.map((entry) => entry.value)) {
    const status = getProviderStatus(provider);
    const card = document.createElement("article");
    card.className = `provider-card ${providerSetupTarget === provider ? "selected" : ""}`;
    card.dataset.provider = provider;

    const statusLabel = getProviderStateLabel(status.state);
    const activeSource = status.activeSource ?? status.source ?? PROVIDER_CAPABILITIES[provider].defaultSource;
    const activeSourceLabel = getCredentialSourceLabel(activeSource);
    const sourceSummary =
      provider === "anthropic"
        ? `Active source: ${activeSourceLabel}`
        : `Source: ${activeSourceLabel}`;
    const detail =
      status.state === "ready"
        ? `${sourceSummary} · validated ${status.lastValidatedAt ? formatRelativeTime(status.lastValidatedAt) : "just now"}`
        : status.errorMessage ?? sourceSummary;

    card.innerHTML = `
      <div class="provider-card-top">
        <div>
          <div class="provider-card-title">${getProviderLabel(provider)}</div>
          <div class="provider-card-copy">${detail}</div>
        </div>
        <span class="provider-status-badge ${status.state}">${statusLabel}</span>
      </div>
      <div class="provider-card-footer">
        <div class="provider-card-source">${sourceSummary}</div>
        <button type="button" class="provider-card-action">${status.state === "ready" ? "Manage" : `Set up ${getProviderLabel(provider)} to continue`}</button>
      </div>
    `;

    card.querySelector<HTMLButtonElement>(".provider-card-action")?.addEventListener("click", () => {
      openProviderSetup(provider, activeSource);
    });

    card.addEventListener("click", (event) => {
      if (event.target instanceof HTMLButtonElement) return;
      openProviderSetup(provider, activeSource);
    });

    providerCards.appendChild(card);
  }

  if (providerSetupTarget) {
    renderProviderSetup();
  }
}

function setSessionConfigLocked(locked: boolean): void {
  targetInput.disabled = locked;
  goalInput.disabled = locked;
  scopeInput.disabled = locked;
  codePathInput.disabled = locked;
  pickCodeBtn.disabled = locked;
  linksInput.disabled = locked;
  contextInput.disabled = locked;
  modelTrigger.disabled = locked;
  boxerUrlInput.disabled = locked;
  maxTracksInput.disabled = locked;
}

function formatEventTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatRelativeTime(timestamp: string | null): string {
  if (!timestamp) return "No activity yet";
  const diffSec = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (diffSec < 5) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

function formatElapsed(timestamp: string | null): string {
  if (!timestamp) return "00:00";
  const totalSec = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  if (hours > 0) return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function humanizeTrackTitle(trackId: string, fallback?: string): string {
  const source = fallback && fallback.trim().length > 0 ? fallback : trackId;
  return source.replaceAll(/[-_]/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

function summarizeTrack(state: TrackState): string {
  return trackHeadlineById.get(state.trackId) ?? trackStageById.get(state.trackId) ?? state.hypothesis;
}

function getSessionHealth(): { label: string; tone: "" | "warning" | "error" } {
  if (activeSessionStatus === "crashed") return { label: "Stopped", tone: "warning" };
  if (activeSessionStatus === "failed") return { label: "Failed", tone: "error" };
  const latest = runtimeEvents.at(-1);
  if (pendingInstall) return { label: "Needs approval", tone: "warning" };
  
  // Check for API limit errors specifically
  const apiLimitEvent = runtimeEvents.find(event => 
    event.kind === "error" && event.title === "API limit reached"
  );
  if (apiLimitEvent) return { label: "API limit reached", tone: "error" };
  
  if (latest?.severity === "error") return { label: "Attention needed", tone: "error" };
  if (latest?.severity === "warning") return { label: "Watching closely", tone: "warning" };
  return { label: "Healthy", tone: "" };
}

function resetSessionActionButtons(): void {
  stopSessionBtn.disabled = false;
  stopSessionBtn.textContent = "Stop";
  resumeSessionBtn.disabled = false;
  resumeSessionBtn.textContent = "Resume";
}

function applySessionActionButtons(status: SessionInfo["status"] | "idle"): void {
  activeSessionStatus = status;
  resetSessionActionButtons();
  stopSessionBtn.style.display = status === "running" ? "" : "none";
  const resumable = status === "crashed" || status === "failed";
  resumeSessionBtn.style.display = resumable ? "" : "none";
  sessionActionState.style.display = resumable ? "" : "none";
  sessionActionState.textContent = resumable ? "Resume available" : "";
}

function resetRuntimeState(): void {
  runtimeEvents = [];
  sessionStage = "Starting";
  sessionHeadlineText = "Preparing session...";
  sessionLastUpdated = null;
  sessionStartedAt = null;
  activeSessionStatus = "idle";
  currentStates = [];
  trackHeadlineById.clear();
  trackStageById.clear();
  sessionInputTokens = 0;
  sessionOutputTokens = 0;
  sessionCacheReadTokens = 0;
  sessionCacheWriteTokens = 0;
  trackTokensById.clear();
  selectedTrackId = null;
  subView = "steps";
  toolsFilterType = "all";
  toolsFilterOutcomes = new Set(["ok", "error", "pending"]);
  debugMode = false;
  clearLiveIteration();
  document.body.classList.remove("session-live");
  resetSessionActionButtons();
  // Ensure correct panel visibility for "All Tracks" default state
  tracksOverview.classList.remove("hidden");
  trackDetail.classList.add("hidden");
  debugPanelNew.classList.add("hidden");
  debugToggleBtn.classList.remove("active");
  trackTokenStats.classList.add("hidden");
  renderSessionSummary();
  renderTrackSidebar();
  renderActionBanner();
  renderTracksOverview();
  timelineIterations.innerHTML = "";
}

function renderSessionSummary(): void {
  const health = getSessionHealth();
  sessionStagePill.textContent = sessionStage;
  sessionHealthPill.textContent = health.label;
  sessionHealthPill.className = `health-pill ${health.tone}`.trim();
  sessionElapsed.textContent = formatElapsed(sessionStartedAt);

  runtimeHealthDot.className = `runtime-health-dot ${health.tone}`.trim();
  runtimeHealthLabel.textContent = health.label;
}

// ── Token tracking ────────────────────────────────────────────────────────────

const PRICE_TABLE: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku":  { input: 0.8, output: 4, cacheRead: 0.08 },
  "claude-opus":   { input: 15, output: 75, cacheRead: 1.5 },
  "gpt-4o":        { input: 5, output: 15, cacheRead: 0 },
  "gpt-4-turbo":   { input: 10, output: 30, cacheRead: 0 },
};

function estimateCost(inputTok: number, outputTok: number, cacheReadTok: number, model: string): string {
  const m = model.toLowerCase();
  const entry = Object.entries(PRICE_TABLE).find(([key]) => m.includes(key));
  const prices = entry ? entry[1] : { input: 3, output: 15, cacheRead: 0.3 };
  const cost = (inputTok * prices.input + outputTok * prices.output + cacheReadTok * prices.cacheRead) / 1_000_000;
  if (cost === 0) return "";
  return cost < 0.01 ? "<$0.01" : `~$${cost.toFixed(2)}`;
}

function accumulateTokens(turn: AgentTurnInfo): void {
  const existing = trackTokensById.get(turn.trackId) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  trackTokensById.set(turn.trackId, {
    input: existing.input + turn.inputTokens,
    output: existing.output + turn.outputTokens,
    cacheRead: existing.cacheRead + turn.cacheReadTokens,
    cacheWrite: existing.cacheWrite + turn.cacheWriteTokens,
  });
  sessionInputTokens += turn.inputTokens;
  sessionOutputTokens += turn.outputTokens;
  sessionCacheReadTokens += turn.cacheReadTokens;
  sessionCacheWriteTokens += turn.cacheWriteTokens;

  const costStr = estimateCost(sessionInputTokens, sessionOutputTokens, sessionCacheReadTokens, activeSessionModel);
  if (costStr) {
    sessionCost.textContent = costStr;
    sessionCost.style.display = "";
  }

  if (selectedTrackId === turn.trackId) renderTrackTokenStats(turn.trackId);
  renderTrackSidebar();
}

function renderTrackTokenStats(trackId: string): void {
  const toks = trackTokensById.get(trackId);
  if (!toks || (toks.input + toks.output) === 0) {
    trackTokenStats.classList.add("hidden");
    return;
  }
  const costStr = estimateCost(toks.input, toks.output, toks.cacheRead, activeSessionModel);
  trackTokenStats.classList.remove("hidden");
  trackTokenStats.innerHTML = `
    <span><strong>${fmtNum(toks.input)}</strong> in</span>
    <span><strong>${fmtNum(toks.output)}</strong> out</span>
    ${toks.cacheRead > 0 ? `<span><strong>${fmtNum(toks.cacheRead)}</strong> cache read</span>` : ""}
    ${toks.cacheWrite > 0 ? `<span><strong>${fmtNum(toks.cacheWrite)}</strong> cache write</span>` : ""}
    ${costStr ? `<span class="tok-cost">${costStr}</span>` : ""}
  `;
}

// ── Track sidebar ─────────────────────────────────────────────────────────────

function renderTracksContainer(): void {
  if (currentStates.length === 0 && activeSessionStatus !== "crashed" && activeSessionStatus !== "failed") {
    tracksContainer.innerHTML = `<p style="font-size:12px;color:var(--muted)">No active session</p>`;
    return;
  }
  tracksContainer.innerHTML = "";
  const allTracks = [
    { trackId: "orchestrator", status: activeSessionStatus === "crashed" || activeSessionStatus === "failed" ? "blocked" : "running", headline: sessionHeadlineText },
    ...currentStates.map((s) => ({ trackId: s.trackId, status: s.status, headline: trackHeadlineById.get(s.trackId) ?? s.hypothesis })),
  ];
  for (const { trackId, status, headline } of allTracks) {
    const card = document.createElement("div");
    card.className = "track-mini-card";
    card.innerHTML = `<span class="status-dot ${status}" style="flex-shrink:0"></span><div style="min-width:0"><div style="font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${trackId}</div><div style="font-size:10px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${headline}</div></div><span class="track-status-badge ${status}" style="font-size:10px;flex-shrink:0">${status}</span>`;
    tracksContainer.appendChild(card);
  }
}

function renderTrackSidebar(): void {
  renderTracksContainer();
  sidebarTrackList.innerHTML = "";

  // "All Tracks" entry
  const allItem = document.createElement("div");
  allItem.className = `sidebar-track-item ${selectedTrackId === null ? "active" : ""}`;
  const allDot = document.createElement("span");
  allDot.className = `status-dot ${activeSessionStatus === "running" ? "running" : activeSessionStatus === "crashed" || activeSessionStatus === "failed" ? "blocked" : ""}`;
  const allBody = document.createElement("div");
  allBody.className = "sidebar-track-body";
  allBody.innerHTML = `<div class="sidebar-track-name">All Tracks</div><div class="sidebar-track-stage">${currentStates.length} track${currentStates.length === 1 ? "" : "s"}</div>`;
  allItem.append(allDot, allBody);
  allItem.addEventListener("click", () => void setSelectedTrack(null));
  sidebarTrackList.appendChild(allItem);

  const divider = document.createElement("div");
  divider.className = "sidebar-divider";
  sidebarTrackList.appendChild(divider);

  // Orchestrator (always shown)
  const orchStatus = activeSessionStatus === "crashed" || activeSessionStatus === "failed" ? "blocked" : "running";
  sidebarTrackList.appendChild(buildSidebarItem("orchestrator", orchStatus, sessionHeadlineText));

  // Researcher tracks
  for (const state of currentStates) {
    const item = buildSidebarItem(state.trackId, state.status, trackStageById.get(state.trackId) ?? state.hypothesis);
    sidebarTrackList.appendChild(item);
  }
}

function buildSidebarItem(trackId: string, status: string, stageSummary: string): HTMLElement {
  const item = document.createElement("div");
  item.className = `sidebar-track-item ${selectedTrackId === trackId ? "active" : ""}`;

  const dot = document.createElement("span");
  dot.className = `status-dot ${status}`;

  const body = document.createElement("div");
  body.className = "sidebar-track-body";

  const nameEl = document.createElement("div");
  nameEl.className = "sidebar-track-name";
  nameEl.textContent = humanizeTrackTitle(trackId);

  const stageEl = document.createElement("div");
  stageEl.className = "sidebar-track-stage";
  stageEl.textContent = stageSummary.slice(0, 60);

  const footer = document.createElement("div");
  footer.className = "sidebar-track-footer";

  const statusEl = document.createElement("span");
  statusEl.className = `sidebar-track-status ${status}`;
  statusEl.textContent = status;

  const toks = trackTokensById.get(trackId);
  const totalTok = toks ? toks.input + toks.output : 0;
  if (totalTok > 0) {
    const tokEl = document.createElement("span");
    tokEl.className = "sidebar-track-tokens";
    tokEl.textContent = totalTok >= 1000 ? `${(totalTok / 1000).toFixed(1)}k tok` : `${totalTok} tok`;
    footer.append(statusEl, tokEl);
  } else {
    footer.append(statusEl);
  }

  body.append(nameEl, stageEl, footer);
  item.append(dot, body);
  item.addEventListener("click", () => void setSelectedTrack(trackId));
  return item;
}

// ── Track selection ───────────────────────────────────────────────────────────

async function setSelectedTrack(trackId: string | null): Promise<void> {
  selectedTrackId = trackId;
  renderTrackSidebar();

  if (trackId === null) {
    // Show "All Tracks" overview
    tracksOverview.classList.remove("hidden");
    trackDetail.classList.add("hidden");
    renderTracksOverview();
  } else {
    // Show per-track detail
    tracksOverview.classList.add("hidden");
    trackDetail.classList.remove("hidden");
    subView = "steps";
    toolsFilterType = "all";
    toolsTypeLabel.textContent = "All tools";
    toolsFilterOutcomes = new Set(["ok", "error", "pending"]);
    document.querySelectorAll<HTMLButtonElement>(".tools-outcome-toggle").forEach((b) => b.classList.add("active"));
    setSubView("steps");
    renderTrackTokenStats(trackId);
    timelineIterations.innerHTML = "";
    clearLiveIteration();
    if (activeSessionId) {
      const turns = await api.getAgentActivity(activeSessionId, trackId);
      renderUnifiedTimeline(trackId, turns);
    }
    // Sync for progress log
    activeTrackId = trackId;
    if (activeSessionStateDir) {
      const path = `${activeSessionStateDir}/research/${trackId}/progress.md`;
      const content = await api.readFile(path);
      if (content !== null) {
        progressLog.textContent = content;
      }
    }
  }
}

function setSubView(view: "steps" | "files" | "tools"): void {
  subView = view;
  stepsTab.classList.toggle("active", view === "steps");
  filesTab.classList.toggle("active", view === "files");
  toolsTab.classList.toggle("active", view === "tools");
  stepsPanel.classList.toggle("hidden", view !== "steps");
  filesPanel.classList.toggle("hidden", view !== "files");
  toolsPanel.style.display = view === "tools" ? "flex" : "none";
  if (view === "files" && selectedTrackId) {
    void loadTrackFiles(selectedTrackId);
  }
  if (view === "tools" && selectedTrackId && activeSessionId) {
    void loadToolsPanel(selectedTrackId);
  }
}

function toggleDebugMode(): void {
  debugMode = !debugMode;
  debugToggleBtn.classList.toggle("active", debugMode);
  debugPanelNew.classList.toggle("hidden", !debugMode);
  trackDetail.classList.toggle("hidden", debugMode || selectedTrackId === null);
  tracksOverview.classList.toggle("hidden", debugMode || selectedTrackId !== null);
}

// ── Tracks overview (All Tracks view) ────────────────────────────────────────

function renderTracksOverview(): void {
  tracksOverview.innerHTML = "";

  // Orchestrator card
  const orchCard = buildTrackOverviewCard("orchestrator", activeSessionStatus === "crashed" || activeSessionStatus === "failed" ? "blocked" : "running", sessionHeadlineText);
  tracksOverview.appendChild(orchCard);

  for (const state of currentStates) {
    const card = buildTrackOverviewCard(state.trackId, state.status, trackStageById.get(state.trackId) ?? state.hypothesis, state.updatedAt);
    tracksOverview.appendChild(card);
  }

  if (currentStates.length === 0) {
    const msg = document.createElement("p");
    msg.style.cssText = "grid-column:1/-1; padding:12px; font-size:12px; color:var(--muted)";
    msg.textContent = "Researcher tracks will appear here as the orchestrator creates them.";
    tracksOverview.appendChild(msg);
  }
}

function buildTrackOverviewCard(trackId: string, status: string, stageSummary: string, updatedAt?: string): HTMLElement {
  const toks = trackTokensById.get(trackId);
  const totalTok = toks ? toks.input + toks.output : 0;
  const tokStr = totalTok > 0 ? `${totalTok >= 1000 ? (totalTok / 1000).toFixed(1) + "k" : totalTok} tok` : "";

  const card = document.createElement("article");
  card.className = "track-overview-card";
  card.innerHTML = `
    <div class="track-overview-top">
      <div>
        <h4>${escHtml(humanizeTrackTitle(trackId))}</h4>
        <p>${escHtml(stageSummary.slice(0, 80))}</p>
      </div>
      <div class="track-status-pill ${status}">${status}</div>
    </div>
    <div class="track-overview-meta">
      ${updatedAt ? `<span>Updated ${formatRelativeTime(updatedAt)}</span>` : ""}
      ${tokStr ? `<span>${tokStr}</span>` : ""}
      <span>${escHtml(trackId)}</span>
    </div>
  `;
  card.addEventListener("click", () => void setSelectedTrack(trackId));
  return card;
}

// ── Action banner ─────────────────────────────────────────────────────────────

function renderActionBanner(): void {
  if (pendingInstall) {
    actionBanner.classList.remove("hidden");
    actionBanner.className = "action-banner warning";
    actionBanner.innerHTML = `
      <strong>Approval required</strong>
      <span>${escHtml(pendingInstall.justification.slice(0, 120))}</span>
      <div class="action-banner-actions">
        <button class="btn-sm btn-approve" id="banner-approve">Approve</button>
        <button class="btn-sm btn-deny" id="banner-deny">Deny</button>
      </div>
    `;
    actionBanner.querySelector("#banner-approve")?.addEventListener("click", () => {
      permJustification.textContent = pendingInstall!.justification;
      permCommand.textContent = pendingInstall!.command;
      permissionOverlay.classList.remove("hidden");
    });
    actionBanner.querySelector("#banner-deny")?.addEventListener("click", async () => {
      if (!pendingInstall) return;
      await api.resolveInstall(pendingInstall.trackId, false, pendingInstall);
      pendingInstall = null;
      renderActionBanner();
    });
    return;
  }

  const apiLimitEvent = runtimeEvents.find(e => e.kind === "error" && e.title === "API limit reached");
  if (apiLimitEvent) {
    actionBanner.classList.remove("hidden");
    actionBanner.className = "action-banner";
    actionBanner.innerHTML = `<strong>API limit reached</strong><span>${escHtml(apiLimitEvent.detail ?? apiLimitEvent.title)}</span>`;
    return;
  }

  const latest = runtimeEvents.at(-1);
  if (latest?.severity === "error") {
    actionBanner.classList.remove("hidden");
    actionBanner.className = "action-banner";
    actionBanner.innerHTML = `<strong>Error</strong><span>${escHtml(latest.detail ?? latest.title)}</span>`;
    return;
  }

  actionBanner.classList.add("hidden");
}

function applyRuntimeEvent(event: RuntimeEvent): void {
  runtimeEvents.push(event);

  if (event.kind === "session_started" && !sessionStartedAt) {
    sessionStartedAt = event.timestamp;
  }
  if (event.scope === "session") {
    sessionStage = event.stage ?? sessionStage;
    sessionHeadlineText = event.title;
    sessionLastUpdated = event.timestamp;
  }

  if (event.trackId) {
    trackHeadlineById.set(event.trackId, event.title);
    if (event.stage) {
      trackStageById.set(event.trackId, event.stage);
    }
  }

  renderSessionSummary();
  renderTrackSidebar();
  renderActionBanner();
  if (selectedTrackId === null) renderTracksOverview();
}

type DropdownController = {
  root: HTMLElement;
  close: () => void;
  setOptions: (options: readonly DropdownOption[], preferredValue?: string, emitChange?: boolean) => void;
  setValue: (value: string, emitChange?: boolean) => void;
};

const dropdowns = new Set<DropdownController>();

function createDropdown(config: {
  root: HTMLElement;
  input: HTMLInputElement;
  trigger: HTMLButtonElement;
  valueLabel: HTMLElement;
  metaLabel: HTMLElement;
  menu: HTMLElement;
  options: readonly DropdownOption[];
  onChange?: (value: string) => void;
}): DropdownController {
  let options = [...config.options];
  let controller: DropdownController;

  const optionButtons = (): HTMLButtonElement[] =>
    Array.from(config.menu.querySelectorAll<HTMLButtonElement>(".dropdown-option"));

  const close = (): void => {
    config.root.classList.remove("open");
    config.menu.classList.add("hidden");
    config.trigger.setAttribute("aria-expanded", "false");
  };

  const open = (): void => {
    for (const dropdown of dropdowns) {
      if (dropdown !== controller) dropdown.close();
    }
    config.root.classList.add("open");
    config.menu.classList.remove("hidden");
    config.trigger.setAttribute("aria-expanded", "true");
  };

  const render = (): void => {
    const selected = options.find((option) => option.value === config.input.value) ?? options[0];
    if (!selected) return;

    config.input.value = selected.value;
    config.valueLabel.textContent = selected.label;
    config.metaLabel.textContent = selected.description ?? "";

    config.menu.innerHTML = "";

    for (const option of options) {
      const button = document.createElement("button");
      const isSelected = option.value === config.input.value;

      button.type = "button";
      button.className = `dropdown-option${isSelected ? " selected" : ""}`;
      button.role = "option";
      button.dataset.value = option.value;
      button.setAttribute("aria-selected", String(isSelected));

      const copy = document.createElement("span");
      copy.className = "dropdown-option-main";

      const label = document.createElement("span");
      label.className = "dropdown-option-label";
      label.textContent = option.label;

      const description = document.createElement("span");
      description.className = "dropdown-option-description";
      description.textContent = option.description ?? "";

      const check = document.createElement("span");
      check.className = "dropdown-option-check";
      check.setAttribute("aria-hidden", "true");

      copy.append(label, description);
      button.append(copy, check);
      button.addEventListener("click", () => {
        setValue(option.value);
        close();
        config.trigger.focus();
      });

      config.menu.appendChild(button);
    }
  };

  const setValue = (value: string, emitChange = true): void => {
    const selected = options.find((option) => option.value === value);
    if (!selected) return;

    const changed = config.input.value !== selected.value;
    config.input.value = selected.value;
    render();

    if (changed && emitChange) {
      config.onChange?.(selected.value);
    }
  };

  const setOptions = (
    nextOptions: readonly DropdownOption[],
    preferredValue = config.input.value,
    emitChange = false,
  ): void => {
    options = [...nextOptions];
    const fallbackValue = options[0]?.value ?? "";
    const nextValue = options.some((option) => option.value === preferredValue) ? preferredValue : fallbackValue;
    setValue(nextValue, emitChange);
  };

  controller = {
    root: config.root,
    close,
    setOptions,
    setValue,
  };

  dropdowns.add(controller);

  config.trigger.addEventListener("click", () => {
    if (config.root.classList.contains("open")) {
      close();
      return;
    }

    open();
    const selectedButton =
      optionButtons().find((button) => button.dataset.value === config.input.value) ?? optionButtons()[0];
    selectedButton?.focus();
  });

  config.trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open();
    const buttons = optionButtons();
    const nextButton =
      buttons.find((button) => button.dataset.value === config.input.value) ??
      (event.key === "ArrowUp" ? buttons.at(-1) : buttons[0]);
    nextButton?.focus();
  });

  config.menu.addEventListener("keydown", (event) => {
    const buttons = optionButtons();
    const activeIndex = buttons.findIndex((button) => button === document.activeElement);

    if (event.key === "Escape") {
      event.preventDefault();
      close();
      config.trigger.focus();
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const startIndex = activeIndex === -1 ? 0 : activeIndex;
      const nextIndex = (startIndex + delta + buttons.length) % buttons.length;
      buttons[nextIndex]?.focus();
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const value = buttons[activeIndex]?.dataset.value;
      if (value) {
        setValue(value);
        close();
        config.trigger.focus();
      }
    }
  });

  render();
  return controller;
}

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Node)) return;

  for (const dropdown of dropdowns) {
    if (!dropdown.root.contains(target)) {
      dropdown.close();
    }
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  for (const dropdown of dropdowns) dropdown.close();
});

// ── Two-level model picker ──────────────────────────────────────────────────

const PROVIDER_ICONS: Record<Provider, string> = {
  openai: "◎",
  anthropic: "✳",
  openrouter: "⬡",
};

function createModelPicker(): void {
  const root = el("model-dropdown");
  const trigger = el<HTMLButtonElement>("model-trigger");
  const valueLabel = el("model-value");
  const metaLabel = el("model-meta");
  const menu = el("model-menu");

  let panel: "providers" | "models" = "providers";
  let browsingProvider: Provider | null = null;

  const close = (): void => {
    panel = "providers";
    browsingProvider = null;
    root.classList.remove("open");
    menu.classList.add("hidden");
    trigger.setAttribute("aria-expanded", "false");
  };

  const open = (): void => {
    for (const d of dropdowns) d.close();
    root.classList.add("open");
    menu.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    renderMenu();
  };

  // Register in shared dropdowns set so outside-click closes it
  dropdowns.add({ root, close, setOptions: () => undefined, setValue: () => undefined });

  const updateTrigger = (): void => {
    const model = (modelInput.value || DEFAULT_MODEL) as SupportedModel;
    const info = getModelInfo(model);
    const provider = getModelProvider(model);
    const status = getProviderStatus(provider);
    valueLabel.textContent = info.label;
    metaLabel.textContent = `${PROVIDERS.find((p) => p.value === provider)?.label ?? ""} · ${info.description} · ${getProviderStateLabel(status.state)}`;
  };

  const selectModel = (value: string): void => {
    modelInput.value = value;
    updateTrigger();
    refreshStartActionUI?.();
    const provider = getModelProvider(value as SupportedModel);
    if (getProviderStatus(provider).state !== "ready") {
      openProviderSetup(provider);
      renderMenu();
      refreshStartActionUI?.();
      return;
    }
    close();
    refreshStartActionUI?.();
  };

  const renderMenu = (): void => {
    menu.innerHTML = "";

    if (panel === "providers") {
      for (const p of PROVIDERS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dropdown-option";
        const currentProvider = getModelProvider((modelInput.value || DEFAULT_MODEL) as SupportedModel);
        const status = getProviderStatus(p.value);
        if (currentProvider === p.value) btn.classList.add("selected");

        const icon = document.createElement("span");
        icon.className = "dropdown-option-icon";
        icon.textContent = PROVIDER_ICONS[p.value];

        const main = document.createElement("span");
        main.className = "dropdown-option-main";
        const label = document.createElement("span");
        label.className = "dropdown-option-label";
        label.textContent = p.label;
        main.appendChild(label);

        const description = document.createElement("span");
        description.className = "dropdown-option-description";
        description.textContent = `${getProviderStateLabel(status.state)} · ${
          status.state === "ready" ? `Active ${getCredentialSourceLabel(status.activeSource ?? status.source ?? PROVIDER_CAPABILITIES[p.value].defaultSource)}` : "Open setup to continue"
        }`;
        main.appendChild(description);

        const chevron = document.createElement("span");
        chevron.className = "dropdown-option-chevron-right";
        chevron.setAttribute("aria-hidden", "true");

        btn.append(icon, main, chevron);
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          panel = "models";
          browsingProvider = p.value;
          renderMenu();
        });
        menu.appendChild(btn);
      }
    } else if (browsingProvider !== null) {
      // Back / header
      const back = document.createElement("button");
      back.type = "button";
      back.className = "dropdown-back";
      const backChevron = document.createElement("span");
      backChevron.className = "dropdown-back-chevron";
      back.append(backChevron, PROVIDERS.find((p) => p.value === browsingProvider)?.label ?? "");
      back.addEventListener("click", (e) => {
        e.stopPropagation();
        panel = "providers";
        browsingProvider = null;
        renderMenu();
      });
      menu.appendChild(back);

      const divider = document.createElement("div");
      divider.className = "dropdown-divider";
      menu.appendChild(divider);

      // Models for this provider
      const models = PROVIDER_MODELS[browsingProvider];
      for (const model of models) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dropdown-option";
        if (model.value === modelInput.value) btn.classList.add("selected");
        const providerStatus = getProviderStatus(browsingProvider);
        const modelProviderReady = providerStatus.state === "ready";

        const main = document.createElement("span");
        main.className = "dropdown-option-main";
        const labelEl = document.createElement("span");
        labelEl.className = "dropdown-option-label";
        labelEl.textContent = model.label;
        const descEl = document.createElement("span");
        descEl.className = "dropdown-option-description";
        descEl.textContent = modelProviderReady ? model.description : `${model.description} · ${getProviderStateLabel(providerStatus.state)}`;
        main.append(labelEl, descEl);

        const check = document.createElement("span");
        check.className = "dropdown-option-check";
        check.setAttribute("aria-hidden", "true");

        const badge = document.createElement("span");
        badge.className = `provider-status-badge ${providerStatus.state}`;
        badge.textContent = modelProviderReady ? "Ready" : getProviderStateLabel(providerStatus.state);

        btn.append(main, badge, check);
        btn.addEventListener("click", (e) => { e.stopPropagation(); selectModel(model.value); });
        menu.appendChild(btn);
      }
    }
  };

  trigger.addEventListener("click", () => {
    if (root.classList.contains("open")) { close(); return; }
    open();
  });

  trigger.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    open();
  });

  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); trigger.focus(); }
  });

  // The runtime default lives in TypeScript; do not trust static HTML defaults.
  modelInput.value = DEFAULT_MODEL;
  updateTrigger();
  refreshModelPickerUI = updateTrigger;
}

createModelPicker();
resetRuntimeState();
renderProviderAccess();
renderStartAction();
void refreshProviderStatuses();

// ── Session list ──────────────────────────────────────────────────────────────

function formatSessionDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
    d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function sessionStatusBadge(status: SessionInfo["status"]): string {
  const map: Record<string, string> = {
    running: "running",
    completed: "found",
    failed: "blocked",
    crashed: "blocked",
  };
  return map[status] ?? "running";
}

function renderSessionList(sessions: SessionInfo[]): void {
  sessionsList.innerHTML = "";
  if (sessions.length === 0) return;

  for (const s of sessions) {
    const card = document.createElement("div");
    card.className = "dashboard-card";
    card.style.cssText = "padding:14px 18px; cursor:pointer; display:flex; align-items:center; gap:12px";

    const statusDot = document.createElement("div");
    statusDot.className = `status-dot ${sessionStatusBadge(s.status)}`;
    statusDot.style.flexShrink = "0";

    const body = document.createElement("div");
    body.style.cssText = "flex:1; min-width:0";

    const titleRow = document.createElement("div");
    titleRow.style.cssText = "display:flex; align-items:center; gap:8px; margin-bottom:4px";

    const title = document.createElement("strong");
    title.style.cssText = "font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis";
    title.textContent = s.target;

    const badge = document.createElement("span");
    badge.className = `track-status-pill ${sessionStatusBadge(s.status)}`;
    badge.textContent = s.status;

    titleRow.append(title, badge);

    const meta = document.createElement("div");
    meta.style.cssText = "font-size:11px; color:var(--muted)";
    meta.textContent = `${s.trackCount} track${s.trackCount === 1 ? "" : "s"} · ${s.model} · ${formatSessionDate(s.createdAt)}`;

    body.append(titleRow, meta);

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex; gap:8px; flex-shrink:0";

    if (s.status === "crashed" || s.status === "running") {
      const resumeBtn = document.createElement("button");
      resumeBtn.className = "btn-primary btn-compact";
      resumeBtn.style.cssText = "padding:6px 12px; font-size:12px";
      resumeBtn.textContent = s.status === "crashed" ? "Resume" : "Attach";
      resumeBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        await attachOrResumeSession(s);
      });
      actions.appendChild(resumeBtn);
    }

    const viewBtn = document.createElement("button");
    viewBtn.className = "btn-secondary";
    viewBtn.style.cssText = "padding:6px 12px; font-size:12px";
    viewBtn.textContent = "View";
    viewBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      await openSession(s);
    });
    actions.appendChild(viewBtn);

    card.append(statusDot, body, actions);
    sessionsList.appendChild(card);
  }
}

async function attachOrResumeSession(s: SessionInfo): Promise<void> {
  activeSessionId = s.id;
  activeSessionStateDir = await api.getSessionStateDir(s.id);
  await api.setActiveSession(s.id);
  let nextSession = s;

  if (s.status === "crashed") {
    // Resume in background
    startBtn.disabled = true;
    startBtn.textContent = "Resuming...";
    const result = await api.resumeResearch(s.id);
    if ("error" in result) {
      alert(`Resume failed: ${result.error}`);
      startBtn.disabled = false;
      startBtn.textContent = "Start Research";
      return;
    }
    nextSession = { ...s, status: "running" };
  }

  await openSession(nextSession);
  // Re-launch polling and load events
  await replaySessionEvents(s.id);
  startPolling();
}

async function openSession(s: SessionInfo): Promise<void> {
  activeSessionId = s.id;
  activeSessionStateDir = await api.getSessionStateDir(s.id);
  activeSessionModel = s.model;
  await api.setActiveSession(s.id);

  resetRuntimeState();
  document.body.classList.add("session-live");
  applySessionActionButtons(s.status);
  activeTrackId = "orchestrator";
  activeTitle.textContent = s.target;
  sessionMaxTracksInput.value = String(s.maxTracks ?? 6);
  runtimeTarget.textContent = s.target;
  runtimeModel.textContent = s.model;
  runtimeBoxer.textContent = s.boxerUrl;
  runtimeSessionCard.classList.remove("hidden");
  runtimeHealthDot.className = "runtime-health-dot";
  runtimeHealthLabel.textContent = "Healthy";

  sessionsView.style.display = "none";
  welcome.style.display = "none";
  progressView.style.display = "";
  refreshStartActionUI?.();

  // Load persisted state for non-running sessions (completed/crashed/failed).
  // Running sessions get their state via startPolling(); here we do a one-shot load.
  if (s.status !== "running") {
    await replaySessionEvents(s.id);
    const states = await api.getProgress(s.id);
    currentStates = states;
    renderSessionSummary();
    renderTrackSidebar();
    if (selectedTrackId === null) renderTracksOverview();
  }
}

async function replaySessionEvents(sessionId: string): Promise<void> {
  try {
    const events = await api.getSessionEvents(sessionId);
    for (const e of events) {
      const runtimeEvent: RuntimeEvent = {
        id: e.id,
        timestamp: e.createdAt,
        scope: (e.trackId ? "track" : "session") as RuntimeEvent["scope"],
        kind: e.kind as RuntimeEvent["kind"],
        severity: e.severity as RuntimeEvent["severity"],
        title: e.title,
        detail: e.detail,
        stage: e.stage,
        trackId: e.trackId,
        status: e.status as RuntimeEvent["status"],
      };
      applyRuntimeEvent(runtimeEvent);
    }
  } catch {
    // Non-fatal — events just won't be replayed
  }
}

async function initSessionsView(): Promise<void> {
  const sessions = await api.listSessions();
  if (sessions.length === 0) {
    // No history — go straight to the brief form
    return;
  }
  renderSessionList(sessions);
  welcome.style.display = "none";
  sessionsView.style.display = "flex";
}

newSessionBtn.addEventListener("click", () => {
  sessionsView.style.display = "none";
  welcome.style.display = "";
});

backToSessionsBtn.addEventListener("click", async () => {
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  progressView.style.display = "none";
  activeSessionId = null;
  activeSessionStateDir = null;
  activeSessionModel = "";
  activeTrackId = null;
  resetRuntimeState();
  runtimeSessionCard.classList.add("hidden");
  setSessionConfigLocked(false);
  refreshStartActionUI?.();
  await initSessionsView();
});

stopSessionBtn.addEventListener("click", async () => {
  if (!activeSessionId) return;
  stopSessionBtn.disabled = true;
  stopSessionBtn.textContent = "Stopping…";
  const result = await api.stopResearch(activeSessionId);
  if ("error" in result) {
    alert(`Stop failed: ${result.error}`);
    stopSessionBtn.disabled = false;
    stopSessionBtn.textContent = "Stop";
    return;
  }
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  activeSessionStatus = "crashed";
  sessionStage = "Stopped";
  sessionHeadlineText = "Research session stopped";
  sessionLastUpdated = new Date().toISOString();
  pendingInstall = null;
  applySessionActionButtons("crashed");
  renderSessionSummary();
  renderTrackSidebar();
  renderActionBanner();
  if (selectedTrackId === null) renderTracksOverview();
});

resumeSessionBtn.addEventListener("click", async () => {
  if (!activeSessionId) return;
  const sid = activeSessionId;
  resumeSessionBtn.disabled = true;
  resumeSessionBtn.textContent = "Resuming…";
  const result = await api.resumeResearch(sid);
  if ("error" in result) {
    alert(`Resume failed: ${result.error}`);
    resumeSessionBtn.disabled = false;
    resumeSessionBtn.textContent = "Resume";
    return;
  }
  activeSessionStatus = "running";
  sessionStage = "Resuming";
  sessionHeadlineText = "Resuming research session";
  sessionLastUpdated = new Date().toISOString();
  pendingInstall = null;
  applySessionActionButtons("running");
  renderSessionSummary();
  renderTrackSidebar();
  renderActionBanner();
  if (selectedTrackId === null) renderTracksOverview();
  startPolling();
});

void initSessionsView();

sessionMaxTracksInput.addEventListener("change", () => {
  if (!activeSessionId) return;
  const v = Math.max(1, Math.min(20, parseInt(sessionMaxTracksInput.value, 10) || 6));
  sessionMaxTracksInput.value = String(v);
  void api.setMaxTracks(activeSessionId, v);
});

stepsTab.addEventListener("click", () => setSubView("steps"));
filesTab.addEventListener("click", () => setSubView("files"));
toolsTab.addEventListener("click", () => setSubView("tools"));

toolsTypeTrigger.addEventListener("click", () => {
  const isOpen = toolsTypeDropdown.classList.toggle("open");
  toolsTypeMenu.classList.toggle("hidden", !isOpen);
});

document.querySelectorAll<HTMLButtonElement>(".tools-outcome-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const outcome = btn.dataset["outcome"]!;
    if (toolsFilterOutcomes.has(outcome)) {
      toolsFilterOutcomes.delete(outcome);
      btn.classList.remove("active");
    } else {
      toolsFilterOutcomes.add(outcome);
      btn.classList.add("active");
    }
    if (selectedTrackId && activeSessionId) void loadToolsPanel(selectedTrackId);
  });
});
debugToggleBtn.addEventListener("click", () => toggleDebugMode());

// ── Provider access persistence ─────────────────────────────────────────────

refreshStartActionUI = renderStartAction;
providerSetupTarget = getSelectedProvider();

async function saveSelectedProviderCredential(): Promise<void> {
  const provider = providerSetupTarget ?? getSelectedProvider();
  const source = getProviderSetupSource(provider);
  const secret = isAuthSource(source) ? null : providerSecretInput.value.trim();

  providerSaveBtn.disabled = true;
  providerSaveBtn.textContent = "Saving…";
  providerSetupHint.textContent = "Validating and saving credential…";

  try {
    await api.saveProviderCredential(provider, source, secret);
    if (!isAuthSource(source)) {
      providerSecretInput.value = "";
    }
    await refreshProviderStatuses();
  } catch (error) {
    providerSetupHint.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    providerSaveBtn.disabled = false;
    providerSaveBtn.textContent = isAuthSource(source) ? `Save ${getCredentialSourceLabel(source)}` : "Save";
  }
}

async function testSelectedProviderCredential(): Promise<void> {
  const provider = providerSetupTarget ?? getSelectedProvider();
  const source = getProviderSetupSource(provider);
  const secret = isAuthSource(source) ? null : providerSecretInput.value.trim();

  providerTestBtn.disabled = true;
  providerTestBtn.textContent = "Testing…";
  providerSetupHint.textContent = "Testing credential…";

  try {
    const result = await api.testProviderCredential(provider, source, secret);
    providerSetupHint.textContent = result.ok
      ? `${getProviderLabel(provider)} ${getCredentialSourceLabel(source)} looks valid.`
      : result.errorMessage ?? "Validation failed.";
  } catch (error) {
    providerSetupHint.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    providerTestBtn.disabled = false;
    providerTestBtn.textContent = isAuthSource(source) ? "Test login" : "Test";
  }
}

async function deleteSelectedProviderCredential(): Promise<void> {
  const provider = providerSetupTarget ?? getSelectedProvider();
  const source = getProviderSetupSource(provider);

  providerDeleteBtn.disabled = true;
  providerDeleteBtn.textContent = "Deleting…";
  providerSetupHint.textContent = "Removing credential…";

  try {
    await api.deleteProviderCredential(provider, source);
    providerSecretInput.value = "";
    await refreshProviderStatuses();
  } catch (error) {
    providerSetupHint.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    providerDeleteBtn.disabled = false;
    providerDeleteBtn.textContent = isAuthSource(source) ? "Clear login" : "Delete";
  }
}

providerTestBtn.addEventListener("click", () => {
  void testSelectedProviderCredential();
});

providerSaveBtn.addEventListener("click", () => {
  void saveSelectedProviderCredential();
});

providerDeleteBtn.addEventListener("click", () => {
  void deleteSelectedProviderCredential();
});

// ── Form handlers ────────────────────────────────────────────────────────────

el("pick-code").addEventListener("click", async () => {
  const path = await api.pickFile([{ name: "All", extensions: ["*"] }]);
  if (path) el<HTMLInputElement>("code-path").value = path;
});

maxTracksInput.addEventListener("input", () => {
  maxTracksLabel.textContent = maxTracksInput.value;
});

startBtn.addEventListener("click", async () => {
  const target = targetInput.value.trim();
  const goal = goalInput.value.trim();
  const scope = scopeInput.value.trim();
  const boxerUrl = boxerUrlInput.value.trim();
  const model = modelInput.value.trim() || DEFAULT_MODEL;

  if (!target || !goal || !scope) {
    alert("Target, Goal, and Scope are required.");
    return;
  }

  if (!model) {
    alert("Model is required.");
    return;
  }

  const codePath = codePathInput.value.trim();
  const links = linksInput.value.trim();
  const context = contextInput.value.trim();

  const briefContent = [
    `TARGET: ${target}`,
    `SCOPE: ${scope}`,
    codePath && `CODE: ${codePath}`,
    links && `LINKS: ${links}`,
    context && `CONTEXT: ${context}`,
    `GOAL: ${goal}`,
  ]
    .filter(Boolean)
    .join("\n");

  const briefPath = await api.writeBrief(briefContent);

  startBtn.disabled = true;
  startBtn.textContent = "Starting...";
  setSessionConfigLocked(true);
  resetRuntimeState();
  sessionsView.style.display = "none";
  document.body.classList.add("session-live");
  applySessionActionButtons("running");
  activeTrackId = "orchestrator";
  activeTitle.textContent = "orchestrator";
  progressLog.textContent = "";
  runtimeTarget.textContent = target;
  runtimeModel.textContent = getModelInfo(model as SupportedModel).label;
  runtimeBoxer.textContent = boxerUrl;
  runtimeHealthLabel.textContent = "Preparing";
  runtimeSessionCard.classList.remove("hidden");

  const maxTracks = parseInt(maxTracksInput.value, 10) || 6;
  sessionMaxTracksInput.value = String(maxTracks);
  const result = await api.startResearch(briefPath, boxerUrl, model, maxTracks);
  if (result.sessionId) {
    activeSessionId = result.sessionId;
    activeSessionStateDir = await api.getSessionStateDir(result.sessionId);
  }
  startPolling();

  welcome.style.display = "none";
  progressView.style.display = "";
  startBtn.textContent = "Research Running";
});

function startPolling(): void {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(poll, 1000);
  void poll();
}

async function poll(): Promise<void> {
  const [states, pendingInstalls] = await Promise.all([
    api.getProgress(activeSessionId ?? undefined),
    api.getPendingInstalls(activeSessionId ?? undefined),
  ]);

  currentStates = states;
  renderSessionSummary();
  renderTrackSidebar();
  renderActionBanner();
  if (selectedTrackId === null) renderTracksOverview();

  // Re-read progress log when debug mode active
  if (debugMode && activeTrackId && activeSessionStateDir) {
    const path = `${activeSessionStateDir}/research/${activeTrackId}/progress.md`;
    const content = await api.readFile(path);
    if (content !== null && content !== progressLog.textContent) {
      progressLog.textContent = content;
      progressLog.scrollTop = progressLog.scrollHeight;
    }
  }

  if (pendingInstalls.length > 0 && !pendingInstall) {
    const install = pendingInstalls[0];
    if (install) showPermissionPrompt(install);
  }
}


function showPermissionPrompt(install: PendingInstall): void {
  pendingInstall = install;
  permJustification.textContent = install.justification;
  permCommand.textContent = install.command;
  permissionOverlay.classList.remove("hidden");
}

permApprove.addEventListener("click", async () => {
  if (!pendingInstall) return;
  await api.resolveInstall(pendingInstall.trackId, true, pendingInstall);
  pendingInstall = null;
  permissionOverlay.classList.add("hidden");
});

permDeny.addEventListener("click", async () => {
  if (!pendingInstall) return;
  await api.resolveInstall(pendingInstall.trackId, false, pendingInstall);
  pendingInstall = null;
  permissionOverlay.classList.add("hidden");
});

// ── Unified timeline ──────────────────────────────────────────────────────────

// Live iteration helpers
function clearLiveIteration(): void {
  liveIterationEl?.remove();
  liveIterationEl = null;
  liveThinkingStreamEl = null;
  liveThinkingTextEl = null;
}

function ensureLiveIteration(): void {
  if (liveIterationEl) return;
  const live = document.createElement("div");
  live.className = "live-iteration";
  const header = document.createElement("div");
  header.className = "live-iteration-header";
  const dot = document.createElement("span");
  dot.className = "live-dot";
  const label = document.createElement("span");
  label.textContent = "Live";
  header.append(dot, label);
  const stream = document.createElement("div");
  stream.className = "live-thinking-stream hidden";
  const streamLabel = document.createElement("span");
  streamLabel.className = "thinking-label-sm";
  streamLabel.textContent = "thinking";
  const streamText = document.createElement("span");
  streamText.className = "live-thinking-stream-text";
  stream.append(streamLabel, streamText);
  live.append(header, stream);
  stepsPanel.appendChild(live);
  liveIterationEl = live;
  liveThinkingStreamEl = stream;
  liveThinkingTextEl = streamText;
}

function renderUnifiedTimeline(trackId: string, turns: AgentTurnInfo[]): void {
  if (turns.length === 0) {
    timelineIterations.innerHTML = '<div class="timeline-empty">No activity recorded yet. The agent will appear here once it starts working.</div>';
    return;
  }

  const byIter = new Map<number, AgentTurnInfo[]>();
  for (const t of turns) {
    if (!byIter.has(t.iteration)) byIter.set(t.iteration, []);
    byIter.get(t.iteration)!.push(t);
  }

  const prevScrollTop = stepsPanel.scrollTop;
  const wasAtBottom = stepsPanel.scrollHeight - stepsPanel.scrollTop - stepsPanel.clientHeight < 80;

  // Remove old content but keep live iteration if present
  const liveEl = liveIterationEl;
  timelineIterations.innerHTML = "";

  for (const [iter, iterTurns] of [...byIter.entries()].sort(([a], [b]) => a - b)) {
    const iterToolCount = iterTurns.reduce((s, t) => s + t.toolCalls.length, 0);
    const lastTurn = iterTurns.at(-1);
    const timeStr = lastTurn?.completedAt ? formatRelativeTime(lastTurn.completedAt) : "in progress";

    const iterEl = document.createElement("div");
    iterEl.className = "activity-iteration";

    const header = document.createElement("div");
    header.className = "iteration-header";
    header.innerHTML = `
      <span class="iteration-chevron"></span>
      <span class="iteration-label">Iter ${iter}</span>
      <span class="iteration-meta">${iterToolCount} tool${iterToolCount === 1 ? "" : "s"} · ${timeStr}</span>
    `;

    const body = document.createElement("div");
    body.className = "iteration-body";

    header.addEventListener("click", () => {
      header.classList.toggle("collapsed");
      body.classList.toggle("hidden");
    });

    for (const turn of iterTurns) {
      // Thinking block
      if (turn.thinkingText) {
        const preview = turn.thinkingText.slice(0, 120);
        const hasMore = turn.thinkingText.length > 120;

        const thinkRow = document.createElement("div");
        thinkRow.className = "thinking-row";
        thinkRow.innerHTML = `
          <span class="thinking-toggle-chevron">▸</span>
          <span class="thinking-label-sm">thinking</span>
          <span class="thinking-preview-text">${escHtml(preview)}${hasMore ? "…" : ""}</span>
          ${hasMore ? `<span class="thinking-char-count">${turn.thinkingText.length} chars</span>` : ""}
        `;

        const thinkExpanded = document.createElement("div");
        thinkExpanded.className = "thinking-expanded hidden";
        thinkExpanded.textContent = turn.thinkingText;

        thinkRow.addEventListener("click", () => {
          const isExpanded = !thinkExpanded.classList.contains("hidden");
          thinkExpanded.classList.toggle("hidden");
          const chevron = thinkRow.querySelector<HTMLElement>(".thinking-toggle-chevron");
          if (chevron) chevron.textContent = isExpanded ? "▸" : "▾";
        });

        body.append(thinkRow, thinkExpanded);
      }

      // Tool calls
      for (const tc of turn.toolCalls) {
        const summary = summarizeToolInput(tc.toolName, tc.toolInput);
        const badgeClass = toolBadgeClass(tc.toolName);
        const outcome = tc.outcome === "pending" ? "⋯" : tc.outcome === "ok" ? "✓" : "✗";
        const outcomeClass = tc.outcome === "pending" ? "pending" : tc.outcome === "ok" ? "ok" : "error";

        const row = document.createElement("div");
        row.className = "tool-row";
        row.innerHTML = `
          <span class="tool-badge ${badgeClass}">${escHtml(tc.toolName)}</span>
          <span class="tool-summary">${escHtml(summary)}</span>
          <span class="tool-duration">${tc.elapsedMs > 0 ? fmtMs(tc.elapsedMs) : ""}</span>
          <span class="tool-outcome ${outcomeClass}">${outcome}</span>
        `;

        const detail = document.createElement("div");
        detail.className = "tool-detail";
        detail.innerHTML = `
          <div class="tool-detail-section">
            <div class="tool-detail-label">Input</div>
            <div class="tool-detail-code">${escHtml(tc.toolInput)}</div>
          </div>
          ${tc.toolOutput ? `<div class="tool-detail-section">
            <div class="tool-detail-label">Output</div>
            <div class="tool-detail-code">${escHtml(tc.toolOutput.slice(0, 4096))}</div>
          </div>` : ""}
        `;

        row.addEventListener("click", () => row.classList.toggle("expanded"));
        body.append(row, detail);
      }

      // Text output
      if (turn.textOutput) {
        const textEl = document.createElement("div");
        textEl.className = "turn-text-output";
        textEl.textContent = turn.textOutput;
        body.appendChild(textEl);
      }
    }

    iterEl.append(header, body);
    timelineIterations.appendChild(iterEl);
  }

  // Re-attach live iteration if it existed
  if (liveEl) stepsPanel.appendChild(liveEl);

  if (wasAtBottom) {
    stepsPanel.scrollTop = stepsPanel.scrollHeight;
  } else {
    stepsPanel.scrollTop = prevScrollTop;
  }
}

// ── Files panel ───────────────────────────────────────────────────────────────

async function loadTrackFiles(trackId: string): Promise<void> {
  if (!activeSessionId) return;
  fileList.innerHTML = '<div class="file-empty">Loading files…</div>';
  fileViewer.classList.add("hidden");
  try {
    const files = await api.listTrackFiles(activeSessionId, trackId);
    renderFileList(files);
  } catch {
    fileList.innerHTML = '<div class="file-empty">Could not load files.</div>';
  }
}

function renderFileList(files: TrackFileInfo[]): void {
  fileList.innerHTML = "";
  if (files.length === 0) {
    fileList.innerHTML = '<div class="file-empty">No files created yet.</div>';
    return;
  }

  const groups = new Map<string, TrackFileInfo[]>();
  for (const f of files) {
    const parts = f.relativePath.split("/");
    const dir = parts.slice(0, -1).join("/") || ".";
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir)!.push(f);
  }

  for (const [dir, groupFiles] of groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "file-group";
    const headerEl = document.createElement("div");
    headerEl.className = "file-group-header";
    headerEl.textContent = dir;
    groupEl.appendChild(headerEl);

    for (const f of groupFiles) {
      const name = f.relativePath.split("/").at(-1) ?? f.relativePath;
      const sizeStr = f.size < 1024 ? `${f.size} B` : `${(f.size / 1024).toFixed(1)} KB`;
      const row = document.createElement("div");
      row.className = "file-row";
      row.innerHTML = `
        <span class="file-name">${escHtml(name)}</span>
        <span class="file-meta">${sizeStr} · ${formatRelativeTime(f.mtime)}</span>
        <button class="file-view-btn btn-sm">View</button>
      `;
      row.querySelector(".file-view-btn")?.addEventListener("click", () => void openFileView(f));
      groupEl.appendChild(row);
    }
    fileList.appendChild(groupEl);
  }
}

// ── Tools panel ──────────────────────────────────────────────────────────────

async function loadToolsPanel(trackId: string): Promise<void> {
  if (!activeSessionId) return;
  toolsList.innerHTML = '<div class="timeline-empty">Loading…</div>';
  const turns = await api.getAgentActivity(activeSessionId, trackId);
  renderToolsPanel(turns);
}

function buildToolsTypeDropdown(toolNames: string[]): void {
  toolsTypeMenu.innerHTML = "";
  const options = ["all", ...toolNames];
  for (const name of options) {
    const btn = document.createElement("button");
    btn.className = `dropdown-option${toolsFilterType === name ? " selected" : ""}`;
    btn.type = "button";
    btn.textContent = name === "all" ? "All tools" : name;
    btn.addEventListener("click", () => {
      toolsFilterType = name;
      toolsTypeLabel.textContent = name === "all" ? "All tools" : name;
      toolsTypeMenu.classList.add("hidden");
      toolsTypeDropdown.classList.remove("open");
      if (selectedTrackId && activeSessionId) void loadToolsPanel(selectedTrackId);
    });
    toolsTypeMenu.appendChild(btn);
  }
}

function renderToolsPanel(turns: AgentTurnInfo[]): void {
  const allCalls: Array<{ tc: AgentTurnInfo["toolCalls"][0]; iter: number }> = [];
  for (const turn of turns) {
    for (const tc of turn.toolCalls) {
      allCalls.push({ tc, iter: turn.iteration });
    }
  }

  const toolNames = [...new Set(allCalls.map(({ tc }) => tc.toolName))].sort();
  buildToolsTypeDropdown(toolNames);

  const visible = allCalls.filter(({ tc }) => {
    if (toolsFilterType !== "all" && tc.toolName !== toolsFilterType) return false;
    if (!toolsFilterOutcomes.has(tc.outcome)) return false;
    return true;
  });

  toolsCallCount.textContent = `${visible.length} call${visible.length !== 1 ? "s" : ""}`;
  toolsList.innerHTML = "";

  if (allCalls.length === 0) {
    toolsList.innerHTML = '<div class="timeline-empty">No tool calls recorded yet.</div>';
    return;
  }

  if (visible.length === 0) {
    toolsList.innerHTML = '<div class="timeline-empty">No tool calls match the current filter.</div>';
    return;
  }

  for (const { tc, iter } of visible) {
    const badgeClass = toolBadgeClass(tc.toolName);
    const summary = summarizeToolInput(tc.toolName, tc.toolInput);
    const outcomeKey: "ok" | "error" | "pending" =
      tc.outcome === "ok" ? "ok" : tc.outcome === "error" ? "error" : "pending";

    const row = document.createElement("div");
    row.className = `tools-row ${badgeClass}`;
    row.innerHTML = `
      <span class="tool-badge ${badgeClass}">${escHtml(tc.toolName)}</span>
      <span class="tool-summary">${escHtml(summary)}</span>
      <span class="tools-row-meta">
        <span class="tools-iter-label">iter ${iter}</span>
        <span class="tools-duration">${tc.elapsedMs > 0 ? fmtMs(tc.elapsedMs) : ""}</span>
        <span class="tools-outcome-chip ${outcomeKey}">${outcomeKey}</span>
      </span>
    `;

    const detail = document.createElement("div");
    detail.className = "tool-detail";
    detail.innerHTML = `
      <div class="tool-detail-section">
        <div class="tool-detail-label">Input</div>
        <div class="tool-detail-code">${escHtml(tc.toolInput)}</div>
      </div>
      ${tc.toolOutput ? `<div class="tool-detail-section">
        <div class="tool-detail-label">Output</div>
        <div class="tool-detail-code">${escHtml(tc.toolOutput.slice(0, 4096))}</div>
      </div>` : ""}
    `;

    row.addEventListener("click", () => row.classList.toggle("expanded"));
    toolsList.append(row, detail);
  }
}

async function openFileView(file: TrackFileInfo): Promise<void> {
  const content = await api.readFile(file.path);
  if (content === null) return;
  fileViewer.classList.remove("hidden");
  fileViewer.innerHTML = `
    <div class="file-viewer-header">
      <span class="file-viewer-path">${escHtml(file.relativePath)}</span>
      <button class="btn-sm file-viewer-close">Close</button>
    </div>
    <pre class="file-viewer-content">${escHtml(content)}</pre>
  `;
  fileViewer.querySelector(".file-viewer-close")?.addEventListener("click", () => {
    fileViewer.classList.add("hidden");
  });
  fileViewer.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function agentRole(trackId: string): string {
  if (trackId === "orchestrator") return "orchestrator";
  if (trackId === "reporter") return "reporter";
  return "researcher";
}

function toolBadgeClass(toolName: string): string {
  const n = toolName.toLowerCase();
  if (n === "bash") return "bash";
  if (n === "read" || n === "write" || n === "edit") return n;
  if (n === "glob" || n === "grep") return n;
  if (n === "webfetch" || n === "websearch") return n;
  return "";
}

function summarizeToolInput(toolName: string, input: string): string {
  try {
    const parsed = JSON.parse(input) as Record<string, unknown>;
    const n = toolName.toLowerCase();
    if (n === "bash") return String(parsed["command"] ?? input).slice(0, 120);
    if (n === "read") return String(parsed["file_path"] ?? parsed["path"] ?? input).slice(0, 120);
    if (n === "write" || n === "edit") return String(parsed["file_path"] ?? parsed["path"] ?? input).slice(0, 120);
    if (n === "webfetch" || n === "websearch") return String(parsed["url"] ?? parsed["query"] ?? input).slice(0, 120);
    if (n === "glob") return String(parsed["pattern"] ?? input).slice(0, 120);
    if (n === "grep") return String(parsed["pattern"] ?? input).slice(0, 120);
    return input.slice(0, 120);
  } catch {
    return input.slice(0, 120);
  }
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ── Live streaming: append text chunks as they arrive from the agent ──────────
api.onResearchLog((trackId: string, text: string) => {
  if (trackId === activeTrackId) {
    progressLog.textContent = (progressLog.textContent ?? "") + text;
    progressLog.scrollTop = progressLog.scrollHeight;
  }
});

api.onRuntimeEvent((event: RuntimeEvent) => {
  applyRuntimeEvent(event);
});

// Add manual API limit test for debugging
(window as any).testApiLimit = () => {
  const testEvent: RuntimeEvent = {
    id: `test-${Date.now()}`,
    timestamp: new Date().toISOString(),
    scope: "session",
    kind: "error",
    severity: "error",
    title: "API limit reached",
    detail: "Test API limit detection - this should show red alert",
    stage: "API Limit",
  };
  applyRuntimeEvent(testEvent);
  console.log("🧪 Test API limit event sent");
};

api.onAgentThinking((event: AgentThinkingEvent) => {
  if (event.trackId !== selectedTrackId) return;
  if (subView !== "steps") return;
  ensureLiveIteration();
  if (liveThinkingStreamEl) liveThinkingStreamEl.classList.remove("hidden");
  if (liveThinkingTextEl) {
    liveThinkingTextEl.textContent = (liveThinkingTextEl.textContent ?? "") + event.thinking;
    liveThinkingTextEl.scrollTop = liveThinkingTextEl.scrollHeight;
  }
});

api.onAgentTurn((event: AgentTurnEvent) => {
  accumulateTokens(event.turn);
  clearLiveIteration();
  if (event.trackId === selectedTrackId && activeSessionId) {
    if (subView === "steps") {
      void api.getAgentActivity(activeSessionId, event.trackId).then((turns) => {
        renderUnifiedTimeline(event.trackId, turns);
      });
    } else if (subView === "tools") {
      void api.getAgentActivity(activeSessionId, event.trackId).then((turns) => {
        renderToolsPanel(turns);
      });
    }
  }
});

api.onAgentToolProgress((_event: AgentToolProgressEvent) => {
  // no-op for now — could show a live timer on the pending tool row
});

api.onResearchError((err: string) => {
  console.error("Research error:", err);
  startBtn.disabled = false;
  startBtn.textContent = "Start Research";
  setSessionConfigLocked(false);
  document.body.classList.remove("session-live");
  applySessionActionButtons("failed");
  sessionStage = "Failed";
  sessionHeadlineText = "Research session failed";
  sessionLastUpdated = new Date().toISOString();
  renderSessionSummary();
  renderActionBanner();
  alert(`Research error: ${err}`);
});

(window as Window & {
  __bugBountyTest?: {
    simulateStoppedSessionUi: () => void;
  };
}).__bugBountyTest = {
  simulateStoppedSessionUi: () => {
    document.body.classList.add("session-live");
    progressView.style.display = "";
    sessionsView.style.display = "none";
    welcome.style.display = "none";
    activeSessionStatus = "crashed";
    sessionStage = "Stopped";
    sessionHeadlineText = "Research session stopped";
    sessionLastUpdated = new Date().toISOString();
    const now = new Date().toISOString();
    currentStates = [{
      trackId: "orchestrator",
      status: "blocked",
      hypothesis: "Research session stopped",
      startedAt: now,
      updatedAt: now,
    }];
    trackHeadlineById.set("orchestrator", "Research session stopped");
    pendingInstall = null;
    applySessionActionButtons("crashed");
    renderTrackSidebar();
    renderSessionSummary();
    renderTracksOverview();
    renderActionBanner();
  },
};
