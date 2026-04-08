import { readFile, writeFile, readdir, appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../types/index.js";

const ReadFileInput = z.object({ path: z.string() });
const WriteFileInput = z.object({ path: z.string(), content: z.string() });
const AppendFileInput = z.object({ path: z.string(), content: z.string() });
const ListDirInput = z.object({ path: z.string(), recursive: z.boolean().default(false) });
const GrepInput = z.object({
  pattern: z.string(),
  path: z.string(),
  fileGlob: z.string().optional(),
  caseSensitive: z.boolean().default(true),
});

export const readFileTool: ToolDefinition<z.infer<typeof ReadFileInput>> = {
  name: "read_file",
  description: "Read the contents of a local file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative path to the file." },
    },
    required: ["path"],
  },
  async execute(input): Promise<ToolResult> {
    const { path } = ReadFileInput.parse(input);
    try {
      const content = await readFile(path, "utf-8");
      return { success: true, output: content };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

export const writeFileTool: ToolDefinition<z.infer<typeof WriteFileInput>> = {
  name: "write_file",
  description: "Write content to a local file, creating parent directories as needed.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative path to write." },
      content: { type: "string", description: "Content to write." },
    },
    required: ["path", "content"],
  },
  async execute(input): Promise<ToolResult> {
    const { path, content } = WriteFileInput.parse(input);
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf-8");
      return { success: true, output: `Written: ${path}` };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

export const appendFileTool: ToolDefinition<z.infer<typeof AppendFileInput>> = {
  name: "append_file",
  description: "Append content to a file (used for progress.md logs).",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  async execute(input): Promise<ToolResult> {
    const { path, content } = AppendFileInput.parse(input);
    try {
      await mkdir(dirname(path), { recursive: true });
      const entry = `\n---\n${new Date().toISOString()}\n${content}`;
      await appendFile(path, entry, "utf-8");
      return { success: true, output: `Appended to: ${path}` };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

export const listDirTool: ToolDefinition<z.infer<typeof ListDirInput>> = {
  name: "list_dir",
  description: "List files in a directory.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string" },
      recursive: { type: "boolean", description: "List recursively (default false)." },
    },
    required: ["path"],
  },
  async execute(input): Promise<ToolResult> {
    const { path, recursive } = ListDirInput.parse(input);
    try {
      const entries = await listEntries(path, recursive);
      return { success: true, output: entries.join("\n") };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};

async function listEntries(dir: string, recursive: boolean, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const rel = join(prefix, entry.name);
    results.push(rel);
    if (recursive && entry.isDirectory()) {
      results.push(...(await listEntries(join(dir, entry.name), true, rel)));
    }
  }
  return results;
}

export const grepCodebaseTool: ToolDefinition<z.infer<typeof GrepInput>> = {
  name: "grep_codebase",
  description: "Search for a regex pattern across files. Returns matching lines with file:line context.",
  input_schema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern to search for." },
      path: { type: "string", description: "Directory or file to search in." },
      fileGlob: { type: "string", description: "Glob to filter files, e.g. '*.ts'" },
      caseSensitive: { type: "boolean" },
    },
    required: ["pattern", "path"],
  },
  async execute(input): Promise<ToolResult> {
    const { pattern, path, fileGlob, caseSensitive } = GrepInput.parse(input);
    if (!existsSync(path)) {
      return { success: false, output: "", error: `Path not found: ${path}` };
    }
    // Build ripgrep args
    const args = ["--line-number", "--with-filename", "--color=never"];
    if (!caseSensitive) args.push("--ignore-case");
    if (fileGlob) args.push("--glob", fileGlob);
    args.push(pattern, path);

    try {
      const proc = Bun.spawn(["rg", ...args], { stderr: "pipe" });
      const output = await new Response(proc.stdout).text();
      await proc.exited;
      return { success: true, output: output || "(no matches)" };
    } catch (err) {
      return { success: false, output: "", error: `ripgrep not found: ${String(err)}` };
    }
  },
};
