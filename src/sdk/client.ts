import { query } from "@anthropic-ai/claude-agent-sdk";
import OpenAI from "openai";
import type { RunModelConfig, SupportedModel } from "../types/provider.js";
import { getModelProvider, getModelThinking } from "../types/provider.js";
import { resolveRuntimeCredential } from "../credentials/runtime.js";
import { ipcBus, emitRuntimeEvent } from "../ipc/bus.js";
import type { AgentThinkingEvent, AgentTurnEvent, AgentToolProgressEvent } from "../ipc/bus.js";
import { appendProgress } from "../loop/state.js";
import type { AgentTurnInfo, ToolCallInfo } from "../types/activity.js";
import { BoxerClient } from "../sandbox/boxer.js";

export interface AgentRunOptions {
  systemPrompt: string;
  prompt: string;
  modelConfig: RunModelConfig;
  cwd?: string;
  sessionId?: string; // for DB event persistence and progress logging
  subagentId?: string; // used to stream progress back to the UI
  iteration?: number; // Ralph Loop iteration index (for activity tracking)
  allowedTools?: string[];
  persistHeartbeats?: boolean;
  /** When true, the Bash tool routes through Boxer (gVisor). When false (default), runs on the local machine. */
  sandbox?: boolean;
  /** Boxer API base URL. Required when sandbox is true. */
  boxerUrl?: string;
  /** Boxer workspace ID to attach for persistent filesystem across turns. */
  workspaceId?: string;
  /** Abort controller — abort() will cancel the in-flight agent call. */
  abortController?: AbortController;
}

export interface AgentRunResult {
  result: string;
  costUsd: number;
  turns: number;
}

function emitResearchLog(subagentId: string | undefined, text: string): void {
  if (!subagentId) return;
  ipcBus.emit("research-log", { subagentId, text });
}

async function appendModelTrace(
  sessionId: string | undefined,
  subagentId: string | undefined,
  thinking: string,
  text: string,
): Promise<void> {
  if (!sessionId || !subagentId) return;

  const sections: string[] = [];
  const trimmedThinking = thinking.trim();
  const trimmedText = text.trim();

  if (trimmedThinking) {
    sections.push(`**Thinking**\n${trimmedThinking}`);
  }
  if (trimmedText) {
    sections.push(`**Model Output**\n${trimmedText}`);
  }
  if (sections.length === 0) return;

  await appendProgress(sessionId, subagentId, sections.join("\n\n"));
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
      message.includes("limit reached") ||
      message.includes("throttled") ||
      status === 429 ||
      status === 402 ||
      status === 503
    );
  }
  return false;
}

function handleApiLimitError(
  error: unknown,
  opts: Pick<AgentRunOptions, "subagentId" | "sessionId">,
  provider: string,
): void {
  const { subagentId, sessionId } = opts;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const isLimit = isApiLimitError(error);

  if (isLimit) {
    emitRuntimeEvent({
      scope: subagentId === "orchestrator" ? "session" : "subagent",
      kind: "error",
      severity: "error",
      subagentId: subagentId === "orchestrator" ? undefined : subagentId,
      title: "API limit reached",
      detail: `${provider} API quota exceeded. Please check your usage and billing status.`,
      stage: "API Limit",
    });

    if (subagentId && sessionId) {
      void appendProgress(
        sessionId,
        subagentId,
        `\n[API LIMIT] ${provider} API quota exceeded. Request failed: ${errorMessage}\n`,
      );
    }
  }
}

function startHeartbeat(opts: AgentRunOptions): () => void {
  const subagentId = opts.subagentId;
  if (!subagentId) return () => undefined;

  const startedAt = Date.now();
  let lastNotedAt = startedAt;

  const timer = setInterval(() => {
    const now = Date.now();
    if (now - lastNotedAt < 15000) return;

    const elapsedSec = Math.floor((now - startedAt) / 1000);
    const note = `[run] Still waiting for model output... (${elapsedSec}s elapsed)`;

    emitResearchLog(subagentId, `\n${note}\n`);
    emitRuntimeEvent({
      scope: subagentId === "orchestrator" ? "session" : "subagent",
      kind: "heartbeat",
      severity: "info",
      subagentId: subagentId === "orchestrator" ? undefined : subagentId,
      title: "Still waiting for model output",
      detail: `${elapsedSec}s elapsed`,
      stage: "Waiting For Model",
    });
    if (opts.persistHeartbeats && opts.sessionId) {
      void appendProgress(opts.sessionId, subagentId, note);
    }
    lastNotedAt = now;

    // Detect potential API limit/hang after 60 seconds
    if (elapsedSec > 60) {
      const provider = getModelProvider(opts.modelConfig.model as SupportedModel);
      const timeoutError = new Error(`API request timeout after ${elapsedSec}s - possible rate limit or service issue`);
      handleApiLimitError(timeoutError, opts, provider);
    }
  }, 5000);

  return () => clearInterval(timer);
}

const openaiClients = new Map<string, OpenAI>();
const openrouterClients = new Map<string, OpenAI>();

type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Injected in tests to intercept HTTP calls before the OpenAI client is constructed. */
let _fetchOverride: FetchFn | undefined;

/**
 * Override the fetch function used by all OpenAI/OpenRouter clients.
 * Clears the client cache so next call creates a fresh client with the new fetch.
 * Pass `undefined` to restore default behaviour.
 */
export function __setFetchForTesting(f: FetchFn | undefined): void {
  _fetchOverride = f;
  openaiClients.clear();
  openrouterClients.clear();
}

function getOpenAI(secret: string): OpenAI {
  const cached = openaiClients.get(secret);
  if (cached) return cached;
  const client = new OpenAI({ apiKey: secret, ...(_fetchOverride ? { fetch: _fetchOverride } : {}) });
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
    ...(_fetchOverride ? { fetch: _fetchOverride } : {}),
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

function getAnthropicRequestOptions(opts: AgentRunOptions): Record<string, unknown> {
  const thinkingMode = getModelThinking(opts.modelConfig.model as SupportedModel);
  const thinkingConfig =
    thinkingMode?.type === "adaptive" ? { type: "adaptive" as const } :
    thinkingMode?.type === "enabled"  ? { type: "enabled" as const, budgetTokens: thinkingMode.budgetTokens } :
    undefined;

  return {
    systemPrompt: opts.systemPrompt,
    model: opts.modelConfig.model,
    ...(opts.allowedTools && opts.allowedTools.length > 0 ? { allowedTools: opts.allowedTools } : {}),
    allowDangerouslySkipPermissions: true,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(thinkingConfig ? { thinking: thinkingConfig } : {}),
    // OS-level sandbox for the Claude Code subprocess. Only enabled when sandbox mode is on.
    // failIfUnavailable: false allows graceful degradation on platforms where sandbox is unavailable.
    // allowLocalBinding lets Bash reach the Boxer API at localhost:8080 via curl.
    ...(opts.sandbox ? {
      sandbox: {
        enabled: true,
        failIfUnavailable: false,
        network: {
          allowLocalBinding: true,
        },
      },
    } : {}),
  };
}

async function runClaudeStream(
  stream: AsyncIterable<any>,
  opts: AgentRunOptions,
): Promise<AgentRunResult> {
  let announcedOutput = false;
  let turnIndex = 0;
  // Each entry holds the DB id, start time, AND a reference to the mutable ToolCallInfo object
  // so we can update it in-place and re-emit the turn event with correct outcomes.
  const pendingToolCalls = new Map<string, { dbId: string; startMs: number; tc: ToolCallInfo }>();
  let lastTurnEvent: AgentTurnEvent | null = null;

  try {
    for await (const message of stream) {
      // ── Stream deltas (text + thinking) ──────────────────────────────────
      if (message.type === "stream_event") {
        const event = message.event;
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            if (!announcedOutput) {
              emitRuntimeEvent({
                scope: opts.subagentId === "orchestrator" ? "session" : "subagent",
                kind: "stage_changed",
                severity: "info",
                subagentId: opts.subagentId === "orchestrator" ? undefined : opts.subagentId,
                title: "Model is producing output",
                detail: opts.modelConfig.model,
                stage: "Generating Output",
              });
              announcedOutput = true;
            }
            emitResearchLog(opts.subagentId, event.delta.text);
          } else if (event.delta.type === "thinking_delta" && opts.sessionId && opts.subagentId) {
            const thinkingEvent: AgentThinkingEvent = {
              sessionId: opts.sessionId,
              subagentId: opts.subagentId,
              thinking: event.delta.thinking,
            };
            ipcBus.emit("agent-thinking", thinkingEvent);
          }
        }
      }

      // ── Completed assistant turn ──────────────────────────────────────────
      if (message.type === "assistant" && opts.sessionId && opts.subagentId) {
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

        await appendModelTrace(opts.sessionId, opts.subagentId, thinkingText, textOutput);

        try {
          const { insertAgentTurn, insertToolCall } = await import("../db/activity.js");
          const turnId = await insertAgentTurn({
            sessionId: opts.sessionId,
            subagentId: opts.subagentId,
            iteration: opts.iteration ?? 1,
            turnIndex,
            thinkingText,
            textOutput,
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
            cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
          });

          // Build mutable ToolCallInfo objects — we'll update them in-place when results arrive
          const toolCallObjects: ToolCallInfo[] = [];
          for (const tu of toolUseBlocks) {
            const tcId = await insertToolCall({
              turnId,
              toolUseId: tu.id,
              toolName: tu.name,
              toolInput: JSON.stringify(tu.input),
            });
            const tc: ToolCallInfo = {
              id: tcId,
              toolUseId: tu.id,
              toolName: tu.name,
              toolInput: JSON.stringify(tu.input),
              toolOutput: "",
              outcome: "pending",
              elapsedMs: 0,
              startedAt: new Date().toISOString(),
              completedAt: null,
            };
            toolCallObjects.push(tc);
            pendingToolCalls.set(tu.id, { dbId: tcId, startMs: Date.now(), tc });
          }

          const turnInfo: AgentTurnInfo = {
            id: turnId,
            sessionId: opts.sessionId,
            subagentId: opts.subagentId,
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
            toolCalls: toolCallObjects,
          };
          lastTurnEvent = {
            sessionId: opts.sessionId,
            subagentId: opts.subagentId,
            turn: turnInfo,
          };
          ipcBus.emit("agent-turn", lastTurnEvent);
        } catch (dbErr) {
          console.error("[client] Failed to persist agent turn:", dbErr);
        }
      }

      // ── Tool results (user message with tool_result blocks) ───────────────
      if (message.type === "user" && opts.sessionId) {
        const content = message.message.content;
        if (Array.isArray(content)) {
          let anyToolResultProcessed = false;
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
                const outcome = tr.is_error ? "error" : "ok";
                try {
                  const { updateToolCallResult } = await import("../db/activity.js");
                  await updateToolCallResult(pending.dbId, { toolOutput: raw, outcome, elapsedMs });
                } catch (dbErr) {
                  console.error("[client] Failed to persist tool result:", dbErr);
                }
                // Update the in-memory object so re-emitting the turn event shows correct results
                pending.tc.toolOutput = raw;
                pending.tc.outcome = outcome;
                pending.tc.elapsedMs = elapsedMs;
                pending.tc.completedAt = new Date().toISOString();
                pendingToolCalls.delete(tr.tool_use_id);
                anyToolResultProcessed = true;
              }
            }
          }
          // Re-emit the turn with updated tool outcomes so the UI reflects results immediately
          if (anyToolResultProcessed && lastTurnEvent && opts.subagentId) {
            ipcBus.emit("agent-turn", lastTurnEvent);
          }
        }
      }

      // ── Tool progress ticks ───────────────────────────────────────────────
      if (message.type === "tool_progress" && opts.sessionId && opts.subagentId) {
        const progressEvent: AgentToolProgressEvent = {
          sessionId: opts.sessionId,
          subagentId: opts.subagentId,
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
    // Abort triggered by stop signal — return empty result instead of propagating
    if (opts.abortController?.signal.aborted) {
      return { result: "", costUsd: 0, turns: turnIndex };
    }
    handleApiLimitError(streamError, opts, "Anthropic");
    throw streamError;
  }

  // If we exited the loop because the stream was aborted, return cleanly
  if (opts.abortController?.signal.aborted) {
    return { result: "", costUsd: 0, turns: turnIndex };
  }

  const error = new Error("Claude agent stream ended without a result message");
  handleApiLimitError(error, opts, "Anthropic");
  throw error;
}

// ── OpenRouter agentic loop ───────────────────────────────────────────────────
// Implements a full tool-calling loop using the OpenAI-compatible API,
// with local tool execution and thinking extraction.

type FunctionToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

type OAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: FunctionToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

/** Extract thinking text from an OpenRouter response message.
 *  Supports `reasoning_content` field (Qwen3/DeepSeek) and `<think>…</think>` tags. */
function extractOpenRouterThinking(message: OpenAI.Chat.Completions.ChatCompletionMessage): {
  thinking: string;
  text: string;
} {
  const reasoningContent = (message as unknown as Record<string, unknown>)["reasoning_content"];
  if (typeof reasoningContent === "string" && reasoningContent.trim()) {
    return { thinking: reasoningContent.trim(), text: (message.content ?? "").trim() };
  }
  const content = message.content ?? "";
  const thinkMatch = content.match(/^<think>([\s\S]*?)<\/think>\s*/);
  if (thinkMatch?.[1]) {
    return { thinking: thinkMatch[1].trim(), text: content.slice(thinkMatch[0].length).trim() };
  }
  return { thinking: "", text: content.trim() };
}

/** Tool definitions in OpenAI function-calling format (matches Claude Code tool schemas). */
const OPENROUTER_TOOL_DEFS: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "Write",
      description: "Write content to a file (creates parent directories if needed).",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Absolute or relative path to write." },
          content: { type: "string", description: "Content to write to the file." },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Read",
      description: "Read a file and return its contents.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to read." },
          limit: { type: "number", description: "Max lines to read (default: all)." },
          offset: { type: "number", description: "Line number to start reading from." },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Edit",
      description: "Edit a file by replacing exact string occurrences.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string" },
          old_string: { type: "string", description: "Exact string to find (must be unique in file)." },
          new_string: { type: "string", description: "Replacement string." },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Glob",
      description: "Find files matching a glob pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern, e.g. '**/*.ts'." },
          path: { type: "string", description: "Directory to search in (default: cwd)." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Grep",
      description: "Search file contents for a regex pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for." },
          path: { type: "string", description: "Directory or file to search (default: cwd)." },
          glob: { type: "string", description: "Glob filter for files, e.g. '*.ts'." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "Bash",
      description: "Execute a bash command inside an isolated Boxer (gVisor) sandbox. No host filesystem access. Default network: none.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run." },
          timeout: { type: "number", description: "Timeout in milliseconds (default: 30000)." },
          network: {
            type: "string",
            enum: ["none", "sandbox", "host"],
            description: "Network mode. Default: none. Use 'sandbox' for outbound access.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "WebFetch",
      description: "Fetch the text content of a URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch." },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "WebSearch",
      description: "Search the web for CVE details, vulnerability writeups, documentation, or exploit techniques. Returns titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          maxResults: { type: "number", description: "Max results to return (1-10, default 5)." },
        },
        required: ["query"],
      },
    },
  },
];

/** Execute a tool, routing Bash through Boxer when available. */
async function executeLocalTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
  boxer?: BoxerClient,
  workspaceId?: string,
): Promise<string> {
  const { readFile, writeFile, mkdir } = await import("fs/promises");
  const { existsSync } = await import("fs");
  const { join, dirname, resolve } = await import("path");
  const resolvePath = (p: string) => (p.startsWith("/") ? p : resolve(cwd, p));

  if (name === "Write") {
    const filePath = resolvePath(String(input["file_path"] ?? ""));
    const content = String(input["content"] ?? "");
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return `Wrote ${content.length} bytes to ${filePath}`;
  }

  if (name === "Read") {
    const filePath = resolvePath(String(input["file_path"] ?? ""));
    if (!existsSync(filePath)) return `Error: file not found: ${filePath}`;
    const lines = (await readFile(filePath, "utf-8")).split("\n");
    const offset = typeof input["offset"] === "number" ? input["offset"] : 0;
    const limit = typeof input["limit"] === "number" ? input["limit"] : lines.length;
    return lines.slice(offset, offset + limit).join("\n");
  }

  if (name === "Edit") {
    const filePath = resolvePath(String(input["file_path"] ?? ""));
    if (!existsSync(filePath)) return `Error: file not found: ${filePath}`;
    const old = String(input["old_string"] ?? "");
    const next = String(input["new_string"] ?? "");
    const content = await readFile(filePath, "utf-8");
    if (!content.includes(old)) return `Error: old_string not found in file`;
    await writeFile(filePath, content.replace(old, next), "utf-8");
    return "Edit applied successfully";
  }

  if (name === "Glob") {
    const { glob } = await import("tinyglobby");
    const pattern = String(input["pattern"] ?? "**/*");
    const dir = resolvePath(String(input["path"] ?? cwd));
    const files = await glob(pattern, { cwd: dir, absolute: false });
    return files.length ? files.join("\n") : "(no matches)";
  }

  if (name === "Grep") {
    const { execSync } = await import("child_process");
    const pattern = String(input["pattern"] ?? "");
    const searchPath = resolvePath(String(input["path"] ?? cwd));
    const globFilter = input["glob"] ? `--glob '${String(input["glob"])}'` : "";
    try {
      const result = execSync(`rg --no-heading -n ${globFilter} ${JSON.stringify(pattern)} ${JSON.stringify(searchPath)}`, {
        encoding: "utf-8", timeout: 10000, maxBuffer: 512 * 1024,
      });
      return result.trim() || "(no matches)";
    } catch (e: unknown) {
      const err = e as { stdout?: string; status?: number };
      if (err.status === 1) return "(no matches)";
      return `Error: ${String(e)}`;
    }
  }

  if (name === "Bash") {
    const command = String(input["command"] ?? "");
    const timeoutMs = typeof input["timeout"] === "number" ? input["timeout"] : 30000;

    if (boxer) {
      const networkMode = (["none", "sandbox", "host"].includes(String(input["network"])))
        ? String(input["network"]) as "none" | "sandbox" | "host"
        : "none";
      try {
        const result = await boxer.runShell(command, {
          ...(workspaceId ? { workspaceId } : {}),
          network: networkMode,
          timeoutSecs: Math.max(1, Math.ceil(timeoutMs / 1000)),
        });
        const parts = [
          result.stdout?.trim(),
          result.stderr?.trim() ? `stderr:\n${result.stderr.trim()}` : "",
          `exit_code: ${result.exitCode}`,
        ].filter(Boolean);
        return parts.join("\n") || "(no output)";
      } catch (e) {
        return `Error (Boxer): ${String(e)}`;
      }
    } else {
      // No sandbox — run directly on the local machine.
      const { execSync } = await import("child_process");
      try {
        const output = execSync(command, {
          cwd,
          timeout: timeoutMs,
          encoding: "utf-8",
          maxBuffer: 4 * 1024 * 1024,
        });
        return output || "(no output)";
      } catch (e: unknown) {
        const err = e as { stdout?: string; stderr?: string; status?: number };
        const parts = [
          err.stdout?.trim(),
          err.stderr?.trim() ? `stderr:\n${err.stderr.trim()}` : "",
          `exit_code: ${err.status ?? 1}`,
        ].filter(Boolean);
        return parts.join("\n") || `Error: ${String(e)}`;
      }
    }
  }

  if (name === "WebFetch") {
    const url = String(input["url"] ?? "");
    try {
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      const text = await resp.text();
      // Strip HTML tags for readability
      return text.replace(/<[^>]+>/g, " ").replace(/\s{3,}/g, "\n").slice(0, 8192);
    } catch (e) {
      return `Error fetching ${url}: ${String(e)}`;
    }
  }

  if (name === "WebSearch") {
    const query = String(input["query"] ?? "");
    const maxResults = Math.min(10, Math.max(1, typeof input["maxResults"] === "number" ? input["maxResults"] : 5));
    try {
      // DuckDuckGo lite — no API key required
      const params = new URLSearchParams({ q: query, kl: "us-en" });
      const resp = await fetch(`https://html.duckduckgo.com/html/?${params}`, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; security-research-bot/1.0)" },
        signal: AbortSignal.timeout(15000),
      });
      const html = await resp.text();
      // Extract result blocks: title, URL, snippet
      const results: { title: string; url: string; snippet: string }[] = [];
      const blockRe = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]+class="result__url"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
      let m: RegExpExecArray | null;
      while ((m = blockRe.exec(html)) !== null && results.length < maxResults) {
        results.push({
          url: m[1]?.trim() ?? "",
          title: (m[2] ?? "").replace(/<[^>]+>/g, "").trim(),
          snippet: (m[4] ?? "").replace(/<[^>]+>/g, "").trim(),
        });
      }
      if (results.length === 0) return `No results found for: ${query}`;
      return results.map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`).join("\n\n");
    } catch (e) {
      return `Error searching for "${query}": ${String(e)}`;
    }
  }

  return `Error: unknown tool "${name}"`;
}

/** Filter tool definitions to only those the agent is allowed to use. */
function filterToolDefs(
  defs: OpenAI.Chat.Completions.ChatCompletionTool[],
  allowed: string[] | undefined,
): OpenAI.Chat.Completions.ChatCompletionTool[] {
  if (!allowed || allowed.length === 0) return defs;
  return defs.filter((d) => {
    const name = (d as { function?: { name?: string } }).function?.name;
    return name != null && allowed.includes(name);
  });
}

async function runOpenRouterAgentLoop(
  client: OpenAI,
  opts: AgentRunOptions,
): Promise<AgentRunResult> {
  const { insertAgentTurn, insertToolCall, updateToolCallResult } = await import("../db/activity.js");
  const useThinking = getModelThinking(opts.modelConfig.model as SupportedModel)?.type === "openrouter";
  const toolDefs = filterToolDefs(OPENROUTER_TOOL_DEFS, opts.allowedTools);
  const boxer = (opts.sandbox && opts.boxerUrl) ? new BoxerClient(opts.boxerUrl) : undefined;

  const messages: OAIMessage[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user", content: opts.prompt },
  ];

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let turnIndex = 0;
  let totalToolCalls = 0;
  let lastResult = "";
  const cwd = opts.cwd ?? process.cwd();

  for (let loop = 0; loop < 100; loop++) {
    if (opts.abortController?.signal.aborted) {
      return { result: lastResult, costUsd: 0, turns: turnIndex };
    }

    const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming & Record<string, unknown> = {
      model: opts.modelConfig.model,
      messages: messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      stream: false,
      ...(toolDefs.length > 0 ? { tools: toolDefs, tool_choice: "auto" } : {}),
      ...(useThinking ? { enable_thinking: true } : {}),
    };

    const response = await client.chat.completions.create(requestParams) as OpenAI.Chat.Completions.ChatCompletion;

    const choice = response.choices[0];
    if (!choice) break;

    const msg = choice.message;
    totalInputTokens += response.usage?.prompt_tokens ?? 0;
    totalOutputTokens += response.usage?.completion_tokens ?? 0;
    turnIndex++;

    const { thinking, text } = extractOpenRouterThinking(msg);
    const toolCallBlocks = (msg.tool_calls ?? []) as FunctionToolCall[];
    lastResult = text;

    // Stream thinking to UI
    if (thinking && opts.sessionId && opts.subagentId) {
      const thinkEvent: AgentThinkingEvent = { sessionId: opts.sessionId, subagentId: opts.subagentId, thinking };
      ipcBus.emit("agent-thinking", thinkEvent);
    }

    // Log to progress.md
    await appendModelTrace(opts.sessionId, opts.subagentId, thinking, text);

    // Record turn to DB and emit event
    if (opts.sessionId && opts.subagentId) {
      const toolCallObjects: ToolCallInfo[] = [];
      let dbTurnId: string | undefined;

      try {
        dbTurnId = await insertAgentTurn({
          sessionId: opts.sessionId,
          subagentId: opts.subagentId,
          iteration: opts.iteration ?? 1,
          turnIndex,
          thinkingText: thinking,
          textOutput: text,
          inputTokens: response.usage?.prompt_tokens ?? 0,
          outputTokens: response.usage?.completion_tokens ?? 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });

        for (const tc of toolCallBlocks) {
          const tcId = await insertToolCall({
            turnId: dbTurnId,
            toolUseId: tc.id,
            toolName: tc.function.name,
            toolInput: tc.function.arguments,
          });
          const tcObj: ToolCallInfo = {
            id: tcId,
            toolUseId: tc.id,
            toolName: tc.function.name,
            toolInput: tc.function.arguments,
            toolOutput: "",
            outcome: "pending",
            elapsedMs: 0,
            startedAt: new Date().toISOString(),
            completedAt: null,
          };
          toolCallObjects.push(tcObj);
        }
      } catch (dbErr) {
        console.error("[openrouter] Failed to persist turn:", dbErr);
      }

      const turnInfo: AgentTurnInfo = {
        id: dbTurnId ?? "",
        sessionId: opts.sessionId,
        subagentId: opts.subagentId,
        iteration: opts.iteration ?? 1,
        turnIndex,
        thinkingText: thinking,
        textOutput: text,
        inputTokens: response.usage?.prompt_tokens ?? 0,
        outputTokens: response.usage?.completion_tokens ?? 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        startedAt: new Date().toISOString(),
        completedAt: null,
        toolCalls: toolCallObjects,
      };
      const turnEvent: AgentTurnEvent = { sessionId: opts.sessionId, subagentId: opts.subagentId, turn: turnInfo };
      ipcBus.emit("agent-turn", turnEvent);

      // Execute tool calls
      if (toolCallBlocks.length > 0) {
        const assistantMsg: OAIMessage = { role: "assistant", content: msg.content, tool_calls: toolCallBlocks };
        messages.push(assistantMsg);

        for (let i = 0; i < toolCallBlocks.length; i++) {
          const tc = toolCallBlocks[i]!;
          const tcObj = toolCallObjects[i];
          const startMs = Date.now();
          let toolOutput = "";
          let outcome = "ok";

          try {
            const input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            emitResearchLog(opts.subagentId, `\n[tool] ${tc.function.name}: ${tc.function.arguments.slice(0, 120)}\n`);
            toolOutput = await executeLocalTool(tc.function.name, input, cwd, boxer, opts.workspaceId);
            emitResearchLog(opts.subagentId, `[tool result] ${toolOutput.slice(0, 300)}\n`);
          } catch (e) {
            toolOutput = `Error: ${String(e)}`;
            outcome = "error";
          }

          const elapsedMs = Date.now() - startMs;
          totalToolCalls++;

          // Update DB
          if (dbTurnId && tcObj) {
            try {
              const tcDbId = tcObj.id;
              await updateToolCallResult(tcDbId, { toolOutput, outcome, elapsedMs });
              // Update in-memory object for re-emit
              tcObj.toolOutput = toolOutput;
              tcObj.outcome = outcome;
              tcObj.elapsedMs = elapsedMs;
              tcObj.completedAt = new Date().toISOString();
            } catch (dbErr) {
              console.error("[openrouter] Failed to persist tool result:", dbErr);
            }
          }

          messages.push({ role: "tool", content: toolOutput, tool_call_id: tc.id });
        }

        // Re-emit turn with resolved tool results
        ipcBus.emit("agent-turn", turnEvent);

        if (opts.sessionId && opts.subagentId) {
          await appendProgress(opts.sessionId, opts.subagentId, `[tools] Executed ${toolCallBlocks.length} tool(s) this turn`);
        }
        continue; // next loop iteration — send tool results back to model
      }

      // No tool calls — mark turn complete
      turnInfo.completedAt = new Date().toISOString();
      ipcBus.emit("agent-turn", turnEvent);
    } else {
      // No sessionId/subagentId — just append to messages and continue
      if (toolCallBlocks.length > 0) {
        messages.push({ role: "assistant", content: msg.content, tool_calls: toolCallBlocks });
        for (const tc of toolCallBlocks) {
          const input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          const toolOutput = await executeLocalTool(tc.function.name, input, cwd, boxer, opts.workspaceId);
          messages.push({ role: "tool", content: toolOutput, tool_call_id: tc.id });
        }
        continue;
      }
    }

    // No tool calls → final response
    if (choice.finish_reason === "stop" || toolCallBlocks.length === 0) {
      if (text) emitResearchLog(opts.subagentId, text + "\n");
      break;
    }
  }

  return { result: lastResult, costUsd: 0, turns: turnIndex };
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const provider = getModelProvider(opts.modelConfig.model as SupportedModel);
  const stopHeartbeat = startHeartbeat(opts);

  try {
    if (provider === "openrouter") {
      const credential = requireRuntimeCredential("openrouter");
      emitRuntimeEvent({
        scope: opts.subagentId === "orchestrator" ? "session" : "subagent",
        kind: "waiting",
        severity: "info",
        subagentId: opts.subagentId === "orchestrator" ? undefined : opts.subagentId,
        title: "Running agent loop via OpenRouter",
        detail: opts.modelConfig.model,
        stage: "Waiting For Model",
      });
      if (opts.sessionId && opts.subagentId) {
        await appendProgress(opts.sessionId, opts.subagentId,
          `[run] Requested model: ${opts.modelConfig.model} via openrouter`);
      }

      try {
        return await runOpenRouterAgentLoop(getOpenRouter(credential.secret ?? ""), opts);
      } catch (error) {
        handleApiLimitError(error, opts, "OpenRouter");
        throw error;
      }
    }

    if (provider === "openai") {
      const credential = requireRuntimeCredential("openai");
      emitRuntimeEvent({
        scope: opts.subagentId === "orchestrator" ? "session" : "subagent",
        kind: "waiting",
        severity: "info",
        subagentId: opts.subagentId === "orchestrator" ? undefined : opts.subagentId,
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
        await appendModelTrace(opts.sessionId, opts.subagentId, "", text);
        if (text) emitResearchLog(opts.subagentId, text + "\n");
        return { result: text, costUsd: 0, turns: 1 };
      } catch (error) {
        handleApiLimitError(error, opts, "OpenAI");
        throw error;
      }
    }

    const credential = requireRuntimeCredential("anthropic");
    emitRuntimeEvent({
      scope: opts.subagentId === "orchestrator" ? "session" : "subagent",
      kind: "waiting",
      severity: "info",
      subagentId: opts.subagentId === "orchestrator" ? undefined : opts.subagentId,
      title: "Submitting request to Claude Code",
      detail: opts.modelConfig.model,
      stage: "Waiting For Model",
    });

    if (credential.source === "api_key") {
      return withTemporaryEnv("ANTHROPIC_API_KEY", credential.secret ?? "", async () => {
        const stream = query({
          prompt: opts.prompt,
          options: {
            ...getAnthropicRequestOptions(opts),
            ...(opts.abortController ? { abortController: opts.abortController } : {}),
          },
        });
        return runClaudeStream(stream, opts);
      });
    }

    // Anthropic Claude auth path uses the local Claude Code session and tools.
    const stream = query({
      prompt: opts.prompt,
      options: {
        ...getAnthropicRequestOptions(opts),
        ...(opts.abortController ? { abortController: opts.abortController } : {}),
      },
    });
    return runClaudeStream(stream, opts);
  } finally {
    stopHeartbeat();
  }
}
