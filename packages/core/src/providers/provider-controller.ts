import OpenAI from "openai";
import { resolveConfiguredSecret } from "@hiro/config";

export type DirectProviderId = "gemini" | "openrouter" | "openai";

export interface DirectProviderConfig {
  id: DirectProviderId;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  emptyApiKeyAllowed: boolean;
}

export const DIRECT_PROVIDERS: DirectProviderConfig[] = [
  {
    id: "gemini",
    displayName: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    emptyApiKeyAllowed: false,
  },
  {
    id: "openai",
    displayName: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    emptyApiKeyAllowed: false,
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    emptyApiKeyAllowed: false,
  },
];

export function getDirectProviderById(
  id: string,
): DirectProviderConfig | undefined {
  const normalized = id.trim().toLowerCase();
  return DIRECT_PROVIDERS.find(
    (p) => p.id === normalized || (p.id === "gemini" && normalized === "google"),
  );
}

export function directProviderForModel(
  model: string,
): DirectProviderConfig | undefined {
  const lower = model.toLowerCase();
  if (
    lower.startsWith("google/") ||
    lower.startsWith("gemini/") ||
    lower.startsWith("gemini-")
  ) {
    return getDirectProviderById("gemini");
  }
  if (lower.startsWith("openai/") || lower.startsWith("gpt-")) {
    return getDirectProviderById("openai");
  }
  if (lower.startsWith("openrouter/")) {
    return getDirectProviderById("openrouter");
  }
  return getDirectProviderById("openrouter");
}

export function normalizeDirectModelName(
  providerId: string,
  model: string,
): string {
  const provider = getDirectProviderById(providerId);
  if (!provider) return model;
  if (provider.id === "gemini") {
    const base = model.replace(/^google\//, "").replace(/^gemini\//, "");
    return `gemini/${base}`;
  }
  if (provider.id === "openrouter") {
    return model.startsWith("openrouter/") ? model : `openrouter/${model}`;
  }
  return model.replace(/^openai\//, "");
}

export function resolveProviderApiKey(
  provider: DirectProviderConfig,
  workspaceDir?: string,
): string {
  return (
    resolveConfiguredSecret(provider.apiKeyEnv, workspaceDir) ||
    resolveConfiguredSecret(provider.apiKeyEnv)
  );
}

export function directProviderClient(
  provider: DirectProviderConfig,
  apiKey: string,
  timeoutMs?: number,
): OpenAI {
  return new OpenAI({
    baseURL: provider.baseUrl,
    apiKey,
    timeout: timeoutMs ?? 120000,
    maxRetries: 0,
  });
}

export interface DirectProviderModel {
  id: string;
  owned_by?: string;
}

export async function fetchDirectProviderModels(
  provider: DirectProviderConfig,
  apiKey: string,
  timeoutMs?: number,
): Promise<DirectProviderModel[]> {
  const client = directProviderClient(provider, apiKey, timeoutMs);
  const response = await client.models.list();
  return (response.data || []).map((item) => ({
    id: item.id,
    owned_by: item.owned_by,
  }));
}

export async function testDirectProviderConnection(
  provider: DirectProviderConfig,
  apiKey: string,
  timeoutMs?: number,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await directProviderClient(provider, apiKey, timeoutMs).models.list();
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
