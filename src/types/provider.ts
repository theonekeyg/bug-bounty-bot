import { z } from "zod";

export const SUPPORTED_MODELS = [
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.3-codex",
  "gpt-5.2-codex",
] as const;

export type SupportedModel = (typeof SUPPORTED_MODELS)[number];

export const SupportedModelSchema = z.enum(SUPPORTED_MODELS);

export const RunModelConfigSchema = z.object({
  model: SupportedModelSchema,
});

export type RunModelConfig = z.infer<typeof RunModelConfigSchema>;

export const DEFAULT_MODEL: SupportedModel = "gpt-5.4";

export const MODEL_OPTIONS: { value: SupportedModel; label: string; description: string }[] = [
  { value: "gpt-5.4",       label: "GPT-5.4",        description: "Latest flagship model" },
  { value: "gpt-5.4-mini",  label: "GPT-5.4 Mini",   description: "Lower-latency GPT-5.4" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex",  description: "Coding-optimised GPT-5.3" },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex",  description: "Coding-optimised GPT-5.2" },
];
