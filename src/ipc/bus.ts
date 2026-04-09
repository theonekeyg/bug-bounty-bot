/**
 * In-process event bus for streaming research log lines from SDK client → Electron main process.
 * client.ts emits here; ui/main.ts listens and forwards to the renderer window via IPC.
 */

import { EventEmitter } from "events";
import type { RuntimeEvent, RuntimeEventInput } from "../types/runtime.js";

export type { RuntimeEventInput };

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

/**
 * Emit a runtime event AND persist it to the session's event log in the DB.
 * Use this in agents so events survive crashes and can be replayed on resume.
 */
export function emitSessionEvent(sessionId: string, event: RuntimeEventInput): void {
  emitRuntimeEvent(event);
  // Persist asynchronously — never block the agent for a DB write.
  import("../db/sessions.js")
    .then(({ appendSessionEvent }) =>
      appendSessionEvent(sessionId, event).catch((err: unknown) =>
        console.error("[bus] failed to persist event:", err),
      ),
    )
    .catch(() => {
      /* DB not initialised in headless without DB setup — ignore */
    });
}
