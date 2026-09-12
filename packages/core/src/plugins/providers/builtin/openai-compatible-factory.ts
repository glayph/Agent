import type { ProviderTransportConfig } from "../../../llm/provider/transport.js";
import { providerClient } from "../../../llm/provider/transport.js";
import { openAICompatibleAdapter } from "../../../llm/provider/openai-compatible-adapter.js";
import type {
  MikiProviderContext,
  MikiProviderModel,
  MikiProviderPlugin,
  ProviderConnectionResult,
} from "../../../llm/provider/sdk/index.js";

export interface OpenAICompatibleProviderDefinition {
  id: string;
  displayName: string;
  aliases: string[];
  modelPrefixes: string[];
  apiKeyEnv: string;
  defaultBaseUrl: string;
  iconSlug: string;
  domain: string;
  priority: number;
  description: string;
  allowEmptyKey?: boolean;
  local?: boolean;
}

function credential(context: MikiProviderContext): string {
  return context.credentials?.apiKey || context.credentials?.default || "";
}

function model(id: string): MikiProviderModel {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 16_384,
    supportsTools: true,
  };
}

export function createOpenAICompatibleProvider(
  definition: OpenAICompatibleProviderDefinition,
): MikiProviderPlugin {
  const provider: ProviderTransportConfig = {
    id: definition.id,
    displayName: definition.displayName,
    baseUrl: process.env[`${definition.id.toUpperCase().replaceAll("-", "_")}_BASE_URL`] || definition.defaultBaseUrl,
    apiKeyEnv: definition.apiKeyEnv,
    emptyApiKeyAllowed: definition.allowEmptyKey ?? false,
  };
  const prefixes = [definition.id, ...definition.aliases, ...definition.modelPrefixes];

  return {
    manifest: {
      id: definition.id,
      displayName: definition.displayName,
      version: "1.0.0",
      pluginApiVersion: "1.0",
      modelPrefixes: prefixes,
      aliases: definition.aliases,
      ui: {
        dashboardId: definition.id,
        iconSlug: definition.iconSlug,
        domain: definition.domain,
        defaultApiBase: provider.baseUrl,
        priority: definition.priority,
        commonModels: [],
        supportsFetch: true,
      },
      capabilities: {
        chat: true,
        tools: true,
        streaming: true,
        vision: true,
        local: definition.local ?? false,
      },
      permissions: ["network", "secrets"],
    },
    auth: {
      mode: definition.local ? "none" : "api-key",
      envVars: [definition.apiKeyEnv],
      allowEmptyKey: definition.allowEmptyKey ?? false,
      secretFields: definition.local ? [] : ["apiKey"],
    },
    async catalog() {
      return {
        baseUrl: provider.baseUrl,
        api: "openai-completions",
        auth: this.auth,
        models: [],
      };
    },
    async complete(request) {
      return openAICompatibleAdapter.complete({
        provider: {
          ...provider,
          baseUrl: request.provider.baseUrl || provider.baseUrl,
        },
        model: request.model.includes("/")
          ? request.model.slice(request.model.indexOf("/") + 1)
          : request.model,
        apiKey: credential(request.context),
        messages: request.messages as never,
        extra: request.extra,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      });
    },
    async listModels(context) {
      const discovered = await providerClient(provider, credential(context), 10_000).models.list().catch((error) => {
        context.log("provider.models.discovery_failed", {
          providerId: definition.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      });
      const items = Array.isArray(discovered) ? discovered : discovered.data || [];
      return items.map((item) => model(item.id));
    },
    async testConnection(context): Promise<ProviderConnectionResult> {
      const started = Date.now();
      const result: ProviderConnectionResult = await providerClient(
        provider,
        credential(context),
        10_000,
      ).models.list()
        .then(() => ({ ok: true, latencyMs: Date.now() - started }))
        .catch((error) => ({
          ok: false,
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message : String(error),
        }));
      context.log("provider.connection.tested", {
        providerId: definition.id,
        ok: result.ok,
      });
      return result;
    },
  };
}
