/**
 * Model provider client wrapper.
 *
 * - Claude Code provider uses @anthropic-ai/claude-agent-sdk and local `claude` auth.
 * - OpenAI provider uses API key (OPENAI_API_KEY) and responses API.
 */

import { execSync } from "child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import OpenAI from "openai";
import type { RunModelConfig } from "../types/provider.js";

function resolveClaudeBinary(): string {
  try {
    return execSync("which claude", { encoding: "utf-8" }).trim();
  } catch {
    for (const p of [
      `${process.env["HOME"] ?? ""}/.claude/local/claude`,
      "/usr/local/bin/claude",
    ]) {
      try {
        execSync(`test -x "${p}"`, { stdio: "ignore" });
        return p;
      } catch {
        /* try next */
      }
    }
  }
  throw new Error(
    "Claude binary not found. Run `claude auth login` and ensure `claude` is in PATH.",
  );
}

const claudeBinaryPath = resolveClaudeBinary();

export interface AgentRunOptions {
  systemPrompt: string;
  prompt: string;
  modelConfig: RunModelConfig;
  /** Working directory for the agent. Defaults to process.cwd(). */
  cwd?: string;
}

export interface AgentRunResult {
  result: string;
  costUsd: number;
  turns: number;
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  if (opts.modelConfig.provider === "openai") {
    return runOpenAIAgent(opts);
  }
  return runClaudeCodeAgent(opts);
}

async function runClaudeCodeAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const q = query({
    prompt: opts.prompt,
    options: {
      model: opts.modelConfig.model,
      systemPrompt: opts.systemPrompt,
      pathToClaudeCodeExecutable: claudeBinaryPath,
      cwd: opts.cwd ?? process.cwd(),
      executable: "bun",
      tools: { type: "preset", preset: "claude_code" },
      canUseTool: async (): Promise<PermissionResult> => ({ behavior: "allow" }),
    },
  });

  let lastText = "";
  let costUsd = 0;
  let turns = 0;

  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text") {
          lastText = block.text;
        }
      }
    } else if (msg.type === "result" && msg.subtype === "success") {
      costUsd = msg.total_cost_usd;
      turns = msg.num_turns;
      lastText = msg.result || lastText;
    }
  }

  return { result: lastText, costUsd, turns };
}

async function runOpenAIAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const apiKey = process.env["OPENAI_API_KEY"];
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required when provider is openai");
  }

  const client = new OpenAI({ apiKey });
  const response = await client.responses.create({
    model: opts.modelConfig.model,
    input: [
      { role: "system", content: [{ type: "input_text", text: opts.systemPrompt }] },
      { role: "user", content: [{ type: "input_text", text: opts.prompt }] },
    ],
  });

  const result = response.output_text?.trim() || "";
  const usage = response.usage;
  const turns = 1;
  const costUsd = 0;
  void usage;

  return { result, costUsd, turns };
}
