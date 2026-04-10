import { z } from "zod";

export const PROVIDER_MODELS = {
  openai: [
    { value: "gpt-5.4",       label: "GPT-5.4",        description: "Latest flagship model" },
    { value: "gpt-5.4-mini",  label: "GPT-5.4 Mini",   description: "Lower-latency GPT-5.4" },
    { value: "gpt-5.3-codex", label: "GPT-5.3 Codex",  description: "Coding-optimised GPT-5.3" },
    { value: "gpt-5.2-codex", label: "GPT-5.2 Codex",  description: "Coding-optimised GPT-5.2" },
  ],
  anthropic: [
    { value: "claude-opus-4-6",            label: "Claude Opus 4.6",    description: "Most capable" },
    { value: "claude-sonnet-4-6",          label: "Claude Sonnet 4.6",  description: "Balanced speed & intelligence" },
    { value: "claude-haiku-4-5-20251001",  label: "Claude Haiku 4.5",   description: "Fast & compact" },
  ],
  // OpenRouter — all models use OpenAI-compatible chat completions at openrouter.ai/api/v1
  // Verify / update IDs at: https://openrouter.ai/models
  openrouter: [
    { value: "qwen/qwen-plus",                             label: "Qwen3 Plus",           description: "Alibaba Qwen Plus — strong reasoning & code" },
    { value: "thudm/glm-4-plus",                           label: "GLM-4 Plus",           description: "Zhipu AI GLM-4 Plus — multilingual" },
    { value: "nvidia/llama-3.1-nemotron-ultra-253b-v1",    label: "NVIDIA Nemotron Ultra", description: "NVIDIA Nemotron Ultra 253B" },
  ],
} as const;

export type Provider = keyof typeof PROVIDER_MODELS;

export const PROVIDERS: readonly { value: Provider; label: string }[] = [
  { value: "anthropic",  label: "Anthropic" },
  { value: "openai",     label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
];

export const SUPPORTED_MODELS = [
  // OpenAI
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  // Anthropic
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
  // OpenRouter
  "qwen/qwen-plus",
  "thudm/glm-4-plus",
  "nvidia/llama-3.1-nemotron-ultra-253b-v1",
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];
export const SupportedModelSchema = z.enum(SUPPORTED_MODELS);
export const RunModelConfigSchema = z.object({
  model: SupportedModelSchema,
  maxTracks: z.number().int().min(1).max(20).default(6),
});
export type RunModelConfig = z.infer<typeof RunModelConfigSchema>;

export const DEFAULT_MODEL: SupportedModel = "claude-sonnet-4-6";

export function getModelProvider(model: SupportedModel): Provider {
  if (model.startsWith("claude")) return "anthropic";
  if (model.includes("/")) return "openrouter"; // OpenRouter IDs are "org/model"
  return "openai";
}

export function getModelInfo(model: SupportedModel): { label: string; description: string } {
  for (const models of Object.values(PROVIDER_MODELS)) {
    const found = (models as readonly { value: string; label: string; description: string }[]).find(
      (m) => m.value === model,
    );
    if (found) return found;
  }
  return { label: model, description: "" };
}
