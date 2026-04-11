/**
 * Renderer process — UI logic.
 * Communicates with main process via window.bugBounty (preload bridge).
 */

import type { BugBountyAPI, SessionInfo, AgentTurnInfo } from "../preload.js";
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
const sessionStagePill = el("session-stage-pill");
const sessionHealthPill = el("session-health-pill");
const sessionLastActivity = el("session-last-activity");
const sessionUpdatedAt = el("session-updated-at");
const sessionHeadline = el("session-headline");
const sessionDetail = el("session-detail");
const sessionElapsed = el("session-elapsed");
const sessionActivityState = el("session-activity-state");
const sessionTrackCount = el("session-track-count");
const sessionActionState = el("session-action-state");
const overviewSubtitle = el("overview-subtitle");
const overviewTrackCaption = el("overview-track-caption");
const actionCenterCaption = el("action-center-caption");
const milestoneList = el("milestone-list");
const overviewTrackGrid = el("overview-track-grid");
const actionCenter = el("action-center");
const overviewTab = el<HTMLButtonElement>("overview-tab");
const tracksTab = el<HTMLButtonElement>("tracks-tab");
const activityTab = el<HTMLButtonElement>("activity-tab");
const reasoningTab = el<HTMLButtonElement>("reasoning-tab");
const debugTab = el<HTMLButtonElement>("debug-tab");
const overviewPanel = el("overview-panel");
const tracksPanel = el("tracks-panel");
const activityPanel = el("activity-panel");
const reasoningPanel = el("reasoning-panel");
const debugPanel = el("debug-panel");
// Activity panel elements
const activityAgentBadge = el("activity-agent-badge");
const activityAgentName = el("activity-agent-name");
const activityStats = el("activity-stats");
const activityEmpty = el("activity-empty");
const activityIterations = el("activity-iterations");
// Reasoning panel elements
const reasoningAgentBadge = el("reasoning-agent-badge");
const reasoningAgentName = el("reasoning-agent-name");
const tokenTotals = el("token-totals");
const reasoningEmpty = el("reasoning-empty");
const reasoningTurns = el("reasoning-turns");
const liveThinking = el("live-thinking");
const liveThinkingText = el("live-thinking-text");
const tracksGrid = el("tracks-grid");
const tracksPanelCaption = el("tracks-panel-caption");
const progressLog = el("progress-log");
const activeTitle = el("active-track-title");
const activeStatusDot = el("active-status-dot");
const permissionOverlay = el("permission-overlay");
const permJustification = el("perm-justification");
const permCommand = el("perm-command");
const permApprove = el<HTMLButtonElement>("perm-approve");
const permDeny = el<HTMLButtonElement>("perm-deny");
const modelInput = el<HTMLInputElement>("model-name");
const maxTracksInput = el<HTMLInputElement>("max-tracks");
const maxTracksLabel = el("max-tracks-label");
const runtimeSessionCard = el("runtime-session-card");
const runtimeHealthDot = el("runtime-health-dot");
const runtimeTarget = el("runtime-target");
const runtimeModel = el("runtime-model");
const runtimeBoxer = el("runtime-boxer");
const runtimeHealthLabel = el("runtime-health-label");
const stageRail = el("stage-rail");
const backToSessionsBtn = el<HTMLButtonElement>("back-to-sessions");
const stopSessionBtn = el<HTMLButtonElement>("stop-session-btn");
const resumeSessionBtn = el<HTMLButtonElement>("resume-session-btn");

let activeSessionId: string | null = null;
let activeSessionStateDir: string | null = null;
let activeTrackId: string | null = null;
let pendingInstall: PendingInstall | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let activeView: "overview" | "tracks" | "activity" | "reasoning" | "debug" = "overview";
let activityTrackId: string | null = null;
let activityPollInterval: ReturnType<typeof setInterval> | null = null;
let runtimeEvents: RuntimeEvent[] = [];
let sessionStage = "Starting";
let sessionHeadlineText = "Preparing session...";
let sessionDetailText = "Live runtime updates will appear here.";
let sessionLastUpdated: string | null = null;
let sessionStartedAt: string | null = null;
let currentStates: TrackState[] = [];
const trackHeadlineById = new Map<string, string>();
const trackStageById = new Map<string, string>();
let milestoneEvents: RuntimeEvent[] = [];
const milestoneSignatures: string[] = [];
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
  return "Enter the credential, test it, and save it to unlock this provider.";
}

function getProviderSourcePlaceholder(provider: Provider, source: CredentialSource): string {
  if (provider === "openai") return "sk-...";
  if (provider === "openrouter") return "sk-or-...";
  if (source === "claude_auth") return "No API key needed";
  return "sk-ant-...";
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
  if (source === "claude_auth") {
    providerSecretInput.value = "";
  }
  providerSecretInput.placeholder = getProviderSourcePlaceholder(provider, source);
  providerSecretField.classList.toggle("hidden", source === "claude_auth");

  providerSetupHint.textContent =
    status.state === "ready"
      ? `Active source: ${sourceLabel}. Last validated ${status.lastValidatedAt ? formatRelativeTime(status.lastValidatedAt) : "just now"}.`
      : activeStatus?.errorMessage ?? (source === "claude_auth"
          ? "No Claude auth session is saved yet."
          : `No ${sourceLabel} is saved yet.`);

  providerTestBtn.textContent = source === "claude_auth" ? "Test auth" : "Test";
  providerSaveBtn.textContent = source === "claude_auth" ? `Save ${sourceLabel}` : "Save";
  providerDeleteBtn.textContent = source === "claude_auth" ? "Clear auth" : "Delete";
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

function stageKeyForStage(stage: string): string {
  const normalized = stage.toLowerCase();
  if (normalized.includes("brief") || normalized.includes("preparing") || normalized.includes("loading")) return "brief";
  if (normalized.includes("surface") || normalized.includes("attack")) return "surface";
  if (normalized.includes("launching") || normalized.includes("track")) return "tracks";
  if (normalized.includes("research") || normalized.includes("investigat") || normalized.includes("waiting")) return "research";
  if (normalized.includes("report")) return "report";
  return "brief";
}

function milestoneSignature(event: RuntimeEvent): string {
  return `${event.kind}|${event.scope}|${event.trackId ?? "session"}|${event.title}|${event.detail ?? ""}|${event.stage ?? ""}`;
}

function isMilestoneEvent(event: RuntimeEvent): boolean {
  return (
    event.kind === "session_started" ||
    event.kind === "track_created" ||
    event.kind === "track_status_changed" ||
    event.kind === "permission_required" ||
    event.kind === "error" ||
    event.kind === "session_completed" ||
    (event.kind === "stage_changed" && !event.stage?.toLowerCase().includes("generating output")) ||
    (event.kind === "waiting" && event.scope === "session")
  );
}

function resetRuntimeState(): void {
  runtimeEvents = [];
  milestoneEvents = [];
  milestoneSignatures.length = 0;
  sessionStage = "Starting";
  sessionHeadlineText = "Preparing session...";
  sessionDetailText = "Live runtime updates will appear here.";
  sessionLastUpdated = null;
  sessionStartedAt = null;
  currentStates = [];
  trackHeadlineById.clear();
  trackStageById.clear();
  document.body.classList.remove("session-live");
  renderSessionSummary();
  renderStageRail();
  renderMilestones();
  renderOverviewTrackGrid();
  renderTracksGrid();
  renderActionCenter();
}

function setActiveView(view: "overview" | "tracks" | "activity" | "reasoning" | "debug"): void {
  activeView = view;
  overviewTab.classList.toggle("active", view === "overview");
  tracksTab.classList.toggle("active", view === "tracks");
  activityTab.classList.toggle("active", view === "activity");
  reasoningTab.classList.toggle("active", view === "reasoning");
  debugTab.classList.toggle("active", view === "debug");
  overviewPanel.classList.toggle("hidden", view !== "overview");
  tracksPanel.classList.toggle("hidden", view !== "tracks");
  activityPanel.classList.toggle("hidden", view !== "activity");
  reasoningPanel.classList.toggle("hidden", view !== "reasoning");
  debugPanel.classList.toggle("hidden", view !== "debug");

  if ((view === "activity" || view === "reasoning") && activeSessionId) {
    const trackId = activityTrackId ?? "orchestrator";
    void loadAgentActivity(trackId);
    if (view === "activity") startActivityPolling(trackId);
    else stopActivityPolling();
  } else {
    stopActivityPolling();
  }
}

function renderSessionSummary(): void {
  const health = getSessionHealth();
  sessionStagePill.textContent = sessionStage;
  sessionHealthPill.textContent = health.label;
  sessionHealthPill.className = `health-pill ${health.tone}`.trim();
  sessionLastActivity.textContent = `Last activity ${formatRelativeTime(sessionLastUpdated)}`;
  sessionHeadline.textContent = sessionHeadlineText;
  sessionDetail.textContent = sessionDetailText;
  sessionUpdatedAt.textContent = sessionLastUpdated
    ? `Last update ${formatEventTime(sessionLastUpdated)}`
    : "Session initiated just now";
  sessionElapsed.textContent = formatElapsed(sessionStartedAt);
  sessionActivityState.textContent = sessionStage;
  sessionTrackCount.textContent = `${currentStates.filter((state) => state.status === "running").length} live`;
  sessionActionState.textContent = pendingInstall ? "Approval required" : "No action required";
  overviewSubtitle.textContent = pendingInstall
    ? "Runtime paused on an action requiring approval"
    : "Meaningful progress is surfaced here, transport noise stays out of the way";
  overviewTrackCaption.textContent = currentStates.length > 0
    ? `${currentStates.length} track${currentStates.length === 1 ? "" : "s"} in circulation`
    : "Researchers will appear here after orchestration";
  actionCenterCaption.textContent = pendingInstall ? "Action needed to continue" : "Watching for blockers";

  runtimeHealthDot.className = `runtime-health-dot ${health.tone}`.trim();
  runtimeHealthLabel.textContent = health.label;
}

function renderStageRail(): void {
  const activeKey = stageKeyForStage(sessionStage);
  const stageOrder = ["brief", "surface", "tracks", "research", "report"];
  const activeIndex = stageOrder.indexOf(activeKey);

  Array.from(stageRail.querySelectorAll<HTMLElement>(".stage-step")).forEach((step) => {
    const key = step.dataset.stageKey ?? "brief";
    const idx = stageOrder.indexOf(key);
    const statusLabel = step.querySelector<HTMLElement>(".stage-step-status");
    if (!statusLabel) return;

    step.classList.remove("complete", "active", "pending");
    if (idx < activeIndex) {
      step.classList.add("complete");
      statusLabel.textContent = "Complete";
      return;
    }
    if (idx === activeIndex) {
      step.classList.add("active");
      statusLabel.textContent = "Live";
      return;
    }
    step.classList.add("pending");
    statusLabel.textContent = "Pending";
  });
}

function renderMilestones(): void {
  milestoneList.innerHTML = "";
  const milestones = milestoneEvents.slice(-8);

  if (milestones.length === 0) {
    const empty = document.createElement("div");
    empty.className = "milestone-detail";
    empty.textContent = "The orchestrator is warming up. Milestones will appear here as meaningful progress lands.";
    milestoneList.appendChild(empty);
    return;
  }

  for (const event of milestones) {
    const row = document.createElement("div");
    row.className = "milestone-row";

    const time = document.createElement("div");
    time.className = "milestone-time";
    time.textContent = formatEventTime(event.timestamp);

    const content = document.createElement("div");
    content.className = "milestone-content";

    const chip = document.createElement("div");
    chip.className = "milestone-chip";
    chip.textContent = event.trackId ? event.trackId : event.kind.replaceAll("_", " ");

    const title = document.createElement("div");
    title.className = "milestone-title";
    title.textContent = event.title;

    const detail = document.createElement("div");
    detail.className = "milestone-detail";
    detail.textContent = event.detail ?? event.stage ?? "";

    content.append(chip, title, detail);
    row.append(time, content);
    milestoneList.appendChild(row);
  }
}

function renderOverviewTrackGrid(): void {
  overviewTrackGrid.innerHTML = "";

  if (currentStates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "action-center-item";
    empty.innerHTML = `<strong>Orchestrator only</strong><p>Attack-surface mapping is still underway. Research tracks will appear here as soon as hypotheses are created.</p>`;
    overviewTrackGrid.appendChild(empty);
    return;
  }

  for (const state of currentStates.slice(0, 4)) {
    const card = document.createElement("article");
    card.className = "track-overview-card";
    card.innerHTML = `
      <div class="track-overview-top">
        <div>
          <h4>${humanizeTrackTitle(state.trackId, state.hypothesis)}</h4>
          <p>${trackStageById.get(state.trackId) ?? "Queued for investigation"}</p>
        </div>
        <div class="track-status-pill ${state.status}">${state.status}</div>
      </div>
      <p>${summarizeTrack(state)}</p>
      <div class="track-overview-meta">
        <span>Updated ${formatRelativeTime(state.updatedAt)}</span>
        <span>${state.trackId}</span>
      </div>
    `;
    overviewTrackGrid.appendChild(card);
  }
}

function renderTracksGrid(): void {
  tracksGrid.innerHTML = "";

  if (currentStates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "action-center-item";
    empty.innerHTML = `<strong>No researcher tracks yet</strong><p>The orchestrator is still mapping the target and defining hypotheses.</p>`;
    tracksGrid.appendChild(empty);
    tracksPanelCaption.textContent = "Track details will appear after orchestration";
    return;
  }

  tracksPanelCaption.textContent = `${currentStates.length} track${currentStates.length === 1 ? "" : "s"} currently known`;
  for (const state of currentStates) {
    const card = document.createElement("article");
    card.className = "track-overview-card";
    card.innerHTML = `
      <div class="track-overview-top">
        <div>
          <h4>${humanizeTrackTitle(state.trackId, state.hypothesis)}</h4>
          <p>${trackStageById.get(state.trackId) ?? "Running analysis"}</p>
        </div>
        <div class="track-status-pill ${state.status}">${state.status}</div>
      </div>
      <p>${summarizeTrack(state)}</p>
      <div class="track-overview-meta">
        <span>Last update ${formatRelativeTime(state.updatedAt)}</span>
        <span>${state.trackId}</span>
      </div>
    `;
    tracksGrid.appendChild(card);
  }
}

function renderActionCenter(): void {
  actionCenter.innerHTML = "";

  if (pendingInstall) {
    const item = document.createElement("div");
    item.className = "action-center-item";
    item.innerHTML = `<strong>Approval required for ${pendingInstall.trackId}</strong><p>${pendingInstall.justification}</p>`;
    actionCenter.appendChild(item);
    return;
  }

  // Check for API limit errors first (highest priority)
  const apiLimitEvent = runtimeEvents.find(event => 
    event.kind === "error" && event.title === "API limit reached"
  );
  if (apiLimitEvent) {
    const item = document.createElement("div");
    item.className = "action-center-item api-limit-alert";
    item.innerHTML = `
      <strong>🚫 API Limit Reached</strong>
      <p>${apiLimitEvent.detail ?? apiLimitEvent.title}</p>
      <div class="api-limit-actions">
        <button onclick="window.open('https://platform.openai.com/account/usage', '_blank')" class="api-limit-btn">Check OpenAI Usage</button>
        <button onclick="window.open('https://console.anthropic.com/settings/plans', '_blank')" class="api-limit-btn">Check Anthropic Usage</button>
      </div>
    `;
    actionCenter.appendChild(item);
    return;
  }

  const latest = runtimeEvents.at(-1);
  if (latest?.severity === "error") {
    const item = document.createElement("div");
    item.className = "action-center-item";
    item.innerHTML = `<strong>Attention needed</strong><p>${latest.detail ?? latest.title}</p>`;
    actionCenter.appendChild(item);
    return;
  }

  const healthy = document.createElement("div");
  healthy.className = "action-center-item";
  healthy.innerHTML = `<strong>No action required</strong><p>The system is progressing normally. If the current phase takes longer than expected, the summary hero will call that out.</p>`;
  actionCenter.appendChild(healthy);
}

function applyRuntimeEvent(event: RuntimeEvent): void {
  runtimeEvents.push(event);

  // Debug logging for API limit events
  if (event.kind === "error" && event.title === "API limit reached") {
    console.log("🚫 API LIMIT EVENT DETECTED:", event);
  }

  if (event.kind === "session_started" && !sessionStartedAt) {
    sessionStartedAt = event.timestamp;
  }
  if (event.scope === "session") {
    sessionStage = event.stage ?? sessionStage;
    sessionHeadlineText = event.title;
    sessionDetailText = event.detail ?? event.stage ?? sessionDetailText;
    sessionLastUpdated = event.timestamp;
  }

  if (event.trackId) {
    trackHeadlineById.set(event.trackId, event.title);
    if (event.stage) {
      trackStageById.set(event.trackId, event.stage);
    }
  }

  if (isMilestoneEvent(event)) {
    const signature = milestoneSignature(event);
    if (milestoneSignatures.at(-1) !== signature) {
      milestoneSignatures.push(signature);
      milestoneEvents.push(event);
    }
  }

  renderSessionSummary();
  renderStageRail();
  renderMilestones();
  renderOverviewTrackGrid();
  renderTracksGrid();
  renderActionCenter();
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
setActiveView("overview");
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
      resumeBtn.className = "btn-primary";
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
  }

  await openSession(s);
  // Re-launch polling and load events
  await replaySessionEvents(s.id);
  startPolling();
}

async function openSession(s: SessionInfo): Promise<void> {
  activeSessionId = s.id;
  activeSessionStateDir = await api.getSessionStateDir(s.id);
  await api.setActiveSession(s.id);

  resetRuntimeState();
  document.body.classList.add("session-live");
  activeTrackId = "orchestrator";
  activeTitle.textContent = "orchestrator";
  activeStatusDot.className = "status-dot " + (s.status === "running" ? "running" : s.status === "completed" ? "found" : "blocked");
  runtimeTarget.textContent = s.target;
  runtimeModel.textContent = s.model;
  runtimeBoxer.textContent = s.boxerUrl;
  runtimeSessionCard.classList.remove("hidden");

  // Show stop button only for running sessions; resume for stopped/crashed
  stopSessionBtn.style.display = s.status === "running" ? "" : "none";
  resumeSessionBtn.style.display = (s.status === "crashed" || s.status === "failed") ? "" : "none";

  sessionsView.style.display = "none";
  welcome.style.display = "none";
  progressView.style.display = "flex";
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
  stopActivityPolling();
  progressView.style.display = "none";
  activeSessionId = null;
  activeSessionStateDir = null;
  activeTrackId = null;
  resetRuntimeState();
  runtimeSessionCard.classList.add("hidden");
  setSessionConfigLocked(false);
  startBtn.textContent = "Start Research";
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
  stopSessionBtn.style.display = "none";
  resumeSessionBtn.style.display = "";
  activeStatusDot.className = "status-dot blocked";
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
  resumeSessionBtn.style.display = "none";
  stopSessionBtn.disabled = false;
  stopSessionBtn.textContent = "Stop";
  stopSessionBtn.style.display = "";
  activeStatusDot.className = "status-dot running";
  startPolling();
});

void initSessionsView();

overviewTab.addEventListener("click", () => setActiveView("overview"));
tracksTab.addEventListener("click", () => setActiveView("tracks"));
activityTab.addEventListener("click", () => setActiveView("activity"));
reasoningTab.addEventListener("click", () => setActiveView("reasoning"));
debugTab.addEventListener("click", () => setActiveView("debug"));

// ── Provider access persistence ─────────────────────────────────────────────

refreshStartActionUI = renderStartAction;
providerSetupTarget = getSelectedProvider();

async function saveSelectedProviderCredential(): Promise<void> {
  const provider = providerSetupTarget ?? getSelectedProvider();
  const source = getProviderSetupSource(provider);
  const secret = source === "claude_auth" ? null : providerSecretInput.value.trim();

  providerSaveBtn.disabled = true;
  providerSaveBtn.textContent = "Saving…";
  providerSetupHint.textContent = "Validating and saving credential…";

  try {
    await api.saveProviderCredential(provider, source, secret);
    if (source !== "claude_auth") {
      providerSecretInput.value = "";
    }
    await refreshProviderStatuses();
  } catch (error) {
    providerSetupHint.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    providerSaveBtn.disabled = false;
    providerSaveBtn.textContent = source === "claude_auth" ? `Save ${getCredentialSourceLabel(source)}` : "Save";
  }
}

async function testSelectedProviderCredential(): Promise<void> {
  const provider = providerSetupTarget ?? getSelectedProvider();
  const source = getProviderSetupSource(provider);
  const secret = source === "claude_auth" ? null : providerSecretInput.value.trim();

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
    providerTestBtn.textContent = source === "claude_auth" ? "Test auth" : "Test";
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
    providerDeleteBtn.textContent = source === "claude_auth" ? "Clear auth" : "Delete";
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
  document.body.classList.add("session-live");
  activeTrackId = "orchestrator";
  activeTitle.textContent = "orchestrator";
  activeStatusDot.className = "status-dot running";
  progressLog.textContent = "";
  runtimeTarget.textContent = target;
  runtimeModel.textContent = getModelInfo(model as SupportedModel).label;
  runtimeBoxer.textContent = boxerUrl;
  runtimeHealthLabel.textContent = "Preparing";
  runtimeSessionCard.classList.remove("hidden");

  const maxTracks = parseInt(maxTracksInput.value, 10) || 6;
  const result = await api.startResearch(briefPath, boxerUrl, model, maxTracks);
  if (result.sessionId) {
    activeSessionId = result.sessionId;
    activeSessionStateDir = await api.getSessionStateDir(result.sessionId);
  }
  startPolling();

  welcome.style.display = "none";
  progressView.style.display = "flex";
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
  renderTracks(states);
  renderSessionSummary();
  renderOverviewTrackGrid();
  renderTracksGrid();
  renderActionCenter();

  // Re-read the active track's log on every poll (catches anything missed between stream events)
  if (activeTrackId && activeSessionStateDir) {
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

function renderTracks(states: TrackState[]): void {
  if (states.length === 0) {
    // Orchestrator is still running — show a synthetic entry so the UI isn't blank
    tracksContainer.innerHTML = "";
    const card = document.createElement("div");
    card.className = "track-card active";
    card.innerHTML = `
      <div class="track-header">
        <span class="status-dot running"></span>
        <span class="track-id">orchestrator</span>
        <span style="font-size:11px;color:var(--muted)">running</span>
      </div>
      <div class="track-hypo">${sessionHeadlineText}</div>
    `;
    tracksContainer.appendChild(card);
    if (!activeTrackId) {
      activeTrackId = "orchestrator";
      activeTitle.textContent = "orchestrator";
      activeStatusDot.className = "status-dot running";
    }
    return;
  }

  tracksContainer.innerHTML = "";

  for (const state of states) {
    const card = document.createElement("div");
    card.className = `track-card${state.trackId === activeTrackId ? " active" : ""}`;
    card.innerHTML = `
      <div class="track-header">
        <span class="status-dot ${state.status}"></span>
        <span class="track-id">${state.trackId}</span>
        <span style="font-size:11px;color:var(--muted)">${state.status}</span>
      </div>
      <div class="track-hypo">${trackHeadlineById.get(state.trackId) ?? trackStageById.get(state.trackId) ?? state.hypothesis}</div>
    `;
    card.addEventListener("click", () => selectTrack(state));
    tracksContainer.appendChild(card);
  }

  const first = states[0];
  if ((!activeTrackId || activeTrackId === "orchestrator") && first) void selectTrack(first);

  if (activeTrackId) {
    const active = states.find((s) => s.trackId === activeTrackId);
    if (active) {
      activeStatusDot.className = `status-dot ${active.status}`;
      activeTitle.textContent = trackStageById.get(active.trackId)
        ? `${active.trackId} · ${trackStageById.get(active.trackId)}`
        : active.trackId;
    }
  }
}

async function selectTrack(state: TrackState): Promise<void> {
  activeTrackId = state.trackId;
  activeTitle.textContent = trackStageById.get(state.trackId)
    ? `${state.trackId} · ${trackStageById.get(state.trackId)}`
    : state.trackId;
  activeStatusDot.className = `status-dot ${state.status}`;

  const progressPath = activeSessionStateDir
    ? `${activeSessionStateDir}/research/${state.trackId}/progress.md`
    : null;
  const content = progressPath ? await api.readFile(progressPath) : null;
  progressLog.textContent = content ?? "(no progress yet)";
  progressLog.scrollTop = progressLog.scrollHeight;

  // Sync activity/reasoning panel to the newly selected track
  activityTrackId = state.trackId;
  liveThinkingText.textContent = "";
  liveThinking.classList.add("hidden");
  if (activeView === "activity" || activeView === "reasoning") {
    void loadAgentActivity(state.trackId);
    if (activeView === "activity") startActivityPolling(state.trackId);
  }

  const states = await api.getProgress(activeSessionId ?? undefined);
  renderTracks(states);
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

// ── Activity + Reasoning ──────────────────────────────────────────────────────

function stopActivityPolling(): void {
  if (activityPollInterval) {
    clearInterval(activityPollInterval);
    activityPollInterval = null;
  }
}

function startActivityPolling(trackId: string): void {
  stopActivityPolling();
  activityPollInterval = setInterval(() => {
    void loadAgentActivity(trackId);
  }, 2000);
}

async function loadAgentActivity(trackId: string): Promise<void> {
  if (!activeSessionId) return;
  activityTrackId = trackId;
  const turns = await api.getAgentActivity(activeSessionId, trackId);
  renderActivityPanel(trackId, turns);
  renderReasoningPanel(trackId, turns);
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

function renderActivityPanel(trackId: string, turns: AgentTurnInfo[]): void {
  const role = agentRole(trackId);
  activityAgentBadge.textContent = role;
  activityAgentBadge.className = `agent-role-badge ${role}`;
  activityAgentName.textContent = trackId;

  const totalTools = turns.reduce((s, t) => s + t.toolCalls.length, 0);
  const totalCostUsd = turns.reduce((s, t) => {
    // rough estimate: $3/Mtok in, $15/Mtok out
    return s + (t.inputTokens * 3 + t.outputTokens * 15) / 1_000_000;
  }, 0);
  activityStats.textContent = turns.length > 0
    ? `${turns.length} turn${turns.length === 1 ? "" : "s"} · ${totalTools} tool calls · ~$${totalCostUsd.toFixed(3)}`
    : "";

  if (turns.length === 0) {
    activityEmpty.style.display = "";
    activityIterations.innerHTML = "";
    return;
  }
  activityEmpty.style.display = "none";

  // Group turns by iteration
  const byIter = new Map<number, AgentTurnInfo[]>();
  for (const t of turns) {
    if (!byIter.has(t.iteration)) byIter.set(t.iteration, []);
    byIter.get(t.iteration)!.push(t);
  }

  const scrollTop = activityIterations.scrollTop;
  activityIterations.innerHTML = "";

  for (const [iter, iterTurns] of [...byIter.entries()].sort(([a], [b]) => a - b)) {
    const iterToolCount = iterTurns.reduce((s, t) => s + t.toolCalls.length, 0);
    const iterIn = iterTurns.reduce((s, t) => s + t.inputTokens, 0);
    const iterOut = iterTurns.reduce((s, t) => s + t.outputTokens, 0);

    const iterEl = document.createElement("div");
    iterEl.className = "activity-iteration";

    const header = document.createElement("div");
    header.className = "iteration-header";
    header.innerHTML = `
      <span class="iteration-chevron"></span>
      <span class="iteration-label">Iteration ${iter}</span>
      <span class="iteration-meta">${iterTurns.length} turn${iterTurns.length === 1 ? "" : "s"} · ${iterToolCount} tools · ${fmtNum(iterIn + iterOut)} tok</span>
    `;

    const body = document.createElement("div");
    body.className = "iteration-body";

    header.addEventListener("click", () => {
      header.classList.toggle("collapsed");
      body.classList.toggle("hidden");
    });

    for (const turn of iterTurns) {
      const turnEl = document.createElement("div");
      turnEl.className = "activity-turn";
      turnEl.innerHTML = `<div class="turn-header">Turn ${turn.turnIndex} · ${fmtNum(turn.inputTokens)} in · ${fmtNum(turn.outputTokens)} out${turn.cacheReadTokens > 0 ? ` · ${fmtNum(turn.cacheReadTokens)} cache` : ""}</div>`;

      for (const tc of turn.toolCalls) {
        const summary = summarizeToolInput(tc.toolName, tc.toolInput);
        const badgeClass = toolBadgeClass(tc.toolName);
        const outcome = tc.outcome === "pending" ? "…" : tc.outcome === "ok" ? "✓" : "✗";
        const outcomeClass = tc.outcome === "pending" ? "pending" : tc.outcome === "ok" ? "ok" : "error";

        const row = document.createElement("div");
        row.className = "tool-row";
        row.innerHTML = `
          <span class="tool-badge ${badgeClass}">${tc.toolName}</span>
          <span class="tool-summary">${summary}</span>
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

        row.addEventListener("click", () => {
          row.classList.toggle("expanded");
        });

        turnEl.appendChild(row);
        turnEl.appendChild(detail);
      }

      body.appendChild(turnEl);
    }

    iterEl.appendChild(header);
    iterEl.appendChild(body);
    activityIterations.appendChild(iterEl);
  }

  activityIterations.scrollTop = scrollTop;
}

function renderReasoningPanel(trackId: string, turns: AgentTurnInfo[]): void {
  const role = agentRole(trackId);
  reasoningAgentBadge.textContent = role;
  reasoningAgentBadge.className = `agent-role-badge ${role}`;
  reasoningAgentName.textContent = trackId;

  const totalIn = turns.reduce((s, t) => s + t.inputTokens, 0);
  const totalOut = turns.reduce((s, t) => s + t.outputTokens, 0);
  const totalThinking = turns.reduce((s, t) => s + (t.thinkingText.length > 0 ? Math.round(t.thinkingText.length / 4) : 0), 0);
  const totalCache = turns.reduce((s, t) => s + t.cacheReadTokens, 0);

  tokenTotals.innerHTML = turns.length > 0 ? `
    <span><strong>${fmtNum(totalIn)}</strong> in</span>
    <span><strong>${fmtNum(totalOut)}</strong> out</span>
    ${totalThinking > 0 ? `<span><strong>~${fmtNum(totalThinking)}</strong> thinking</span>` : ""}
    ${totalCache > 0 ? `<span><strong>${fmtNum(totalCache)}</strong> cache hits</span>` : ""}
  ` : "";

  if (turns.length === 0) {
    reasoningEmpty.style.display = "";
    reasoningTurns.innerHTML = "";
    return;
  }
  reasoningEmpty.style.display = "none";

  const scrollTop = reasoningTurns.scrollTop;
  reasoningTurns.innerHTML = "";

  for (const turn of turns) {
    if (!turn.thinkingText && !turn.textOutput) continue;

    const turnEl = document.createElement("div");
    turnEl.className = "reasoning-turn";

    const thinkEst = turn.thinkingText.length > 0 ? Math.round(turn.thinkingText.length / 4) : 0;
    turnEl.innerHTML = `
      <div class="reasoning-turn-header">
        <span class="reasoning-turn-label">Iter ${turn.iteration} · Turn ${turn.turnIndex}</span>
        <div class="reasoning-turn-tokens">
          <span class="tok-chip">${fmtNum(turn.inputTokens)} in</span>
          <span class="tok-chip">${fmtNum(turn.outputTokens)} out</span>
          ${thinkEst > 0 ? `<span class="tok-chip thinking">~${fmtNum(thinkEst)} thinking</span>` : ""}
          ${turn.cacheReadTokens > 0 ? `<span class="tok-chip cache">${fmtNum(turn.cacheReadTokens)} cache</span>` : ""}
        </div>
      </div>
      ${turn.thinkingText ? `
        <div class="thinking-block">
          <div class="block-label">Thinking</div>
          <div class="block-text">${escHtml(turn.thinkingText)}</div>
        </div>` : ""}
      ${turn.textOutput ? `
        <div class="output-block">
          <div class="block-label">Output</div>
          <div class="block-text">${escHtml(turn.textOutput)}</div>
        </div>` : ""}
    `;

    reasoningTurns.appendChild(turnEl);
  }

  reasoningTurns.scrollTop = scrollTop;
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

  if (activeTrackId === "orchestrator" && event.scope === "session") {
    activeTitle.textContent = `orchestrator · ${event.stage ?? sessionStage}`;
  }
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
  if (event.trackId !== activityTrackId) return;
  if (activeView !== "reasoning") return;
  liveThinking.classList.remove("hidden");
  liveThinkingText.textContent = (liveThinkingText.textContent ?? "") + event.thinking;
  liveThinkingText.scrollTop = liveThinkingText.scrollHeight;
});

api.onAgentTurn((event: AgentTurnEvent) => {
  // Clear live thinking when a turn completes
  if (event.trackId === activityTrackId) {
    liveThinkingText.textContent = "";
    liveThinking.classList.add("hidden");
    if (activeView === "activity" || activeView === "reasoning") {
      void loadAgentActivity(event.trackId);
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
  sessionStage = "Failed";
  sessionHeadlineText = "Research session failed";
  sessionDetailText = err;
  sessionLastUpdated = new Date().toISOString();
  renderSessionSummary();
  renderActionCenter();
  alert(`Research error: ${err}`);
});
