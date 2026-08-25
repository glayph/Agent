import OpenAI from "openai";
import { resolveConfiguredSecret } from "@miki/config";
import { isLocalModel } from "../local/local-runtime.js";

export type DirectProviderId = "gemini" | "llama.cpp";

export interface DirectProviderConfig {
  id: DirectProviderId;
  displayName: string;
  baseUrl: string;
  apiKeyEnv: string;
  emptyApiKeyAllowed: boolean;
}

/**
 * Agent Miki intentionally supports exactly two providers. Provider-specific
 * behavior lives in the corresponding plugin; this catalog only supplies the
 * typed endpoint/auth metadata needed by the shared runtime.
 */
export const DIRECT_PROVIDERS: DirectProviderConfig[] = [
  {
    id: "gemini",
    displayName: "Google Gemini",
    baseUrl:
      process.env.GEMINI_BASE_URL ||
      "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
    emptyApiKeyAllowed: false,
  },
  {
    id: "llama.cpp",
    displayName: "llama.cpp Local",
    baseUrl: process.env.MIKI_LLAMA_BASE_URL || "http://127.0.0.1:39200/v1",
    apiKeyEnv: "LLAMA_CPP_API_KEY",
    emptyApiKeyAllowed: true,
  },
];

export function getDirectProviderById(
  id: string,
): DirectProviderConfig | undefined {
  const normalized = id.trim().toLowerCase();
  return DIRECT_PROVIDERS.find(
    (provider) =>
      provider.id.toLowerCase() === normalized ||
      (provider.id === "gemini" && (normalized === "google" || normalized === "gemini")) ||
      (provider.id === "llama.cpp" &&
        ["llama-cpp", "llamacpp", "local-llama", "local"].includes(normalized)),
  );
}

export function directProviderForModel(
  model: string,
): DirectProviderConfig | undefined {
  const lower = model.trim().toLowerCase();
  if (
    lower.startsWith("google/") ||
    lower.startsWith("gemini/") ||
    lower.startsWith("gemini-")
  ) {
    return getDirectProviderById("gemini");
  }
  if (
    lower.startsWith("llama.cpp/") ||
    lower.startsWith("llama-cpp/") ||
    lower.startsWith("llamacpp/") ||
    lower.startsWith("local-llama/") ||
    lower.startsWith("local/") ||
    isLocalModel(model)
  ) {
    return getDirectProviderById("llama.cpp");
  }
  return undefined;
}

export function normalizeDirectModelName(
  providerId: string,
  model: string,
): string {
  const provider = getDirectProviderById(providerId);
  if (!provider) return model;
  if (provider.id === "gemini") {
    return model.replace(/^google\//i, "").replace(/^gemini\//i, "");
  }
  return model
    .replace(/^llama\.cpp\//i, "")
    .replace(/^llama-cpp\//i, "")
    .replace(/^llamacpp\//i, "")
    .replace(/^local-llama\//i, "")
    .replace(/^local\//i, "");
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
  const effectiveKey =
    apiKey || (provider.emptyApiKeyAllowed ? "local-no-auth-required" : apiKey);
  return new OpenAI({
    baseURL: provider.baseUrl,
    apiKey: effectiveKey,
    timeout: timeoutMs ?? 120000,
    maxRetries: 0,
  });
}

export interface DirectProviderModel {
  id: string;
  owned_by?: string;
}

function isGeminiProvider(provider: DirectProviderConfig): boolean {
  return provider.id === "gemini";
}

function geminiModelsURL(provider: DirectProviderConfig): string {
  return `${provider.baseUrl
    .replace(/\/v1beta\/openai\/?$/i, "/v1beta")
    .replace(/\/+$/, "")}/models`;
}

async function fetchGeminiModels(
  provider: DirectProviderConfig,
  apiKey: string,
  timeoutMs?: number,
): Promise<DirectProviderModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-goog-api-key"] = apiKey;
  const response = await fetch(geminiModelsURL(provider), {
    headers,
    signal: AbortSignal.timeout(timeoutMs ?? 10_000),
  });
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text.trim() ? (JSON.parse(text) as unknown) : {};
  } catch {
    body = text;
  }
  if (!response.ok) {
    const detail =
      typeof body === "string"
        ? body
        : body && typeof body === "object" && "error" in body
          ? JSON.stringify((body as { error?: unknown }).error)
          : `HTTP ${response.status}`;
    throw new Error(`Gemini model discovery failed: ${detail}`);
  }
  const rawModels =
    body &&
    typeof body === "object" &&
    Array.isArray((body as { models?: unknown }).models)
      ? (body as { models: unknown[] }).models
      : [];
  return rawModels.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as {
      name?: unknown;
      baseModelId?: unknown;
      owned_by?: unknown;
      supportedGenerationMethods?: unknown;
    };
    const supported = Array.isArray(record.supportedGenerationMethods)
      ? record.supportedGenerationMethods
      : [];
    if (
      supported.length > 0 &&
      !supported.some((method) => method === "generateContent")
    ) {
      return [];
    }
    const rawId =
      typeof record.baseModelId === "string"
        ? record.baseModelId
        : typeof record.name === "string"
          ? record.name.replace(/^models\//i, "")
          : "";
    const id = rawId.trim();
    if (!id) return [];
    return [
      {
        id,
        ...(typeof record.owned_by === "string"
          ? { owned_by: record.owned_by }
          : {}),
      },
    ];
  });
}

export async function fetchDirectProviderModels(
  provider: DirectProviderConfig,
  apiKey: string,
  timeoutMs?: number,
): Promise<DirectProviderModel[]> {
  if (isGeminiProvider(provider)) {
    return fetchGeminiModels(provider, apiKey, timeoutMs);
  }
  const client = directProviderClient(provider, apiKey, timeoutMs);
  const response = await client.models.list();
  return (response.data || []).map((item) => {
    const ownedBy = (item as { owned_by?: unknown }).owned_by;
    return {
      id: item.id,
      ...(typeof ownedBy === "string" ? { owned_by: ownedBy } : {}),
    };
  });
}

export async function testDirectProviderConnection(
  provider: DirectProviderConfig,
  apiKey: string,
  timeoutMs?: number,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await fetchDirectProviderModels(provider, apiKey, timeoutMs);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
