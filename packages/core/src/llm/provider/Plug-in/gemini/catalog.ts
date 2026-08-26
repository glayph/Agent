import type { ProviderTransportConfig } from "../../transport.js";

export interface GeminiDiscoveredModel {
  id: string;
  owned_by?: string;
}

function geminiModelsUrl(provider: ProviderTransportConfig): string {
  return `${provider.baseUrl
    .replace(/\/v1beta\/openai\/?$/i, "/v1beta")
    .replace(/\/+$/, "")}/models`;
}

export async function fetchGeminiModels(
  provider: ProviderTransportConfig,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<GeminiDiscoveredModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) headers["x-goog-api-key"] = apiKey;
  const response = await fetch(geminiModelsUrl(provider), {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
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

export async function testGeminiConnection(
  provider: ProviderTransportConfig,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    await fetchGeminiModels(provider, apiKey, timeoutMs);
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
