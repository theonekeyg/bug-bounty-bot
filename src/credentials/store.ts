import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { dirname } from "path";
import type {
  CredentialSource,
  Provider,
  ProviderSourceStatus,
  ProviderStatus,
} from "../types/provider.js";

export type SecretCodec = {
  isAvailable: () => boolean;
  encrypt: (value: string) => string;
  decrypt: (value: string) => string;
};

export type CredentialValidationResult = {
  ok: boolean;
  errorMessage?: string;
};

export type CredentialValidator = (input: {
  provider: Provider;
  source: CredentialSource;
  secret: string | null;
}) => Promise<CredentialValidationResult>;

type SecretStore = Partial<Record<Provider, Partial<Record<CredentialSource, string>>>>;

type StoredSourceStatus = Omit<ProviderSourceStatus, "source">;

type StoredProviderState = {
  activeSource: CredentialSource | null;
  sources: Partial<Record<CredentialSource, StoredSourceStatus>>;
};

type MetadataStore = Partial<Record<Provider, StoredProviderState>>;

function nowIso(): string {
  return new Date().toISOString();
}

function isCredentialSource(value: string): value is CredentialSource {
  return value === "api_key" || value === "claude_auth";
}

function emptyStatus(source: CredentialSource): StoredSourceStatus {
  return {
    state: "missing",
    lastValidatedAt: null,
    errorMessage: null,
  };
}

function statusFromStored(source: CredentialSource, stored?: StoredSourceStatus): ProviderSourceStatus {
  return {
    source,
    state: stored?.state ?? "missing",
    lastValidatedAt: stored?.lastValidatedAt ?? null,
    errorMessage: stored?.errorMessage ?? null,
  };
}

export class ProviderCredentialStore {
  private readonly metadataPath: string;
  private readonly secretPath: string;
  private readonly codec: SecretCodec;
  private readonly validator: CredentialValidator;
  private metadata: MetadataStore = {};
  private secrets: SecretStore = {};

  constructor(input: {
    metadataPath: string;
    secretPath: string;
    codec: SecretCodec;
    validator: CredentialValidator;
  }) {
    this.metadataPath = input.metadataPath;
    this.secretPath = input.secretPath;
    this.codec = input.codec;
    this.validator = input.validator;
  }

  async load(): Promise<void> {
    await mkdir(this.dirName(this.metadataPath), { recursive: true });

    this.metadata = await this.readJsonFile<MetadataStore>(this.metadataPath, {});
    this.secrets = await this.readSecrets();
    this.normalizeMetadata();
  }

  async saveCredential(input: {
    provider: Provider;
    source: CredentialSource;
    secret: string | null;
  }): Promise<ProviderStatus> {
    this.assertSourceSupported(input.provider, input.source);
    const timestamp = nowIso();

    this.setSourceStatus(input.provider, input.source, {
      state: "testing",
      lastValidatedAt: timestamp,
      errorMessage: null,
    });
    await this.persistMetadata();

    const validation = await this.validator(input);

    if (!validation.ok) {
      this.setSourceStatus(input.provider, input.source, {
        state: "invalid",
        lastValidatedAt: timestamp,
        errorMessage: validation.errorMessage ?? "Validation failed",
      });
      await this.persistMetadata();
      return this.getProviderStatus(input.provider);
    }

    if (input.source === "api_key") {
      this.setSecret(input.provider, input.source, input.secret ?? "");
    }

    this.setSourceStatus(input.provider, input.source, {
      state: "ready",
      lastValidatedAt: timestamp,
      errorMessage: null,
    });
    this.setActiveSource(input.provider, input.source);
    await this.persistAll();
    return this.getProviderStatus(input.provider);
  }

  async testCredential(input: {
    provider: Provider;
    source: CredentialSource;
    secret: string | null;
  }): Promise<CredentialValidationResult> {
    this.assertSourceSupported(input.provider, input.source);
    return this.validator(input);
  }

  async deleteCredential(input: {
    provider: Provider;
    source: CredentialSource;
  }): Promise<ProviderStatus> {
    this.assertSourceSupported(input.provider, input.source);
    const providerState = this.metadata[input.provider] ?? this.createProviderState(input.provider);
    delete providerState.sources[input.source];
    if (input.source === "api_key") {
      delete this.secrets[input.provider]?.[input.source];
      if (this.secrets[input.provider] && Object.keys(this.secrets[input.provider]!).length === 0) {
        delete this.secrets[input.provider];
      }
    }
    if (providerState.activeSource === input.source) {
      providerState.activeSource = this.pickNextActiveSource(input.provider);
    }
    this.metadata[input.provider] = providerState;
    this.normalizeMetadata();
    await this.persistAll();
    return this.getProviderStatus(input.provider);
  }

  async setActiveSource(provider: Provider, source: CredentialSource): Promise<ProviderStatus> {
    this.assertSourceSupported(provider, source);
    const state = this.metadata[provider] ?? this.createProviderState(provider);
    state.activeSource = source;
    this.metadata[provider] = state;
    await this.persistMetadata();
    return this.getProviderStatus(provider);
  }

  getProviderStatus(provider: Provider): ProviderStatus {
    const stored = this.metadata[provider] ?? this.createProviderState(provider);
    const supportedSources: readonly CredentialSource[] =
      provider === "anthropic" ? ["claude_auth", "api_key"] : ["api_key"];
    const sources = Object.fromEntries(
      supportedSources.map((source) => [source, statusFromStored(source, stored.sources[source])]),
    ) as Partial<Record<CredentialSource, ProviderSourceStatus>>;

    const activeSource = stored.activeSource ?? this.pickNextActiveSource(provider);
    const activeStatus = activeSource ? sources[activeSource] : undefined;
    const state = activeStatus?.state ?? "missing";

    return {
      provider,
      state,
      source: activeSource,
      activeSource,
      lastValidatedAt: activeStatus?.lastValidatedAt ?? null,
      errorMessage: activeStatus?.errorMessage ?? null,
      supportedSources,
      sources,
    };
  }

  getAllProviderStatuses(): ProviderStatus[] {
    const providers: Provider[] = ["openai", "anthropic", "openrouter"];
    return providers.map((provider) => this.getProviderStatus(provider));
  }

  resolveRuntimeCredential(provider: Provider): { provider: Provider; source: CredentialSource; secret: string | null } | null {
    const status = this.getProviderStatus(provider);
    const source = status.activeSource ?? status.supportedSources.find((candidate) => status.sources[candidate]?.state === "ready") ?? null;
    if (!source) return null;

    if (source === "claude_auth") {
      if (status.sources[source]?.state !== "ready") return null;
      return { provider, source, secret: null };
    }

    const secret = this.secrets[provider]?.[source] ?? null;
    if (!secret) return null;
    if (status.sources[source]?.state !== "ready") return null;
    return { provider, source, secret };
  }

  private createProviderState(provider: Provider): StoredProviderState {
    const supportedSources: readonly CredentialSource[] =
      provider === "anthropic" ? ["claude_auth", "api_key"] : ["api_key"];
    return {
      activeSource: null,
      sources: Object.fromEntries(supportedSources.map((source) => [source, emptyStatus(source)])) as Partial<
        Record<CredentialSource, StoredSourceStatus>
      >,
    };
  }

  private pickNextActiveSource(provider: Provider): CredentialSource | null {
    const state = this.metadata[provider];
    if (!state) return null;
    const preferred = state.activeSource;
    if (preferred && state.sources[preferred]?.state === "ready") return preferred;
    for (const source of ["claude_auth", "api_key"] as const) {
      if (state.sources[source]?.state === "ready") return source;
    }
    return null;
  }

  private setSourceStatus(provider: Provider, source: CredentialSource, patch: StoredSourceStatus): void {
    const state = this.metadata[provider] ?? this.createProviderState(provider);
    const existing = state.sources[source] ?? emptyStatus(source);
    state.sources[source] = { ...existing, ...patch };
    this.metadata[provider] = state;
  }

  private setSecret(provider: Provider, source: CredentialSource, secret: string): void {
    if (!this.secrets[provider]) this.secrets[provider] = {};
    this.secrets[provider]![source] = secret;
  }

  private normalizeMetadata(): void {
    const providers: Provider[] = ["openai", "anthropic", "openrouter"];
    for (const provider of providers) {
      const state = this.metadata[provider] ?? this.createProviderState(provider);
      const supportedSources: readonly CredentialSource[] =
        provider === "anthropic" ? ["claude_auth", "api_key"] : ["api_key"];

      for (const source of supportedSources) {
        state.sources[source] ??= emptyStatus(source);
      }

      if (state.activeSource && !isCredentialSource(state.activeSource)) {
        state.activeSource = null;
      }

      if (!state.activeSource) {
        state.activeSource = this.pickNextActiveSource(provider);
      }

      this.metadata[provider] = state;
    }
  }

  private async persistMetadata(): Promise<void> {
    await writeFile(this.metadataPath, JSON.stringify(this.metadata, null, 2), "utf-8");
  }

  private async persistAll(): Promise<void> {
    await Promise.all([this.persistMetadata(), this.persistSecrets()]);
  }

  private async persistSecrets(): Promise<void> {
    if (!this.hasSecrets()) {
      try {
        await unlink(this.secretPath);
      } catch {
        // No secrets file yet, or it was already removed.
      }
      return;
    }

    if (!this.codec.isAvailable()) {
      throw new Error("Secure storage is unavailable on this system.");
    }
    const encrypted = this.codec.encrypt(JSON.stringify(this.secrets));
    await writeFile(this.secretPath, encrypted, "utf-8");
  }

  private async readSecrets(): Promise<SecretStore> {
    try {
      const encrypted = await readFile(this.secretPath, "utf-8");
      if (!this.codec.isAvailable()) {
        return {};
      }
      return JSON.parse(this.codec.decrypt(encrypted)) as SecretStore;
    } catch {
      return {};
    }
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(path, "utf-8");
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private dirName(path: string): string {
    return dirname(path);
  }

  private hasSecrets(): boolean {
    return Object.values(this.secrets).some((providerSecrets) =>
      providerSecrets !== undefined && Object.values(providerSecrets).some((secret) => secret.length > 0),
    );
  }

  private assertSourceSupported(provider: Provider, source: CredentialSource): void {
    const supported = provider === "anthropic" ? ["claude_auth", "api_key"] : ["api_key"];
    if (!supported.includes(source)) {
      throw new Error(`${source} is not supported for ${provider}`);
    }
  }
}
