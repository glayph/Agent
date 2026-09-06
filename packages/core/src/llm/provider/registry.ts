import { readMikiEnv } from "@miki/config";
import { resolveConfiguredSecret, type LLMResponse } from "@miki/config";
import path from "node:path";
import {
  directProviderForModel,
  normalizeDirectModelName,
  type DirectProviderConfig,
} from "./catalog.js";
import { openAICompatibleAdapter } from "./openai-compatible-adapter.js";
import type {
  LLMProviderAdapter,
  ProviderConnectionResult,
  ProviderModel,
} from "./contracts.js";
import { LLMMissingCredentialError, LLMAPIError } from "./errors.js";
import { ProviderPluginRegistry } from "./sdk/registry.js";
import { builtinProviderPlugins } from "./sdk/builtin.js";
import type { MikiProviderMessage } from "./sdk/index.js";

function workspaceDir(): string {
  return (
    readMikiEnv("MIKI_CONFIG_DIR") ||
    readMikiEnv("MIKI_WORKSPACE_DIR") ||
    process.cwd()
  );
}

/**
 * Runtime registry for provider adapters. The registry is deliberately small:
 * it owns routing and lifecycle, while each adapter owns vendor SDK details.
 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, LLMProviderAdapter>();
  private readonly pluginRegistry: ProviderPluginRegistry;

  constructor() {
    this.register(openAICompatibleAdapter);
    this.pluginRegistry = new ProviderPluginRegistry({
      workspaceDir: workspaceDir(),
      configDir: workspaceDir(),
      resolveCredentials: (auth) => {
        if (auth.mode === "local" || auth.mode === "none") return {};
        const envVar = auth.envVars?.[0];
        const apiKey = envVar
          ? [workspaceDir(), path.join(workspaceDir(), "config")]
              .map((root) => resolveConfiguredSecret(envVar, root))
              .find((value): value is string => Boolean(value?.trim())) ||
            resolveConfiguredSecret(envVar)
          : "";
        return apiKey ? { apiKey } : {};
      },
      logger: (event, details) =>
        console.info(`[ProviderPlugin] ${event}`, details || {}),
    });
    for (const plugin of builtinProviderPlugins)
      this.pluginRegistry.register(plugin);
  }

  register(adapter: LLMProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  adapterFor(_provider: DirectProviderConfig): LLMProviderAdapter {
    return this.adapters.get("openai-compatible") ?? openAICompatibleAdapter;
  }

  resolve(model: string): DirectProviderConfig | undefined {
    const plugin = this.pluginRegistry.resolve(model);
    if (plugin) {
      return {
        id: plugin.manifest.id,
        displayName: plugin.manifest.displayName,
        baseUrl: plugin.manifest.ui?.defaultApiBase || "",
        apiKeyEnv: plugin.auth.envVars?.[0] || "",
        emptyApiKeyAllowed: plugin.auth.allowEmptyKey,
        local: plugin.manifest.capabilities.local,
      };
    }
    return directProviderForModel(model);
  }

  async isModelReady(
    model: string,
  ): Promise<{ available: boolean; reason?: string }> {
    const plugin = this.pluginRegistry.resolve(model);
    if (!plugin) {
      return {
        available: false,
        reason: `No provider plugin matches ${model}.`,
      };
    }
    // Remote credential validation remains in the provider completion path so
    // the user receives its precise authentication error. Local plugins expose
    // a truthful runtime health probe and must pass it before routing.
    //
    // NOTE (BUG-04 investigation): an earlier fix attempted to also check
    // credentials here for remote plugins, so an unconfigured Gemini would be
    // reported unavailable *before* routing to it. That broke the documented
    // contract (see provider-boundary.test.ts and multiple agent.ts tests)
    // that isModelReady() is a lightweight reachability probe, not a full
    // auth check, for remote providers — several tests intentionally rely on
    // resolution succeeding immediately so a mocked _callLlmApi can surface
    // its own error deterministically. BUG-04 (complex task routes to an
    // unconfigured remote model with no local fallback) is instead fixed at
    // the call site in agent.ts, which now catches the credential error from
    // the actual LLM call and retries once against the local model.
    if (!plugin.manifest.capabilities.local) return { available: true };
    const connection = await this.pluginRegistry.testConnection(
      plugin.manifest.id,
    );
    return connection.ok
      ? { available: true }
      : {
          available: false,
          reason:
            connection.error || `${plugin.manifest.id} runtime is not ready.`,
        };
  }

  async supportsAudio(model: string): Promise<boolean | undefined> {
    const plugin = this.pluginRegistry.resolve(model);
    if (!plugin) return false;
    const catalog = await this.pluginRegistry.catalog(plugin.manifest.id);
    if (!catalog?.models?.length) return undefined;
    const normalized = normalizeDirectModelName(
      plugin.manifest.id,
      model,
    ).toLowerCase();
    const selected = catalog.models.find(
      (item) => item.id.toLowerCase() === normalized,
    );
    return selected ? selected.input.includes("audio") : undefined;
  }

  async complete(
    model: string,
    messages: MikiProviderMessage[],
    options: {
      extra?: Record<string, unknown>;
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<LLMResponse> {
    const plugin = this.pluginRegistry.resolve(model);
    if (!plugin) {
      throw new LLMMissingCredentialError(
        `No supported provider plugin matches model "${model}".`,
      );
    }

    if (messages.some((message) => message.audio)) {
      const audioSupport = await this.supportsAudio(model);
      if (audioSupport === false) {
        throw new LLMAPIError(
          `The selected cloud model "${model}" does not support audio input. Choose an audio-capable model or install a local voice model.`,
          { providerId: plugin.manifest.id },
        );
      }
    }

    const pluginModel =
      plugin.manifest.capabilities.local && !model.includes("/")
        ? `${plugin.manifest.id}/${model}`
        : model;
    return this.pluginRegistry.complete(pluginModel, messages, {
      extra: options.extra,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  }

  async listModels(
    provider: DirectProviderConfig,
    apiKey: string,
    _timeoutMs?: number,
  ): Promise<ProviderModel[]> {
    const plugin = this.pluginRegistry.get(provider.id);
    if (!plugin?.listModels) return [];
    const models = await this.pluginRegistry.listModels(provider.id, {
      apiKey,
    });
    return models.map((item) => ({ id: item.id }));
  }

  async testConnection(
    provider: DirectProviderConfig,
    apiKey: string,
    _timeoutMs?: number,
  ): Promise<ProviderConnectionResult> {
    const plugin = this.pluginRegistry.get(provider.id);
    if (!plugin?.testConnection) {
      return {
        ok: false,
        latencyMs: 0,
        error: "Connection testing is not supported by this provider plugin.",
      };
    }
    return this.pluginRegistry.testConnection(provider.id, { apiKey });
  }

  clearCaches(): void {
    for (const adapter of this.adapters.values()) adapter.clearCache?.();
  }

  pluginDescriptors() {
    return this.pluginRegistry.descriptors();
  }

  getPluginRegistry(): ProviderPluginRegistry {
    return this.pluginRegistry;
  }
}

export const providerRegistry = new ProviderRegistry();
