import { query } from "@anthropic-ai/claude-agent-sdk";
import OpenAI from "openai";
import type { RunModelConfig, SupportedModel } from "../types/provider.js";
import { getModelProvider } from "../types/provider.js";
import { ipcBus } from "../ipc/bus.js";

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
}

export interface AgentRunResult {
  result: string;
  costUsd: number;
  turns: number;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const provider = getModelProvider(opts.modelConfig.model as SupportedModel);

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
    if (opts.trackId && text) {
      ipcBus.emit("research-log", { trackId: opts.trackId, text: text + "\n" });
    }
    return { result: text, costUsd: 0, turns: 1 };
  }

  // Anthropic — uses Claude Code subscription via the agent SDK (no API key needed).
  // Requires `claude auth login` to have been run once on this machine.
  const stream = query({
    prompt: opts.prompt,
    options: {
      systemPrompt: opts.systemPrompt,
      model: opts.modelConfig.model,
      allowedTools: [],
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
        event.delta.type === "text_delta" &&
        opts.trackId
      ) {
        ipcBus.emit("research-log", { trackId: opts.trackId, text: event.delta.text });
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
}
