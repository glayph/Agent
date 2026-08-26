import { claudeNativeCompletion } from "../anthropic-adapter.js";
import { openAICompatibleAdapter } from "../openai-compatible-adapter.js";
import {
  fetchDirectProviderModels,
  testDirectProviderConnection,
  type DirectProviderConfig,
} from "../catalog.js";
import {
  ensureLocalRuntime,
  getLocalRuntimeHealth,
} from "../../local/local-runtime.js";
import type {
  MikiProviderCompletionRequest,
  MikiProviderContext,
  ProviderInputKind,
  MikiProviderManifest,
  MikiProviderModel,
  MikiProviderPlugin,
  ProviderConnectionResult,
} from "./index.js";

const model = (
  id: string,
  name: string,
  contextWindow = 128_000,
  maxTokens = 8_192,
  reasoning = false,
  input: ProviderInputKind[] = ["text", "image"],
): MikiProviderModel => ({
  id,
  name,
  reasoning,
  input,
  contextWindow,
  maxTokens,
  supportsTools: true,
});

function directConfig(
  id: string,
  displayName: string,
  baseUrl: string,
  apiKeyEnv: string,
  emptyApiKeyAllowed = false,
): DirectProviderConfig {
  return { id, displayName, baseUrl, apiKeyEnv, emptyApiKeyAllowed };
}

function key(request: MikiProviderCompletionRequest): string {
  return request.credentials.apiKey || request.credentials.default || "";
}

function baseManifest(
  id: string,
  displayName: string,
  prefixes: string[],
  capabilities: MikiProviderManifest["capabilities"],
  local = false,
): MikiProviderManifest {
  return {
    id,
    displayName,
    version: "1.0.0",
    pluginApiVersion: "1.0",
    modelPrefixes: prefixes,
    capabilities,
    permissions: local ? ["network"] : ["network", "secrets"],
  };
}

function openAIPlugin(options: {
  id: string;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  prefixes: string[];
  models: MikiProviderModel[];
  allowEmpty?: boolean;
  local?: boolean;
}): MikiProviderPlugin {
  const provider = directConfig(
    options.id,
    options.displayName,
    options.baseUrl,
    options.apiKeyEnv,
    options.allowEmpty === true,
  );
  const manifest = baseManifest(
    options.id,
    options.displayName,
    options.prefixes,
    {
      chat: true,
      tools: true,
      streaming: true,
      vision: true,
      local: options.local === true,
    },
    options.local === true,
  );
  return {
    manifest,
    auth: {
      mode: options.local ? "local" : "api-key",
      envVars: options.local ? [] : [options.apiKeyEnv],
      allowEmptyKey: options.allowEmpty === true,
      secretFields: options.local ? [] : ["apiKey"],
    },
    async catalog() {
      return {
        baseUrl: options.baseUrl,
        api: options.local ? "local" : "openai-completions",
        auth: this.auth,
        models: options.models,
      };
    },
    async complete(request) {
      const configured = {
        ...provider,
        baseUrl: request.provider.baseUrl || provider.baseUrl,
      };
      const selectedModel =
        options.id === "openrouter"
          ? request.model
          : request.model.replace(
              new RegExp(
                `^(?:${options.prefixes.map((prefix) => prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})/`,
                "i",
              ),
              "",
            );
      return openAICompatibleAdapter.complete({
        provider: configured,
        model: selectedModel,
        apiKey: options.allowEmpty
          ? key(request) || "local-no-auth-required"
          : key(request),
        messages: request.messages as never,
        extra: request.extra,
        timeoutMs: request.timeoutMs,
      });
    },
    async listModels(context: MikiProviderContext) {
      const result = await fetchDirectProviderModels(
        provider,
        "",
        10_000,
      ).catch(() => []);
      context.log("provider.models.listed", {
        providerId: options.id,
        count: result.length,
      });
      return result.map((item) => model(item.id, item.id));
    },
    async testConnection(): Promise<ProviderConnectionResult> {
      return testDirectProviderConnection(
        provider,
        options.allowEmpty ? "local-no-auth-required" : "",
        10_000,
      );
    },
  };
}

export const geminiProviderPlugin = openAIPlugin({
  id: "gemini",
  displayName: "Google Gemini",
  baseUrl:
    process.env.GEMINI_BASE_URL ||
    "https://generativelanguage.googleapis.com/v1beta/openai/",
  apiKeyEnv: "GEMINI_API_KEY",
  prefixes: ["gemini", "google", "gemini-"],
  models: [
    model("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1_000_000, 8_192),
  ],
});

export const openAIProviderPlugin = openAIPlugin({
  id: "openai",
  displayName: "OpenAI",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_API_KEY",
  prefixes: ["openai", "gpt-"],
  models: [
    model("gpt-4o", "GPT-4o"),
    model("gpt-4.1", "GPT-4.1", 1_047_576, 32_768, true),
    model(
      "gpt-4o-audio-preview",
      "GPT-4o Audio Preview",
      128_000,
      4_096,
      false,
      ["text", "audio"],
    ),
  ],
});

export const openRouterProviderPlugin = openAIPlugin({
  id: "openrouter",
  displayName: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnv: "OPENROUTER_API_KEY",
  prefixes: ["openrouter"],
  models: [],
});

export const ollamaProviderPlugin = openAIPlugin({
  id: "ollama",
  displayName: "Local Ollama",
  baseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1",
  apiKeyEnv: "OLLAMA_API_KEY",
  prefixes: ["ollama", "local"],
  models: [],
  allowEmpty: true,
  local: true,
});

export const omniRouteProviderPlugin = openAIPlugin({
  id: "omniroute",
  displayName: "OmniRoute Local",
  baseUrl: process.env.MIKI_OMNIROUTE_BASE_URL || "http://127.0.0.1:20128/v1",
  apiKeyEnv: "MIKI_OMNIROUTE_API_KEY",
  prefixes: ["omniroute", "opencode"],
  models: [model("auto", "OmniRoute Auto", 32_768, 8_192)],
  allowEmpty: true,
  local: true,
});

export const claudeProviderPlugin: MikiProviderPlugin = {
  manifest: baseManifest(
    "claude",
    "Anthropic Claude",
    ["claude", "anthropic", "claude-"],
    {
      chat: true,
      tools: true,
      streaming: true,
      vision: true,
      local: false,
    },
  ),
  auth: {
    mode: "api-key",
    envVars: ["ANTHROPIC_API_KEY"],
    allowEmptyKey: false,
    secretFields: ["apiKey"],
  },
  async catalog() {
    return {
      baseUrl: "https://api.anthropic.com/v1/",
      api: "anthropic",
      auth: this.auth,
      models: [model("claude-3.5-sonnet", "Claude 3.5 Sonnet", 200_000, 8_192)],
    };
  },
  async complete(request) {
    return claudeNativeCompletion(
      request.messages as never,
      request.model.replace(/^(?:claude|anthropic)\//i, ""),
      key(request),
      request.extra,
    );
  },
};

export const llamaCppProviderPlugin: MikiProviderPlugin = {
  manifest: baseManifest(
    "llama.cpp",
    "llama.cpp Local",
    ["llama.cpp", "llama-cpp", "llamacpp", "local-llama"],
    {
      chat: true,
      tools: true,
      streaming: true,
      vision: false,
      local: true,
    },
    true,
  ),
  auth: { mode: "local", envVars: [], allowEmptyKey: true, secretFields: [] },
  async catalog() {
    return {
      baseUrl: process.env.MIKI_LLAMA_BASE_URL || "http://127.0.0.1:39200/v1",
      api: "local",
      auth: this.auth,
      models: [],
    };
  },
  async complete(request) {
    const runtime = await ensureLocalRuntime(request.model);
    return openAICompatibleAdapter.complete({
      provider: directConfig(
        "llama.cpp",
        "llama.cpp Local",
        runtime.baseUrl,
        "LLAMA_CPP_API_KEY",
        true,
      ),
      model: runtime.model,
      apiKey: "local-no-auth-required",
      messages: request.messages as never,
      extra: request.extra,
      timeoutMs: request.timeoutMs,
    });
  },
  async testConnection(context) {
    const health = getLocalRuntimeHealth();
    context.log("provider.local.health", {
      ready: health.ready,
      configured: health.configured,
    });
    return {
      ok: health.ready,
      latencyMs: 0,
      error: health.ready
        ? undefined
        : health.last_error || "llama.cpp runtime is not ready",
    };
  },
};

export const builtinProviderPlugins: MikiProviderPlugin[] = [
  geminiProviderPlugin,
  openAIProviderPlugin,
  openRouterProviderPlugin,
  claudeProviderPlugin,
  ollamaProviderPlugin,
  omniRouteProviderPlugin,
  llamaCppProviderPlugin,
];
