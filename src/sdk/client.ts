/**
 * Wrapper around @anthropic-ai/claude-agent-sdk.
 *
 * The SDK runs Claude Code as a subprocess using your local `claude` binary
 * and subscription — no API key needed, just `claude auth login`.
 *
 * Agents use Claude Code's native tools (Bash, Read, Write, Glob, Grep, WebFetch).
 * For sandboxed execution, agents call Boxer via curl through the Bash tool.
 */

import { execSync } from "child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";

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
  /** Working directory for the agent. Defaults to process.cwd(). */
  cwd?: string;
}

export interface AgentRunResult {
  result: string;
  costUsd: number;
  turns: number;
}

/**
 * Run one agent turn. Claude Code handles all tool calls natively.
 * Returns when the agent signals completion.
 */
export async function runAgent(opts: AgentRunOptions): Promise<AgentRunResult> {
  const q = query({
    prompt: opts.prompt,
    options: {
      systemPrompt: opts.systemPrompt,
      pathToClaudeCodeExecutable: claudeBinaryPath,
      cwd: opts.cwd ?? process.cwd(),
      executable: "bun",
      tools: { type: "preset", preset: "claude_code" },
      // Auto-allow all tools — this is a local security research tool
      // with the user's explicit permission.
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
