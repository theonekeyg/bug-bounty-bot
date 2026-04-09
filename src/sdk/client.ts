import { query } from "@anthropic-ai/claude-agent-sdk";
import OpenAI from "openai";
import type { RunModelConfig, SupportedModel } from "../types/provider.js";
import { getModelProvider } from "../types/provider.js";
import { ipcBus, emitRuntimeEvent } from "../ipc/bus.js";
import { appendProgress } from "../loop/state.js";

let _openai: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
  return _openai;
}

export interface AgentRunOptions {
  systemPrompt: string;
  prompt: string;
  modelConfig: RunModelConfig;
  cwd?: string;
  trackId?: string; // used to stream progress back to the UI
  allowedTools?: string[];
  persistHeartbeats?: boolean;
}

export interface AgentRunResult {
  result: string;
  costUsd: number;
  turns: number;
}

function emitResearchLog(trackId: string | undefined, text: string): void {
  if (!trackId) return;
  ipcBus.emit("research-log", { trackId, text });
}

function isApiLimitError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    const statusMatch = message.match(/status\s+(\d{3})/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 0;
    
    return (
      message.includes('rate limit') ||
      message.includes('quota exceeded') ||
      message.includes('too many requests') ||
      message.includes('api limit') ||
      message.includes('usage limit') ||
      message.includes('billing') ||
      message.includes('payment required') ||
      message.includes('insufficient') ||
      message.includes('exceeded') ||
      message.includes('limit reached') ||
      message.includes('throttled') ||
      message.includes('timeout') ||
      message.includes('network') ||
      message.includes('connection') ||
      message.includes('econnreset') ||
      message.includes('etimedout') ||
      status === 429 ||
      status === 402 ||
      status === 403 ||
      status === 503
    );
  }
  return false;
}

function handleApiLimitError(error: unknown, trackId: string | undefined, provider: string): void {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const isLimit = isApiLimitError(error);
  
  if (isLimit) {
    emitRuntimeEvent({
      scope: trackId === "orchestrator" ? "session" : "track",
      kind: "error",
      severity: "error",
      trackId: trackId === "orchestrator" ? undefined : trackId,
      title: "API limit reached",
      detail: `${provider} API quota exceeded. Please check your usage and billing status.`,
      stage: "API Limit",
    });
    
    if (trackId) {
      void appendProgress(trackId, `\n[API LIMIT] ${provider} API quota exceeded. Request failed: ${errorMessage}\n`);
    }
  }
}

function startHeartbeat(opts: AgentRunOptions): () => void {
  const trackId = opts.trackId;
  if (!trackId) return () => undefined;

  const startedAt = Date.now();
  let lastNotedAt = startedAt;

  const timer = setInterval(() => {
    const now = Date.now();
    if (now - lastNotedAt < 15000) return;

    const elapsedSec = Math.floor((now - startedAt) / 1000);
    const note = `[run] Still waiting for model output... (${elapsedSec}s elapsed)`;

    emitResearchLog(trackId, `\n${note}\n`);
    emitRuntimeEvent({
      scope: trackId === "orchestrator" ? "session" : "track",
      kind: "heartbeat",
      severity: "info",
      trackId: trackId === "orchestrator" ? undefined : trackId,
      title: "Still waiting for model output",
      detail: `${elapsedSec}s elapsed`,
      stage: "Waiting For Model",
    });
    if (opts.persistHeartbeats) {
      void appendProgress(trackId, note);
    }
    lastNotedAt = now;

    // Detect potential API limit/hang after 60 seconds
    if (elapsedSec > 60) {
      const timeoutError = new Error(`API request timeout after ${elapsedSec}s - possible rate limit or service issue`);
      handleApiLimitError(timeoutError, trackId, "Anthropic");
    }
  }, 5000);

  return () => clearInterval(timer);
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const provider = getModelProvider(opts.modelConfig.model as SupportedModel);
  const stopHeartbeat = startHeartbeat(opts);
  let announcedOutput = false;

  try {
    if (provider === "openai") {
      emitRuntimeEvent({
        scope: opts.trackId === "orchestrator" ? "session" : "track",
        kind: "waiting",
        severity: "info",
        trackId: opts.trackId === "orchestrator" ? undefined : opts.trackId,
        title: "Submitting request to OpenAI",
        detail: opts.modelConfig.model,
        stage: "Waiting For Model",
      });
      if (!process.env["OPENAI_API_KEY"]) throw new Error("OPENAI_API_KEY environment variable is not set.");

      try {
        const response = await getOpenAI().responses.create({
          model: opts.modelConfig.model,
          input: [
            { role: "system", content: [{ type: "input_text", text: opts.systemPrompt }] },
            { role: "user",   content: [{ type: "input_text", text: opts.prompt }] },
          ],
        });

        const text = response.output_text?.trim() ?? "";
        if (text) emitResearchLog(opts.trackId, text + "\n");
        return { result: text, costUsd: 0, turns: 1 };
      } catch (error) {
        handleApiLimitError(error, opts.trackId, "OpenAI");
        throw error;
      }
    }

    // Anthropic — uses Claude Code subscription via the agent SDK (no API key needed).
    // Requires `claude auth login` to have been run once on this machine.
    const stream = query({
      prompt: opts.prompt,
      options: {
        systemPrompt: opts.systemPrompt,
        model: opts.modelConfig.model,
        ...(opts.allowedTools && opts.allowedTools.length > 0 ? { allowedTools: opts.allowedTools } : {}),
        allowDangerouslySkipPermissions: true,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      },
    });

    emitRuntimeEvent({
      scope: opts.trackId === "orchestrator" ? "session" : "track",
      kind: "waiting",
      severity: "info",
      trackId: opts.trackId === "orchestrator" ? undefined : opts.trackId,
      title: "Submitting request to Claude Code",
      detail: opts.modelConfig.model,
      stage: "Waiting For Model",
    });

    try {
      for await (const message of stream) {
      // Stream text deltas to the UI in real time
      if (message.type === "stream_event") {
        const event = message.event;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          if (!announcedOutput) {
            emitRuntimeEvent({
              scope: opts.trackId === "orchestrator" ? "session" : "track",
              kind: "stage_changed",
              severity: "info",
              trackId: opts.trackId === "orchestrator" ? undefined : opts.trackId,
              title: "Model is producing output",
              detail: opts.modelConfig.model,
              stage: "Generating Output",
            });
            announcedOutput = true;
          }
          emitResearchLog(opts.trackId, event.delta.text);
        }
      }

        if (message.type === "result") {
          if (message.subtype !== "success") {
            const error = new Error(`Claude agent error (${message.subtype}): ${message.errors.join(", ")}`);
            handleApiLimitError(error, opts.trackId, "Anthropic");
            throw error;
          }
          return {
            result: message.result.trim(),
            costUsd: message.total_cost_usd,
            turns: message.num_turns,
          };
        }
      }
    } catch (streamError) {
      // Handle stream errors including timeouts and connection issues
      handleApiLimitError(streamError, opts.trackId, "Anthropic");
      throw streamError;
    }

    const error = new Error("Claude agent stream ended without a result message");
    handleApiLimitError(error, opts.trackId, "Anthropic");
    throw error;
  } finally {
    stopHeartbeat();
  }
}
