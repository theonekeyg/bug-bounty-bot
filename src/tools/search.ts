import { z } from "zod";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import { emitRuntimeEvent } from "../ipc/bus.js";

// ── Web search ────────────────────────────────────────────────────────────────

const WebSearchInput = z.object({
  query: z.string().min(1),
  maxResults: z.number().int().min(1).max(10).default(5),
});

export const webSearchTool: ToolDefinition<z.infer<typeof WebSearchInput>> = {
  name: "web_search",
  description:
    "Search the web for CVE details, vulnerability writeups, documentation, or exploit techniques.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
      maxResults: { type: "number", description: "Max results to return (1-10, default 5)." },
    },
    required: ["query"],
  },
  async execute(input): Promise<ToolResult> {
    const { query, maxResults } = WebSearchInput.parse(input);
    // Uses the claude-agent-sdk's built-in web_search tool when available.
    // This wrapper is a passthrough that will be intercepted by the SDK runner.
    // See: src/sdk/client.ts — builtinTools handling.
    return {
      success: true,
      output: JSON.stringify({ __builtin: "web_search", query, maxResults }),
    };
  },
};

// ── URL fetch ─────────────────────────────────────────────────────────────────

const FetchUrlInput = z.object({
  url: z.string().url(),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  maxBytes: z.number().int().positive().max(10_000_000).default(1_000_000),
});

export const fetchUrlTool: ToolDefinition<z.infer<typeof FetchUrlInput>> = {
  name: "fetch_url",
  description:
    "Fetch a URL — download files, probe API endpoints, retrieve HTML/JSON. Respects maxBytes limit.",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL to fetch." },
      method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"] },
      headers: { type: "object", additionalProperties: { type: "string" } },
      body: { type: "string", description: "Request body for POST/PUT." },
      maxBytes: { type: "number", description: "Max response size in bytes (default 1MB)." },
    },
    required: ["url"],
  },
  async execute(input): Promise<ToolResult> {
    const { url, method, headers, body, maxBytes } = FetchUrlInput.parse(input);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ?? undefined,
        signal: AbortSignal.timeout(30_000),
      });

      // Check for API limit responses
      if (res.status === 429 || res.status === 402) {
        const errorText = await res.text();
        emitRuntimeEvent({
          scope: "track",
          kind: "error",
          severity: "error",
          title: "API limit reached",
          detail: `HTTP ${res.status}: Rate limit or quota exceeded while fetching ${url}`,
          stage: "API Limit",
        });
        return {
          success: false,
          output: "",
          error: `API limit reached (HTTP ${res.status}): ${errorText}`,
        };
      }

      const contentType = res.headers.get("content-type") ?? "";
      const buffer = await res.arrayBuffer();
      const bytes = buffer.byteLength;

      if (bytes > maxBytes) {
        return {
          success: false,
          output: "",
          error: `Response too large: ${bytes} bytes (limit ${maxBytes})`,
        };
      }

      const text = new TextDecoder().decode(buffer);
      const summary = [
        `status: ${res.status} ${res.statusText}`,
        `content-type: ${contentType}`,
        `bytes: ${bytes}`,
        `body:\n${text}`,
      ].join("\n");

      return { success: res.ok, output: summary };
    } catch (err) {
      return { success: false, output: "", error: String(err) };
    }
  },
};
