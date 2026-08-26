import { readMikiEnv } from "@miki/config";
import type { LLMResponse } from "@miki/config";
import {
  directProviderForModel,
  normalizeDirectModelName,
  resolveProviderApiKey,
  type DirectProviderConfig,
} from "./catalog.js";
import {
  claudeNativeCompletion,
  clearAnthropicClientCache,
} from "./anthropic-adapter.js";
import { openAICompatibleAdapter } from "./openai-compatible-adapter.js";
import type {
  LLMProviderAdapter,
  ProviderCompletionRequest,
  ProviderConnectionResult,
  ProviderModel,
} from "./contracts.js";
import { LLMMissingCredentialError, LLMAPIError } from "./errors.js";
import { ensureLocalRuntime } from "../local/local-runtime.js";
import { ProviderPluginRegistry } from "./sdk/registry.js";
import { builtinProviderPlugins } from "./sdk/builtin.js";
import type { MikiProviderMessage } from "./sdk/index.js";

function nativeClaudeEnabled(): boolean {
  const value = process.env.CLAUDE_NATIVE;
  return (
    value === undefined || (value !== "0" && value.toLowerCase() !== "false")
  );
}

function workspaceDir(): string {
  return (
    readMikiEnv("MIKI_CONFIG_DIR") ||
    readMikiEnv("MIKI_WORKSPACE_DIR") ||
    process.cwd()
  );
}

class AnthropicNativeAdapter implements LLMProviderAdapter {
  readonly providerId = "claude";

  complete(request: ProviderCompletionRequest): Promise<LLMResponse> {
    return claudeNativeCompletion(
      request.messages as Parameters<typeof claudeNativeCompletion>[0],
      request.model,
      request.apiKey,
      request.extra,
    );
  }

  clearCache(): void {
    clearAnthropicClientCache();
  }
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
    this.register(new AnthropicNativeAdapter());
    this.pluginRegistry = new ProviderPluginRegistry({
      workspaceDir: workspaceDir(),
      configDir: workspaceDir(),
      resolveCredentials: (auth, providerId) => {
        if (auth.mode === "local" || auth.mode === "none") return {};
        const provider = directProviderForModel(`${providerId}/model`);
        const apiKey = provider
          ? resolveProviderApiKey(provider, workspaceDir())
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

  adapterFor(provider: DirectProviderConfig): LLMProviderAdapter {
    return (
      this.adapters.get(
        provider.id === "claude" ? "claude" : "openai-compatible",
      ) ?? openAICompatibleAdapter
    );
  }

  resolve(model: string): DirectProviderConfig | undefined {
    return directProviderForModel(model);
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
    extra?: Record<string, unknown>,
  ): Promise<LLMResponse> {
    const provider = this.resolve(model);
    if (!provider) {
      throw new LLMMissingCredentialError(
        `No supported provider matches model "${model}".`,
      );
    }

    if (messages.some((message) => message.audio)) {
      const audioSupport = await this.supportsAudio(model);
      if (audioSupport === false) {
        throw new LLMAPIError(
          `The selected cloud model "${model}" does not support audio input. Choose an audio-capable model or install a local voice model.`,
          { providerId: provider.id },
        );
      }
    }

    const plugin = this.pluginRegistry.get(provider.id);
    if (plugin && !(provider.id === "claude" && !nativeClaudeEnabled())) {
      return this.pluginRegistry.complete(model, messages, { extra });
    }

    // Local llama.cpp routing is deliberately resolved before any remote
    // credential lookup. A local request may start a managed loopback server,
    // but it must never resolve or transmit a Gemini/OpenAI/etc. secret.
    if (provider.id === "llama.cpp") {
      const runtime = await ensureLocalRuntime(model);
      return openAICompatibleAdapter.complete({
        provider: { ...provider, baseUrl: runtime.baseUrl },
        model: runtime.model,
        apiKey: "local-no-auth-required",
        messages: messages as never,
        extra,
      });
    }

    const apiKey = resolveProviderApiKey(provider, workspaceDir());
    if (!apiKey && !provider.emptyApiKeyAllowed) {
      throw new LLMMissingCredentialError(
        `No API key is configured for ${provider.displayName}.`,
        { providerId: provider.id },
      );
    }

    const request: ProviderCompletionRequest = {
      provider,
      model: normalizeDirectModelName(provider.id, model),
      apiKey: apiKey ?? "",
      messages: messages as never,
      extra,
    };

    const adapter = this.adapterFor(provider);
    if (provider.id === "claude" && !nativeClaudeEnabled()) {
      return openAICompatibleAdapter.complete(request);
    }
    return adapter.complete(request);
  }

  listModels(
    provider: DirectProviderConfig,
    apiKey: string,
    timeoutMs?: number,
  ): Promise<ProviderModel[]> {
    const adapter = this.adapterFor(provider);
    if (!adapter.listModels) return Promise.resolve([]);
    return adapter.listModels(provider, apiKey, timeoutMs);
  }

  testConnection(
    provider: DirectProviderConfig,
    apiKey: string,
    timeoutMs?: number,
  ): Promise<ProviderConnectionResult> {
    const adapter = this.adapterFor(provider);
    if (!adapter.testConnection)
      return Promise.resolve({
        ok: false,
        latencyMs: 0,
        error: "Connection testing is not supported.",
      });
    return adapter.testConnection(provider, apiKey, timeoutMs);
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
