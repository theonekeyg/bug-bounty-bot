/**
 * Renderer process — UI logic.
 * Communicates with main process via window.bugBounty (preload bridge).
 */

import type { BugBountyAPI } from "../preload.js";
import type { TrackState, PendingInstall } from "../../src/types/index.js";
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


const startBtn = el<HTMLButtonElement>("start-btn");
const tracksContainer = el("tracks-container");
const welcome = el("welcome");
const progressView = el("progress-view");
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

let activeTrackId: string | null = null;
let pendingInstall: PendingInstall | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

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

  // Set initial value
  if (!modelInput.value) modelInput.value = DEFAULT_MODEL;
  updateTrigger();
}

createModelPicker();

// ── API key persistence ──────────────────────────────────────────────────────

void api.getSettings().then((s) => {
  openaiKeyInput.value = s.openaiKey;
});

openaiKeyInput.addEventListener("blur", () => {
  void api.saveSettings({ openaiKey: openaiKeyInput.value });
});

// ── Form handlers ────────────────────────────────────────────────────────────

el("pick-code").addEventListener("click", async () => {
  const path = await api.pickFile([{ name: "All", extensions: ["*"] }]);
  if (path) el<HTMLInputElement>("code-path").value = path;
});

startBtn.addEventListener("click", async () => {
  const target = el<HTMLInputElement>("target").value.trim();
  const goal = el<HTMLInputElement>("goal").value.trim();
  const scope = el<HTMLTextAreaElement>("scope").value.trim();
  const boxerUrl = el<HTMLInputElement>("boxer-url").value.trim();
  const model = modelInput.value.trim() || DEFAULT_MODEL;

  if (!target || !goal || !scope) {
    alert("Target, Goal, and Scope are required.");
    return;
  }

  if (!model) {
    alert("Model is required.");
    return;
  }

  const codePath = el<HTMLInputElement>("code-path").value.trim();
  const links = el<HTMLInputElement>("links").value.trim();
  const context = el<HTMLTextAreaElement>("context").value.trim();

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

  await api.startResearch(briefPath, boxerUrl, model);
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
    api.getProgress(),
    api.getPendingInstalls(),
  ]);

  renderTracks(states);

  // Re-read the active track's log on every poll (catches anything missed between stream events)
  if (activeTrackId) {
    const path =
      activeTrackId === "orchestrator"
        ? "state/research/orchestrator/progress.md"
        : `state/research/${activeTrackId}/progress.md`;
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
      <div class="track-hypo">Mapping attack surface…</div>
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
      <div class="track-hypo">${state.hypothesis}</div>
    `;
    card.addEventListener("click", () => selectTrack(state));
    tracksContainer.appendChild(card);
  }

  const first = states[0];
  if (!activeTrackId && first) selectTrack(first);

  if (activeTrackId) {
    const active = states.find((s) => s.trackId === activeTrackId);
    if (active) {
      activeStatusDot.className = `status-dot ${active.status}`;
    }
  }
}

async function selectTrack(state: TrackState): Promise<void> {
  activeTrackId = state.trackId;
  activeTitle.textContent = state.trackId;
  activeStatusDot.className = `status-dot ${state.status}`;

  const content = await api.readFile(`state/research/${state.trackId}/progress.md`);
  progressLog.textContent = content ?? "(no progress yet)";
  progressLog.scrollTop = progressLog.scrollHeight;

  const states = await api.getProgress();
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

api.onResearchError((err: string) => {
  console.error("Research error:", err);
  startBtn.disabled = false;
  startBtn.textContent = "Start Research";
  alert(`Research error: ${err}`);
});
