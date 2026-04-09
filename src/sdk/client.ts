import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { RunModelConfig, SupportedModel } from "../types/provider.js";
import { getModelProvider } from "../types/provider.js";

let _openai: OpenAI | null = null;
let _anthropic: Anthropic | null = null;

function getOpenAI(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
  return _openai;
}

function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env["ANTHROPIC_API_KEY"] });
  return _anthropic;
}

export interface AgentRunOptions {
  systemPrompt: string;
  prompt: string;
  modelConfig: RunModelConfig;
  cwd?: string;
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

    return { result: response.output_text?.trim() ?? "", costUsd: 0, turns: 1 };
  }

  // Anthropic
  if (!process.env["ANTHROPIC_API_KEY"]) throw new Error("ANTHROPIC_API_KEY environment variable is not set.");

  const response = await getAnthropic().messages.create({
    model: opts.modelConfig.model,
    max_tokens: 8192,
    system: opts.systemPrompt,
    messages: [{ role: "user", content: opts.prompt }],
  });

  const block = response.content.find((b) => b.type === "text");
  return { result: block?.type === "text" ? block.text.trim() : "", costUsd: 0, turns: 1 };
}
