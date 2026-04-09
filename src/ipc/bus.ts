/**
 * In-process event bus for streaming research log lines from SDK client → Electron main process.
 * client.ts emits here; ui/main.ts listens and forwards to the renderer window via IPC.
 */

import { EventEmitter } from "events";
import type { RuntimeEvent, RuntimeEventInput } from "../types/runtime.js";

export interface ResearchLogEvent {
  trackId: string;
  text: string;
}

export const ipcBus = new EventEmitter();
ipcBus.setMaxListeners(100); // many parallel researcher agents may emit

export function emitRuntimeEvent(event: RuntimeEventInput): void {
  const runtimeEvent: RuntimeEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...event,
  };
  ipcBus.emit("runtime-event", runtimeEvent);
}
