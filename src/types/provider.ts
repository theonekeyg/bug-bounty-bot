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
} as const;

export type Provider = keyof typeof PROVIDER_MODELS;

export const PROVIDERS: readonly { value: Provider; label: string }[] = [
  { value: "openai",    label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
];

export const SUPPORTED_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-haiku-4-5-20251001",
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];
export const SupportedModelSchema = z.enum(SUPPORTED_MODELS);
export const RunModelConfigSchema = z.object({ model: SupportedModelSchema });
export type RunModelConfig = z.infer<typeof RunModelConfigSchema>;

export const DEFAULT_MODEL: SupportedModel = "claude-sonnet-4-6";

export function getModelProvider(model: SupportedModel): Provider {
  return model.startsWith("claude") ? "anthropic" : "openai";
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
