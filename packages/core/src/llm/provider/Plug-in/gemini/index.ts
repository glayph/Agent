import { fetchGeminiModels, testGeminiConnection } from "./catalog.js";
import type { ProviderTransportConfig } from "../../transport.js";
import { openAICompatibleAdapter } from "../../openai-compatible-adapter.js";
import { normalizeGeminiExtra, normalizeGeminiMessages } from "./compat.js";
import type {
  MikiProviderContext,
  MikiProviderModel,
  MikiProviderPlugin,
  ProviderConnectionResult,
} from "../../sdk/index.js";

const DEFAULT_BASE_URL =
  "https://generativelanguage.googleapis.com/v1beta/openai/";
const GEMINI_PREFIXES = ["gemini", "google"];

function credential(context: MikiProviderContext): string {
  return context.credentials?.apiKey || context.credentials?.default || "";
}

function model(
  id: string,
  name: string,
  contextWindow = 128_000,
  maxTokens = 8_192,
): MikiProviderModel {
  return {
    id,
    name,
    reasoning: false,
    input: ["text", "image"],
    contextWindow,
    maxTokens,
    supportsTools: true,
  };
}

function stripProviderPrefix(modelId: string): string {
  const value = modelId.trim();
  for (const prefix of GEMINI_PREFIXES) {
    if (value.toLowerCase().startsWith(`${prefix}/`)) {
      return value.slice(prefix.length + 1);
    }
  }
  return value;
}

const provider: ProviderTransportConfig = {
  id: "gemini",
  displayName: "Google Gemini",
  baseUrl: process.env.GEMINI_BASE_URL || DEFAULT_BASE_URL,
  apiKeyEnv: "GEMINI_API_KEY",
  emptyApiKeyAllowed: false,
};

export const geminiProviderPlugin: MikiProviderPlugin = {
  manifest: {
    id: "gemini",
    displayName: "Google Gemini",
    version: "1.0.0",
    pluginApiVersion: "1.0",
    modelPrefixes: ["gemini", "google"],
    modelIds: ["gemini-3.5-flash-lite"],
    aliases: ["google", "gemini"],
    ui: {
      dashboardId: "google",
      iconSlug: "google",
      domain: "ai.google.dev",
      defaultApiBase: provider.baseUrl,
      priority: 100,
      commonModels: [
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.6-flash",
      ],
      supportsFetch: true,
    },
    capabilities: {
      chat: true,
      tools: true,
      streaming: true,
      vision: true,
      local: false,
    },
    permissions: ["network", "secrets"],
  },
  auth: {
    mode: "api-key",
    envVars: ["GEMINI_API_KEY"],
    allowEmptyKey: false,
    secretFields: ["apiKey"],
  },
  async catalog() {
    return {
      baseUrl: provider.baseUrl,
      api: "gemini",
      auth: this.auth,
      models: [
        model("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite", 1_000_000),
      ],
    };
  },
  async complete(request) {
    return openAICompatibleAdapter.complete({
      provider: {
        ...provider,
        baseUrl: request.provider.baseUrl || provider.baseUrl,
      },
      model: stripProviderPrefix(request.model),
      apiKey: request.credentials.apiKey || request.credentials.default || "",
      messages: normalizeGeminiMessages(request.messages) as never,
      extra: normalizeGeminiExtra(request.extra),
      timeoutMs: request.timeoutMs,
    });
  },
  async listModels(context) {
    const discovered = await fetchGeminiModels(
      provider,
      credential(context),
      10_000,
    ).catch((error) => {
      context.log("provider.models.discovery_failed", {
        providerId: provider.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    });
    context.log("provider.models.listed", {
      providerId: provider.id,
      count: discovered.length,
    });
    return discovered.map((item) => model(item.id, item.id));
  },
  async testConnection(context): Promise<ProviderConnectionResult> {
    const result = await testGeminiConnection(
      provider,
      credential(context),
      10_000,
    );
    context.log("provider.connection.tested", {
      providerId: provider.id,
      ok: result.ok,
    });
    return result;
  },
};
