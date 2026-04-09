/**
 * In-process event bus for streaming research log lines from SDK client → Electron main process.
 * client.ts emits here; ui/main.ts listens and forwards to the renderer window via IPC.
 */

import { EventEmitter } from "events";

export interface ResearchLogEvent {
  trackId: string;
  text: string;
}

export const ipcBus = new EventEmitter();
ipcBus.setMaxListeners(100); // many parallel researcher agents may emit
