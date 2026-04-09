import OpenAI from "openai";
import type { RunModelConfig } from "../types/provider.js";

let _openai: OpenAI | null = null;
function getClient(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env["OPENAI_API_KEY"] });
  return _openai;
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
  if (!process.env["OPENAI_API_KEY"]) {
    throw new Error("OPENAI_API_KEY environment variable is not set.");
  }

  const response = await getClient().responses.create({
    model: opts.modelConfig.model,
    input: [
      { role: "system", content: [{ type: "input_text", text: opts.systemPrompt }] },
      { role: "user",   content: [{ type: "input_text", text: opts.prompt }] },
    ],
  });

  return {
    result: response.output_text?.trim() ?? "",
    costUsd: 0,
    turns: 1,
  };
}
