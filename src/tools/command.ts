/**
 * run_command tool — executes shell commands inside a Boxer sandbox.
 * Every invocation is appended to state/command_log.jsonl (non-negotiable).
 */

import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { z } from "zod";
import { BoxerClient } from "../sandbox/boxer.js";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import type { CommandLogEntry } from "../types/state.js";
import type { NetworkMode } from "../sandbox/types.js";

const RunCommandInput = z.object({
  command: z.string().min(1),
  workspaceId: z.string().optional(),
  network: z.enum(["none", "sandbox", "host"]).default("none"),
  timeoutSecs: z.number().positive().max(300).default(60),
  image: z.string().default("ubuntu:22.04"),
  networkJustification: z
    .string()
    .optional()
    .describe("Required when network !== 'none'. Explain why network access is needed."),
});

export type RunCommandInput = z.infer<typeof RunCommandInput>;

interface CommandToolOptions {
  trackId: string;
  commandLogPath: string;
  boxer: BoxerClient;
}

export function makeRunCommandTool(opts: CommandToolOptions): ToolDefinition<RunCommandInput> {
  return {
    name: "run_command",
    description: `Execute a shell command inside an isolated Boxer (gVisor) sandbox.
- Default network mode is 'none' (no external access).
- Use 'sandbox' or 'host' only when necessary, and provide networkJustification.
- All commands are logged to command_log.jsonl.
- Write outputs you need to persist to /workspace/ inside the container.`,
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        workspaceId: { type: "string", description: "Boxer workspace ID to attach." },
        network: {
          type: "string",
          enum: ["none", "sandbox", "host"],
          description: "Network mode. Default: none.",
        },
        timeoutSecs: { type: "number", description: "Hard timeout. Max 300s. Default 60s." },
        image: { type: "string", description: "Container image. Default: ubuntu:22.04." },
        networkJustification: {
          type: "string",
          description: "Required if network !== 'none'. Explain why.",
        },
      },
      required: ["command"],
    },
    async execute(input): Promise<ToolResult> {
      const parsed = RunCommandInput.parse(input);

      if (parsed.network !== "none" && !parsed.networkJustification) {
        return {
          success: false,
          output: "",
          error: "networkJustification is required when network is not 'none'.",
        };
      }

      const logEntry: CommandLogEntry = {
        timestamp: new Date().toISOString(),
        trackId: opts.trackId,
        cwd: "/workspace",
        command: parsed.command,
        exitCode: null,
        sandboxed: true,
      };

      try {
        const result = await opts.boxer.runShell(parsed.command, {
          ...(parsed.workspaceId !== undefined ? { workspaceId: parsed.workspaceId } : {}),
          network: parsed.network as NetworkMode,
          image: parsed.image,
          timeoutSecs: parsed.timeoutSecs,
        });

        logEntry.exitCode = result.exitCode;
        await writeLog(opts.commandLogPath, logEntry);

        const output = [
          result.stdout && `stdout:\n${result.stdout}`,
          result.stderr && `stderr:\n${result.stderr}`,
          `exit_code: ${result.exitCode}`,
          `wall_time_ms: ${result.wallTimeMs}`,
        ]
          .filter(Boolean)
          .join("\n");

        return {
          success: result.exitCode === 0,
          output,
          error: result.exitCode !== 0 ? `Command exited with code ${result.exitCode}` : undefined,
        };
      } catch (err) {
        await writeLog(opts.commandLogPath, logEntry);
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}

async function writeLog(logPath: string, entry: CommandLogEntry): Promise<void> {
  await mkdir(dirname(logPath), { recursive: true });
  await appendFile(logPath, JSON.stringify(entry) + "\n", "utf-8");
}
