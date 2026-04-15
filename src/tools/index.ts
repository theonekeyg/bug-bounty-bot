import type { BoxerClient } from "../sandbox/boxer.js";
import type { ToolDefinition } from "../types/index.js";
import {
  readFileTool,
  writeFileTool,
  appendFileTool,
  listDirTool,
  grepCodebaseTool,
} from "./filesystem.js";
import { makeRunCommandTool } from "./command.js";
import { webSearchTool, fetchUrlTool } from "./search.js";
import { makeSemgrepTool, makeNpmAuditTool } from "./analysis.js";

export interface ToolRegistryOptions {
  subagentId: string;
  commandLogPath: string;
  boxer: BoxerClient;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildToolRegistry(opts: ToolRegistryOptions): ToolDefinition<any>[] {
  return [
    readFileTool,
    writeFileTool,
    appendFileTool,
    listDirTool,
    grepCodebaseTool,
    webSearchTool,
    fetchUrlTool,
    makeRunCommandTool({
      subagentId: opts.subagentId,
      commandLogPath: opts.commandLogPath,
      boxer: opts.boxer,
    }),
    makeSemgrepTool({ boxer: opts.boxer, subagentId: opts.subagentId }),
    makeNpmAuditTool({ boxer: opts.boxer, subagentId: opts.subagentId }),
  ];
}

export * from "./filesystem.js";
export * from "./command.js";
export * from "./search.js";
export * from "./analysis.js";
