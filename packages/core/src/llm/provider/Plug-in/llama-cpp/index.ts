import {
  ensureLocalRuntime,
  getLocalRuntimeHealth,
} from "../../../local/local-runtime.js";
import { openAICompatibleAdapter } from "../../openai-compatible-adapter.js";
import type {
  MikiProviderModel,
  MikiProviderPlugin,
  ProviderConnectionResult,
} from "../../sdk/index.js";

const DEFAULT_BASE_URL = "http://127.0.0.1:39200/v1";

function model(id: string, name = id): MikiProviderModel {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    contextWindow: 128_000,
    maxTokens: 8_192,
    supportsTools: true,
  };
}

function localModelId(value: string): string {
  return value
    .trim()
    .replace(/^llama\.cpp\//i, "")
    .replace(/^llama-cpp\//i, "")
    .replace(/^llamacpp\//i, "")
    .replace(/^local-llama\//i, "")
    .replace(/^local\//i, "");
}

export const llamaCppProviderPlugin: MikiProviderPlugin = {
  manifest: {
    id: "llama.cpp",
    displayName: "llama.cpp Local",
    version: "1.0.0",
    pluginApiVersion: "1.0",
    modelPrefixes: [
      "llama.cpp",
      "llama-cpp",
      "llamacpp",
      "local-llama",
      "local",
    ],
    aliases: ["llama-cpp", "llamacpp", "local-llama", "local"],
    ui: {
      iconSlug: "llama",
      domain: "127.0.0.1",
      defaultApiBase: process.env.MIKI_LLAMA_BASE_URL || DEFAULT_BASE_URL,
      priority: 90,
      commonModels: ["local-model"],
      supportsFetch: false,
      authMethodLocked: true,
    },
    capabilities: {
      chat: true,
      tools: true,
      streaming: true,
      vision: false,
      local: true,
    },
    permissions: ["network"],
  },
  auth: {
    mode: "local",
    envVars: [],
    allowEmptyKey: true,
    secretFields: [],
  },
  async catalog() {
    return {
      baseUrl: process.env.MIKI_LLAMA_BASE_URL || DEFAULT_BASE_URL,
      api: "local",
      auth: this.auth,
      models: [],
    };
  },
  async complete(request) {
    const runtime = await ensureLocalRuntime(localModelId(request.model));
    return openAICompatibleAdapter.complete({
      provider: {
        id: "llama.cpp",
        displayName: "llama.cpp Local",
        baseUrl: runtime.baseUrl,
        apiKeyEnv: "LLAMA_CPP_API_KEY",
        emptyApiKeyAllowed: true,
      },
      model: runtime.model,
      apiKey: "local-no-auth-required",
      messages: request.messages as never,
      extra: request.extra,
      timeoutMs: request.timeoutMs,
    });
  },
  async listModels(context) {
    const health = getLocalRuntimeHealth();
    context.log("provider.local.models.listed", {
      configured: health.configured,
      ready: health.ready,
    });
    return health.configured && health.model_path
      ? [model(health.model || "local-model", "Local LFM")]
      : [];
  },
  async testConnection(context): Promise<ProviderConnectionResult> {
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
