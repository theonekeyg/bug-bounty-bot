import { query } from "@anthropic-ai/claude-agent-sdk";
import OpenAI from "openai";
import type { RunModelConfig, SupportedModel } from "../types/provider.js";
import { getModelProvider } from "../types/provider.js";
import { ipcBus } from "../ipc/bus.js";
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
    if (opts.persistHeartbeats) {
      void appendProgress(trackId, note);
    }
    lastNotedAt = now;
  }, 5000);

  return () => clearInterval(timer);
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const provider = getModelProvider(opts.modelConfig.model as SupportedModel);
  const stopHeartbeat = startHeartbeat(opts);

  try {
    if (provider === "openai") {
      if (!process.env["OPENAI_API_KEY"]) throw new Error("OPENAI_API_KEY environment variable is not set.");

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

    for await (const message of stream) {
      // Stream text deltas to the UI in real time
      if (message.type === "stream_event") {
        const event = message.event;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta"
        ) {
          emitResearchLog(opts.trackId, event.delta.text);
        }
      }

      if (message.type === "result") {
        if (message.subtype !== "success") {
          throw new Error(`Claude agent error (${message.subtype}): ${message.errors.join(", ")}`);
        }
        return {
          result: message.result.trim(),
          costUsd: message.total_cost_usd,
          turns: message.num_turns,
        };
      }
    }

    throw new Error("Claude agent stream ended without a result message");
  } finally {
    stopHeartbeat();
  }
}
