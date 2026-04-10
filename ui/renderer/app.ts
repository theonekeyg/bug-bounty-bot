/**
 * Renderer process — UI logic.
 * Communicates with main process via window.bugBounty (preload bridge).
 */

import type { BugBountyAPI, SessionInfo } from "../preload.js";
import type { TrackState, PendingInstall, RuntimeEvent } from "../../src/types/index.js";
import {
  DEFAULT_MODEL,
  PROVIDER_MODELS,
  PROVIDERS,
  type Provider,
  type SupportedModel,
  getModelProvider,
  getModelInfo,
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
const debugTab = el<HTMLButtonElement>("debug-tab");
const overviewPanel = el("overview-panel");
const tracksPanel = el("tracks-panel");
const debugPanel = el("debug-panel");
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
const openaiKeyInput = el<HTMLInputElement>("openai-key");
const openrouterKeyInput = el<HTMLInputElement>("openrouter-key");
const runtimeSessionCard = el("runtime-session-card");
const runtimeHealthDot = el("runtime-health-dot");
const runtimeTarget = el("runtime-target");
const runtimeModel = el("runtime-model");
const runtimeBoxer = el("runtime-boxer");
const runtimeHealthLabel = el("runtime-health-label");
const stageRail = el("stage-rail");

let activeSessionId: string | null = null;
let activeSessionStateDir: string | null = null;
let activeTrackId: string | null = null;
let pendingInstall: PendingInstall | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;
let activeView: "overview" | "tracks" | "debug" = "overview";
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

function setActiveView(view: "overview" | "tracks" | "debug"): void {
  activeView = view;
  overviewTab.classList.toggle("active", view === "overview");
  tracksTab.classList.toggle("active", view === "tracks");
  debugTab.classList.toggle("active", view === "debug");
  overviewPanel.classList.toggle("hidden", view !== "overview");
  tracksPanel.classList.toggle("hidden", view !== "tracks");
  debugPanel.classList.toggle("hidden", view !== "debug");
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
    valueLabel.textContent = info.label;
    metaLabel.textContent = `${PROVIDERS.find((p) => p.value === provider)?.label ?? ""} · ${info.description}`;
  };

  const selectModel = (value: string): void => {
    modelInput.value = value;
    updateTrigger();
    close();
  };

  const renderMenu = (): void => {
    menu.innerHTML = "";

    if (panel === "providers") {
      for (const p of PROVIDERS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "dropdown-option";
        const currentProvider = getModelProvider((modelInput.value || DEFAULT_MODEL) as SupportedModel);
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

        const main = document.createElement("span");
        main.className = "dropdown-option-main";
        const labelEl = document.createElement("span");
        labelEl.className = "dropdown-option-label";
        labelEl.textContent = model.label;
        const descEl = document.createElement("span");
        descEl.className = "dropdown-option-description";
        descEl.textContent = model.description;
        main.append(labelEl, descEl);

        const check = document.createElement("span");
        check.className = "dropdown-option-check";
        check.setAttribute("aria-hidden", "true");

        btn.append(main, check);
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
}

createModelPicker();
setActiveView("overview");
resetRuntimeState();

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

void initSessionsView();

overviewTab.addEventListener("click", () => setActiveView("overview"));
tracksTab.addEventListener("click", () => setActiveView("tracks"));
debugTab.addEventListener("click", () => setActiveView("debug"));

// ── API key persistence ──────────────────────────────────────────────────────

void api.getSettings().then((s) => {
  openaiKeyInput.value = s.openaiKey;
  openrouterKeyInput.value = s.openrouterKey;
});

openaiKeyInput.addEventListener("blur", () => {
  void api.saveSettings({ openaiKey: openaiKeyInput.value, openrouterKey: openrouterKeyInput.value });
});

openrouterKeyInput.addEventListener("blur", () => {
  void api.saveSettings({ openaiKey: openaiKeyInput.value, openrouterKey: openrouterKeyInput.value });
});

// ── Form handlers ────────────────────────────────────────────────────────────

el("pick-code").addEventListener("click", async () => {
  const path = await api.pickFile([{ name: "All", extensions: ["*"] }]);
  if (path) el<HTMLInputElement>("code-path").value = path;
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

  const result = await api.startResearch(briefPath, boxerUrl, model);
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

// Live streaming: append text chunks as they arrive from the agent
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
