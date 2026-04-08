/**
 * Renderer process — UI logic.
 * Communicates with main process via window.bugBounty (preload bridge).
 */

import type { BugBountyAPI } from "../preload.js";
import type { TrackState, PendingInstall, ModelProvider } from "../../src/types/index.js";

declare const window: Window & { bugBounty: BugBountyAPI };

const api = window.bugBounty;

const DEFAULT_MODELS: Record<ModelProvider, string> = {
  claude_code: "sonnet",
  openai: "gpt-5",
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
const providerSelect = el<HTMLSelectElement>("model-provider");
const modelInput = el<HTMLInputElement>("model-name");

let activeTrackId: string | null = null;
let pendingInstall: PendingInstall | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

providerSelect.addEventListener("change", () => {
  const provider = providerSelect.value as ModelProvider;
  modelInput.value = DEFAULT_MODELS[provider] ?? "";
});

el("pick-code").addEventListener("click", async () => {
  const path = await api.pickFile([{ name: "All", extensions: ["*"] }]);
  if (path) el<HTMLInputElement>("code-path").value = path;
});

startBtn.addEventListener("click", async () => {
  const target = el<HTMLInputElement>("target").value.trim();
  const goal = el<HTMLInputElement>("goal").value.trim();
  const scope = el<HTMLTextAreaElement>("scope").value.trim();
  const boxerUrl = el<HTMLInputElement>("boxer-url").value.trim();
  const provider = providerSelect.value as ModelProvider;
  const model = modelInput.value.trim();

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

  await api.startResearch(briefPath, boxerUrl, provider, model);
  startPolling();

  welcome.style.display = "none";
  progressView.style.display = "flex";
  startBtn.textContent = "Research Running";
});

function startPolling(): void {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = setInterval(poll, 3000);
  void poll();
}

async function poll(): Promise<void> {
  const [states, pendingInstalls] = await Promise.all([
    api.getProgress(),
    api.getPendingInstalls(),
  ]);

  renderTracks(states);

  if (pendingInstalls.length > 0 && !pendingInstall) {
    const install = pendingInstalls[0];
    if (install) showPermissionPrompt(install);
  }
}

function renderTracks(states: TrackState[]): void {
  if (states.length === 0) return;

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

api.onResearchError((err: string) => {
  console.error("Research error:", err);
  startBtn.disabled = false;
  startBtn.textContent = "Start Research";
  alert(`Research error: ${err}`);
});
