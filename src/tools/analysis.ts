/**
 * Static analysis tools: Semgrep and npm audit.
 * These run inside the Boxer sandbox via run_command,
 * but are exposed as dedicated tools for clarity.
 */

import { z } from "zod";
import type { BoxerClient } from "../sandbox/boxer.js";
import type { ToolDefinition, ToolResult } from "../types/index.js";

const SemgrepInput = z.object({
  path: z.string(),
  rules: z
    .array(z.string())
    .default(["p/security-audit", "p/owasp-top-ten", "p/secrets"])
    .describe("Semgrep rule IDs or registry packs."),
  workspaceId: z.string().optional(),
});

const NpmAuditInput = z.object({
  path: z.string().describe("Path to the package.json directory."),
  workspaceId: z.string().optional(),
  severity: z.enum(["low", "moderate", "high", "critical"]).default("moderate"),
});

interface AnalysisToolOptions {
  boxer: BoxerClient;
  trackId: string;
}

export function makeSemgrepTool(opts: AnalysisToolOptions): ToolDefinition<z.infer<typeof SemgrepInput>> {
  return {
    name: "run_semgrep",
    description:
      "Run Semgrep static analysis on a codebase. Returns findings as JSON. Runs inside Boxer sandbox.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Local path to the codebase to scan." },
        rules: {
          type: "array",
          items: { type: "string" },
          description: "Semgrep rule packs (default: security-audit, owasp-top-ten, secrets).",
        },
        workspaceId: { type: "string" },
      },
      required: ["path"],
    },
    async execute(input): Promise<ToolResult> {
      const { path, rules, workspaceId } = SemgrepInput.parse(input);
      const rulesArg = rules.map((r) => `--config ${r}`).join(" ");
      const cmd = `semgrep ${rulesArg} --json ${path}`;

      try {
        const result = await opts.boxer.runShell(cmd, {
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          network: "sandbox", // needs to pull rules
          timeoutSecs: 120,
          image: "semgrep/semgrep:latest",
        });
        return { success: result.exitCode === 0, output: result.stdout || result.stderr };
      } catch (err) {
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}

export function makeNpmAuditTool(opts: AnalysisToolOptions): ToolDefinition<z.infer<typeof NpmAuditInput>> {
  return {
    name: "run_npm_audit",
    description:
      "Run npm audit on a project to find dependency vulnerabilities. Returns JSON findings.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory containing package.json." },
        workspaceId: { type: "string" },
        severity: {
          type: "string",
          enum: ["low", "moderate", "high", "critical"],
          description: "Minimum severity to report.",
        },
      },
      required: ["path"],
    },
    async execute(input): Promise<ToolResult> {
      const { path, workspaceId, severity } = NpmAuditInput.parse(input);
      const cmd = `cd ${path} && npm audit --json --audit-level=${severity}`;

      try {
        const result = await opts.boxer.runShell(cmd, {
          ...(workspaceId !== undefined ? { workspaceId } : {}),
          network: "sandbox", // needs npm registry
          timeoutSecs: 60,
          image: "node:20-slim",
        });
        return { success: true, output: result.stdout || result.stderr };
      } catch (err) {
        return { success: false, output: "", error: String(err) };
      }
    },
  };
}
