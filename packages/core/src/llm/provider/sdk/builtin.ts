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
  id: "gemini" | "llama.cpp",
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
  id: "gemini" | "llama.cpp",
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

function openAICompatiblePlugin(options: {
  id: "gemini";
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  prefixes: string[];
  models: MikiProviderModel[];
}): MikiProviderPlugin {
  const provider = directConfig(
    options.id,
    options.displayName,
    options.baseUrl,
    options.apiKeyEnv,
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
      local: false,
    },
  );
  return {
    manifest,
    auth: {
      mode: "api-key",
      envVars: [options.apiKeyEnv],
      allowEmptyKey: false,
      secretFields: ["apiKey"],
    },
    async catalog() {
      return {
        baseUrl: options.baseUrl,
        api: "gemini",
        auth: this.auth,
        models: options.models,
      };
    },
    async complete(request) {
      const selectedModel = request.model.replace(
        new RegExp(
          `^(?:${options.prefixes
            .map((prefix) => prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\\\$&"))
            .join("|")})/`,
          "i",
        ),
        "",
      );
      return openAICompatibleAdapter.complete({
        provider: {
          ...provider,
          baseUrl: request.provider.baseUrl || provider.baseUrl,
        },
        model: selectedModel,
        apiKey: key(request),
        messages: request.messages as never,
        extra: request.extra,
        timeoutMs: request.timeoutMs,
      });
    },
    async listModels(context: MikiProviderContext) {
      const result = await fetchDirectProviderModels(
        provider,
        key({ credentials: {} } as MikiProviderCompletionRequest),
        10_000,
      ).catch(() => []);
      context.log("provider.models.listed", {
        providerId: options.id,
        count: result.length,
      });
      return result.map((item) => model(item.id, item.id));
    },
    async testConnection(context): Promise<ProviderConnectionResult> {
      const result = await testDirectProviderConnection(provider, "", 10_000);
      context.log("provider.connection.tested", {
        providerId: options.id,
        ok: result.ok,
      });
      return result;
    },
  };
}

export const geminiProviderPlugin = openAICompatiblePlugin({
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

export const llamaCppProviderPlugin: MikiProviderPlugin = {
  manifest: baseManifest(
    "llama.cpp",
    "llama.cpp Local",
    ["llama.cpp", "llama-cpp", "llamacpp", "local-llama", "local"],
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
  llamaCppProviderPlugin,
];
