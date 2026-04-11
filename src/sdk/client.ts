import { query } from "@anthropic-ai/claude-agent-sdk";
import OpenAI from "openai";
import type { RunModelConfig, SupportedModel } from "../types/provider.js";
import { getModelProvider } from "../types/provider.js";
import { resolveRuntimeCredential } from "../credentials/runtime.js";
import { ipcBus, emitRuntimeEvent } from "../ipc/bus.js";
import type { AgentThinkingEvent, AgentTurnEvent, AgentToolProgressEvent } from "../ipc/bus.js";
import { appendProgress } from "../loop/state.js";
import type { AgentTurnInfo } from "../types/activity.js";

export interface AgentRunOptions {
  systemPrompt: string;
  prompt: string;
  modelConfig: RunModelConfig;
  cwd?: string;
  sessionId?: string; // for DB event persistence and progress logging
  trackId?: string; // used to stream progress back to the UI
  iteration?: number; // Ralph Loop iteration index (for activity tracking)
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
    const status = statusMatch?.[1] !== undefined ? parseInt(statusMatch[1]) : 0;

    return (
      message.includes("rate limit") ||
      message.includes("quota exceeded") ||
      message.includes("too many requests") ||
      message.includes("api limit") ||
      message.includes("usage limit") ||
      message.includes("billing") ||
      message.includes("payment required") ||
      message.includes("insufficient") ||
      message.includes("exceeded") ||
      message.includes("limit reached") ||
      message.includes("throttled") ||
      message.includes("timeout") ||
      message.includes("network") ||
      message.includes("connection") ||
      message.includes("econnreset") ||
      message.includes("etimedout") ||
      status === 429 ||
      status === 402 ||
      status === 403 ||
      status === 503
    );
  }
  return false;
}

function handleApiLimitError(
  error: unknown,
  opts: Pick<AgentRunOptions, "trackId" | "sessionId">,
  provider: string,
): void {
  const { trackId, sessionId } = opts;
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

    if (trackId && sessionId) {
      void appendProgress(
        sessionId,
        trackId,
        `\n[API LIMIT] ${provider} API quota exceeded. Request failed: ${errorMessage}\n`,
      );
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
    if (opts.persistHeartbeats && opts.sessionId) {
      void appendProgress(opts.sessionId, trackId, note);
    }
    lastNotedAt = now;

    // Detect potential API limit/hang after 60 seconds
    if (elapsedSec > 60) {
      const timeoutError = new Error(`API request timeout after ${elapsedSec}s - possible rate limit or service issue`);
      handleApiLimitError(timeoutError, opts, "Anthropic");
    }
  }, 5000);

  return () => clearInterval(timer);
}

const openaiClients = new Map<string, OpenAI>();
const openrouterClients = new Map<string, OpenAI>();

function getOpenAI(secret: string): OpenAI {
  const cached = openaiClients.get(secret);
  if (cached) return cached;
  const client = new OpenAI({ apiKey: secret });
  openaiClients.set(secret, client);
  return client;
}

function getOpenRouter(secret: string): OpenAI {
  const cached = openrouterClients.get(secret);
  if (cached) return cached;
  const client = new OpenAI({
    baseURL: "https://openrouter.ai/api/v1",
    apiKey: secret,
    defaultHeaders: {
      "HTTP-Referer": "https://github.com/bug-bounty-agent",
      "X-Title": "Bug Bounty Agent",
    },
  });
  openrouterClients.set(secret, client);
  return client;
}

function requireRuntimeCredential(provider: "openai" | "openrouter" | "anthropic") {
  const credential = resolveRuntimeCredential(provider);
  if (!credential) {
    throw new Error(`${provider} credentials are not configured. Open Provider Access and set them up.`);
  }
  return credential;
}

async function withTemporaryEnv<T>(key: string, value: string, fn: () => Promise<T>): Promise<T> {
  const previous = process.env[key];
  process.env[key] = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

function getAnthropicRequestOptions(opts: AgentRunOptions): {
  systemPrompt: string;
  model: string;
  allowedTools?: string[];
  allowDangerouslySkipPermissions: true;
  cwd?: string;
} {
  return {
    systemPrompt: opts.systemPrompt,
    model: opts.modelConfig.model,
    ...(opts.allowedTools && opts.allowedTools.length > 0 ? { allowedTools: opts.allowedTools } : {}),
    allowDangerouslySkipPermissions: true,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  };
}

async function runClaudeStream(
  stream: AsyncIterable<any>,
  opts: AgentRunOptions,
): Promise<AgentRunResult> {
  let announcedOutput = false;
  let turnIndex = 0;
  const pendingToolCalls = new Map<string, { dbId: string; startMs: number }>();

  try {
    for await (const message of stream) {
      // ── Stream deltas (text + thinking) ──────────────────────────────────
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
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
          } else if (event.delta.type === "thinking_delta" && opts.sessionId && opts.trackId) {
            const thinkingEvent: AgentThinkingEvent = {
              sessionId: opts.sessionId,
              trackId: opts.trackId,
              thinking: event.delta.thinking,
            };
            ipcBus.emit("agent-thinking", thinkingEvent);
          }
        }
      }

      // ── Completed assistant turn ──────────────────────────────────────────
      if (message.type === "assistant" && opts.sessionId && opts.trackId) {
        turnIndex++;
        const msg = message.message;

        let thinkingText = "";
        let textOutput = "";
        const toolUseBlocks: Array<{ id: string; name: string; input: unknown }> = [];

        for (const block of msg.content) {
          if (block.type === "thinking") {
            thinkingText += block.thinking;
          } else if (block.type === "text") {
            textOutput += block.text;
          } else if (block.type === "tool_use") {
            toolUseBlocks.push({ id: block.id, name: block.name, input: block.input });
          }
        }

        try {
          const { insertAgentTurn, insertToolCall } = await import("../db/activity.js");
          const turnId = await insertAgentTurn({
            sessionId: opts.sessionId,
            trackId: opts.trackId,
            iteration: opts.iteration ?? 1,
            turnIndex,
            thinkingText,
            textOutput,
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
          });

          const toolCallIds: string[] = [];
          for (const tu of toolUseBlocks) {
            const tcId = await insertToolCall({
              turnId,
              toolUseId: tu.id,
              toolName: tu.name,
              toolInput: JSON.stringify(tu.input),
            });
            pendingToolCalls.set(tu.id, { dbId: tcId, startMs: Date.now() });
            toolCallIds.push(tcId);
          }

          const turnInfo: AgentTurnInfo = {
            id: turnId,
            sessionId: opts.sessionId,
            trackId: opts.trackId,
            iteration: opts.iteration ?? 1,
            turnIndex,
            thinkingText,
            textOutput,
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
            startedAt: new Date().toISOString(),
            completedAt: new Date().toISOString(),
            toolCalls: toolUseBlocks.map((tu, i) => ({
              id: toolCallIds[i] ?? "",
              toolUseId: tu.id,
              toolName: tu.name,
              toolInput: JSON.stringify(tu.input),
              toolOutput: "",
              outcome: "pending",
              elapsedMs: 0,
              startedAt: new Date().toISOString(),
              completedAt: null,
            })),
          };
          const turnEvent: AgentTurnEvent = {
            sessionId: opts.sessionId,
            trackId: opts.trackId,
            turn: turnInfo,
          };
          ipcBus.emit("agent-turn", turnEvent);
        } catch (dbErr) {
          console.error("[client] Failed to persist agent turn:", dbErr);
        }
      }

      // ── Tool results (user message with tool_result blocks) ───────────────
      if (message.type === "user" && opts.sessionId) {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              typeof block === "object" &&
              block !== null &&
              "type" in block &&
              (block as { type: string }).type === "tool_result"
            ) {
              const tr = block as { type: string; tool_use_id: string; content?: unknown; is_error?: boolean };
              const pending = pendingToolCalls.get(tr.tool_use_id);
              if (pending) {
                const elapsedMs = Date.now() - pending.startMs;
                const raw = typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content ?? "");
                try {
                  const { updateToolCallResult } = await import("../db/activity.js");
                  await updateToolCallResult(pending.dbId, {
                    toolOutput: raw,
                    outcome: tr.is_error ? "error" : "ok",
                    elapsedMs,
                  });
                } catch (dbErr) {
                  console.error("[client] Failed to persist tool result:", dbErr);
                }
                pendingToolCalls.delete(tr.tool_use_id);
              }
            }
          }
        }
      }

      // ── Tool progress ticks ───────────────────────────────────────────────
      if (message.type === "tool_progress" && opts.sessionId && opts.trackId) {
        const progressEvent: AgentToolProgressEvent = {
          sessionId: opts.sessionId,
          trackId: opts.trackId,
          toolUseId: message.tool_use_id,
          toolName: message.tool_name,
          elapsedSec: message.elapsed_time_seconds,
        };
        ipcBus.emit("agent-tool-progress", progressEvent);
      }

      // ── Final result ──────────────────────────────────────────────────────
      if (message.type === "result") {
        if (message.subtype !== "success") {
          const error = new Error(`Claude agent error (${message.subtype}): ${message.errors.join(", ")}`);
          handleApiLimitError(error, opts, "Anthropic");
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
    handleApiLimitError(streamError, opts, "Anthropic");
    throw streamError;
  }

  const error = new Error("Claude agent stream ended without a result message");
  handleApiLimitError(error, opts, "Anthropic");
  throw error;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const provider = getModelProvider(opts.modelConfig.model as SupportedModel);
  const stopHeartbeat = startHeartbeat(opts);

  try {
    if (provider === "openrouter") {
      const credential = requireRuntimeCredential("openrouter");
      emitRuntimeEvent({
        scope: opts.trackId === "orchestrator" ? "session" : "track",
        kind: "waiting",
        severity: "info",
        trackId: opts.trackId === "orchestrator" ? undefined : opts.trackId,
        title: "Submitting request to OpenRouter",
        detail: opts.modelConfig.model,
        stage: "Waiting For Model",
      });

      try {
        const response = await getOpenRouter(credential.secret ?? "").chat.completions.create({
          model: opts.modelConfig.model,
          messages: [
            { role: "system", content: opts.systemPrompt },
            { role: "user", content: opts.prompt },
          ],
        });

        const text = response.choices[0]?.message?.content?.trim() ?? "";
        if (text) emitResearchLog(opts.trackId, text + "\n");
        return { result: text, costUsd: 0, turns: 1 };
      } catch (error) {
        handleApiLimitError(error, opts, "OpenRouter");
        throw error;
      }
    }

    if (provider === "openai") {
      const credential = requireRuntimeCredential("openai");
      emitRuntimeEvent({
        scope: opts.trackId === "orchestrator" ? "session" : "track",
        kind: "waiting",
        severity: "info",
        trackId: opts.trackId === "orchestrator" ? undefined : opts.trackId,
        title: "Submitting request to OpenAI",
        detail: opts.modelConfig.model,
        stage: "Waiting For Model",
      });

      try {
        const response = await getOpenAI(credential.secret ?? "").responses.create({
          model: opts.modelConfig.model,
          input: [
            { role: "system", content: [{ type: "input_text", text: opts.systemPrompt }] },
            { role: "user", content: [{ type: "input_text", text: opts.prompt }] },
          ],
        });

        const text = response.output_text?.trim() ?? "";
        if (text) emitResearchLog(opts.trackId, text + "\n");
        return { result: text, costUsd: 0, turns: 1 };
      } catch (error) {
        handleApiLimitError(error, opts, "OpenAI");
        throw error;
      }
    }

    const credential = requireRuntimeCredential("anthropic");
    emitRuntimeEvent({
      scope: opts.trackId === "orchestrator" ? "session" : "track",
      kind: "waiting",
      severity: "info",
      trackId: opts.trackId === "orchestrator" ? undefined : opts.trackId,
      title: "Submitting request to Claude Code",
      detail: opts.modelConfig.model,
      stage: "Waiting For Model",
    });

    if (credential.source === "api_key") {
      return withTemporaryEnv("ANTHROPIC_API_KEY", credential.secret ?? "", async () => {
        const stream = query({
          prompt: opts.prompt,
          options: getAnthropicRequestOptions(opts),
        });
        return runClaudeStream(stream, opts);
      });
    }

    // Anthropic Claude auth path uses the local Claude Code session and tools.
    const stream = query({
      prompt: opts.prompt,
      options: getAnthropicRequestOptions(opts),
    });
    return runClaudeStream(stream, opts);
  } finally {
    stopHeartbeat();
  }
}
