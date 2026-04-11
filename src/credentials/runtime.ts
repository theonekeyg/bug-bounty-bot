import type { CredentialSource, Provider } from "../types/provider.js";

export type RuntimeCredential = {
  provider: Provider;
  source: CredentialSource;
  secret: string | null;
};

type CredentialResolver = (provider: Provider) => RuntimeCredential | null;

export function resolveFromEnv(provider: Provider): RuntimeCredential | null {
  if (provider === "openai") {
    const secret = process.env["OPENAI_API_KEY"];
    return secret ? { provider, source: "api_key", secret } : null;
  }

  if (provider === "openrouter") {
    const secret = process.env["OPENROUTER_API_KEY"];
    return secret ? { provider, source: "api_key", secret } : null;
  }

  if (provider === "anthropic") {
    const secret = process.env["ANTHROPIC_API_KEY"];
    return secret ? { provider, source: "api_key", secret } : null;
  }

  return null;
}

let credentialResolver: CredentialResolver = resolveFromEnv;

export function setCredentialResolver(resolver: CredentialResolver): void {
  credentialResolver = resolver;
}

export function resolveRuntimeCredential(provider: Provider): RuntimeCredential | null {
  return credentialResolver(provider);
}

export function resetCredentialResolver(): void {
  credentialResolver = resolveFromEnv;
}
