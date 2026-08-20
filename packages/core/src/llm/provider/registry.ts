import { readMikiEnv } from "@miki/config";
import type { LLMResponse } from "@miki/config";
import type OpenAI from "openai";
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
import { LLMMissingCredentialError } from "./errors.js";

function nativeClaudeEnabled(): boolean {
  const value = process.env.CLAUDE_NATIVE;
  return value === undefined || (value !== "0" && value.toLowerCase() !== "false");
}

function workspaceDir(): string {
  return readMikiEnv("MIKI_CONFIG_DIR") || readMikiEnv("MIKI_WORKSPACE_DIR") || process.cwd();
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

  constructor() {
    this.register(openAICompatibleAdapter);
    this.register(new AnthropicNativeAdapter());
  }

  register(adapter: LLMProviderAdapter): void {
    this.adapters.set(adapter.providerId, adapter);
  }

  adapterFor(provider: DirectProviderConfig): LLMProviderAdapter {
    return this.adapters.get(provider.id === "claude" ? "claude" : "openai-compatible") ?? openAICompatibleAdapter;
  }

  resolve(model: string): DirectProviderConfig | undefined {
    return directProviderForModel(model);
  }

  async complete(
    model: string,
    messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
    extra?: Record<string, unknown>,
  ): Promise<LLMResponse> {
    const provider = this.resolve(model);
    if (!provider) {
      throw new LLMMissingCredentialError(`No supported provider matches model "${model}".`);
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
      messages,
      extra,
    };

    const adapter = this.adapterFor(provider);
    if (provider.id === "claude" && !nativeClaudeEnabled()) {
      return openAICompatibleAdapter.complete(request);
    }
    return adapter.complete(request);
  }

  listModels(provider: DirectProviderConfig, apiKey: string, timeoutMs?: number): Promise<ProviderModel[]> {
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
    if (!adapter.testConnection) return Promise.resolve({ ok: false, latencyMs: 0, error: "Connection testing is not supported." });
    return adapter.testConnection(provider, apiKey, timeoutMs);
  }

  clearCaches(): void {
    for (const adapter of this.adapters.values()) adapter.clearCache?.();
  }
}

export const providerRegistry = new ProviderRegistry();
