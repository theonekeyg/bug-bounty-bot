import { z } from "zod";

/** A tool definition in the Anthropic tool-call format. */
export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
  execute: (input: TInput) => Promise<ToolResult>;
}

export const ToolResultSchema = z.object({
  success: z.boolean(),
  output: z.string(),
  error: z.string().optional(),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

/** Context injected into every tool call. */
export interface ToolContext {
  subagentId: string;
  stateDir: string;
  outputDir: string;
}
