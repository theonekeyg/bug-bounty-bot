import { z } from "zod";

export const ModelProviderSchema = z.enum(["claude_code", "openai"]);
export type ModelProvider = z.infer<typeof ModelProviderSchema>;

export const RunModelConfigSchema = z.object({
  provider: ModelProviderSchema.default("claude_code"),
  model: z.string().min(1),
});

export type RunModelConfig = z.infer<typeof RunModelConfigSchema>;

export const DEFAULT_MODELS = {
  claude_code: "sonnet",
  openai: "gpt-5",
} as const satisfies Record<ModelProvider, string>;
