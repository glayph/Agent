import OpenAI from "openai";
import { resolveConfiguredSecret } from "@miki/config";
import { isLocalModel } from "../local/local-runtime.js";

export type DirectProviderId =
  | "gemini"
  | "openrouter"
  | "openai"
  | "claude"
  | "ollama"
  | "llama.cpp"
  | "omniroute"
  | "opencode";

export interface DirectProviderConfig {
  /** A known builtin id, or an arbitrary lowercase id for a custom
   * OpenAI-compatible provider registered via registerCustomProviders(). */
  id: DirectProviderId | string;
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
    id: "opencode",
    displayName: "OpenCode Zen",
    baseUrl: process.env.OPENCODE_BASE_URL || "https://opencode.ai/zen/v1",
    apiKeyEnv: "OPENCODE_API_KEY",
    emptyApiKeyAllowed: false,
  },
  {
    id: "openrouter",
    displayName: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    emptyApiKeyAllowed: false,
  },
  {
    // Anthropic's official OpenAI-compatible endpoint. Anthropic documents
    // this as intended for testing/comparison rather than long-term
    // production use (strict JSON-schema tool-call conformance isn't
    // guaranteed, no prompt caching, no audio). It's used here as the fast,
    // zero-extra-dependency default path since it fits this file's existing
    // uniform "every provider is an OpenAI baseURL" design. If tool-calling
    // reliability becomes a problem in practice, add a native adapter using
    // @anthropic-ai/sdk that translates to/from this same LLMResponse shape
    // (see providers/claude-native.ts for where that would live) without
    // needing to change any caller of achatCompletion().
    id: "claude",
    displayName: "Anthropic Claude",
    baseUrl: "https://api.anthropic.com/v1/",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    emptyApiKeyAllowed: false,
  },
  {
    // Local models via Ollama's built-in OpenAI-compatible server. No API
    // key is required for a local, unauthenticated Ollama instance.
    id: "ollama",
    displayName: "Local (Ollama)",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    emptyApiKeyAllowed: true,
  },
  {
    // Optional local OmniRoute gateway. It is never auto-started by Miki.
    id: "omniroute",
    displayName: "OmniRoute Local",
    baseUrl: "http://127.0.0.1:20128/v1",
    apiKeyEnv: "MIKI_OMNIROUTE_API_KEY",
    emptyApiKeyAllowed: true,
  },
  {
    // Managed or administrator-supplied llama-server on loopback.
    id: "llama.cpp",
    displayName: "llama.cpp Local",
    baseUrl: "http://127.0.0.1:39200/v1",
    apiKeyEnv: "LLAMA_CPP_API_KEY",
    emptyApiKeyAllowed: true,
  },
];

/**
 * User-defined OpenAI-compatible endpoints (e.g. "OpenCode" itself is a
 * terminal agent that connects to *any* OpenAI-compatible provider via a
 * user-configured base URL + API key — there is no single fixed "OpenCode
 * API" to hardcode. The same mechanism covers LM Studio, a company-internal
 * gateway, or any other compatible endpoint not already listed above.
 *
 * Configure these under `model_providers` in config/agent.yaml:
 *
 *   model_providers:
 *     opencode:
 *       displayName: "OpenCode Gateway"
 *       baseUrl: "http://localhost:4096/v1"
 *       apiKeyEnv: "OPENCODE_API_KEY"
 *       emptyApiKeyAllowed: false
 *
 * Then reference models as "opencode/<model-id>".
 */
let customProviders: Map<string, DirectProviderConfig> = new Map();

export function registerCustomProviders(
  raw: Record<string, unknown> | undefined | null,
): void {
  const next = new Map<string, DirectProviderConfig>();
  if (raw && typeof raw === "object") {
    for (const [id, value] of Object.entries(raw)) {
      if (!value || typeof value !== "object") continue;
      const v = value as Record<string, unknown>;
      const baseUrl = typeof v.baseUrl === "string" ? v.baseUrl : undefined;
      if (!baseUrl) continue; // baseUrl is the one truly required field
      const normalizedId = id.trim().toLowerCase();
      next.set(normalizedId, {
        id: normalizedId,
        displayName: typeof v.displayName === "string" ? v.displayName : id,
        baseUrl,
        apiKeyEnv:
          typeof v.apiKeyEnv === "string"
            ? v.apiKeyEnv
            : `${normalizedId.toUpperCase()}_API_KEY`,
        emptyApiKeyAllowed: v.emptyApiKeyAllowed === true,
      });
    }
  }
  customProviders = next;
}

export function getCustomProviderById(
  id: string,
): DirectProviderConfig | undefined {
  return customProviders.get(id.trim().toLowerCase());
}

export function listCustomProviders(): DirectProviderConfig[] {
  return Array.from(customProviders.values());
}

export function getDirectProviderById(
  id: string,
): DirectProviderConfig | undefined {
  const normalized = id.trim().toLowerCase();
  const builtin = DIRECT_PROVIDERS.find(
    (p) =>
      p.id === normalized || (p.id === "gemini" && normalized === "google"),
  );
  if (builtin) {
    if (builtin.id === "ollama") {
      const override = process.env["OLLAMA_BASE_URL"];
      if (override) return { ...builtin, baseUrl: override };
    }
    if (builtin.id === "llama.cpp") {
      const override = process.env["MIKI_LLAMA_BASE_URL"];
      if (override) return { ...builtin, baseUrl: override };
    }
    return builtin;
  }
  return getCustomProviderById(normalized);
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
  if (lower.startsWith("opencode/")) {
    return getDirectProviderById("opencode");
  }
  if (
    lower.startsWith("claude/") ||
    lower.startsWith("anthropic/") ||
    lower.startsWith("claude-")
  ) {
    return getDirectProviderById("claude");
  }
  if (lower.startsWith("ollama/")) {
    return getDirectProviderById("ollama");
  }
  if (lower.startsWith("omniroute/")) {
    return getDirectProviderById("omniroute");
  }
  if (
    lower.startsWith("llama.cpp/") ||
    lower.startsWith("llama-cpp/") ||
    lower.startsWith("llamacpp/") ||
    lower.startsWith("local-llama/")
  ) {
    return getDirectProviderById("llama.cpp");
  }
  if (lower.startsWith("local/")) {
    return getDirectProviderById("ollama");
  }
  if (lower.startsWith("openrouter/")) {
    return getDirectProviderById("openrouter");
  }
  // Friendly aliases saved by the dashboard (for example
  // qwen2-5-coder-1-5b-local) are resolved from the configured local-model
  // registry before the generic OpenRouter fallback.
  if (isLocalModel(model)) {
    return getDirectProviderById("llama.cpp");
  }
  // Custom OpenAI-compatible providers (OpenCode, LM Studio, internal
  // gateways, ...) registered via agent.yaml's model_providers block, e.g.
  // model "opencode/some-model" routes to the "opencode" custom provider.
  const slashIndex = lower.indexOf("/");
  if (slashIndex > 0) {
    const prefix = lower.slice(0, slashIndex);
    const custom = getCustomProviderById(prefix);
    if (custom) return custom;
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
    // Google's OpenAI-compatible endpoint expects the bare model id
    // (for example `gemini-2.0-flash`), not the internal routing prefix
    // (`gemini/gemini-2.0-flash`). The prefix is used only to select the
    // provider locally and must not be sent over the wire.
    return model.replace(/^google\//, "").replace(/^gemini\//, "");
  }
  if (provider.id === "openrouter") {
    return model.startsWith("openrouter/") ? model : `openrouter/${model}`;
  }
  if (provider.id === "opencode") {
    return model.replace(/^opencode\//, "");
  }
  if (provider.id === "claude") {
    return model.replace(/^claude\//, "").replace(/^anthropic\//, "");
  }
  if (provider.id === "ollama") {
    return model.replace(/^ollama\//, "").replace(/^local\//, "");
  }
  if (provider.id === "omniroute") {
    return model.replace(/^omniroute\//, "");
  }
  if (provider.id === "llama.cpp") {
    return model
      .replace(/^llama\.cpp\//, "")
      .replace(/^llama-cpp\//, "")
      .replace(/^llamacpp\//, "")
      .replace(/^local-llama\//, "");
  }
  if (getCustomProviderById(provider.id)) {
    // Custom providers keep their own id as the routing prefix (matching
    // how the model was configured, e.g. "opencode/glm-4.6" -> "glm-4.6").
    return model.replace(new RegExp(`^${provider.id}/`), "");
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
  // The openai SDK throws OpenAIError on construction if apiKey is an empty
  // string (it does not fall back to emptyApiKeyAllowed semantics — that
  // flag only exists in this codebase, not the SDK). Local/unauthenticated
  // endpoints like Ollama don't check the key at all, so a placeholder is
  // safe and never sent anywhere meaningful.
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
  // Chat uses Google's OpenAI-compatible endpoint, while model discovery is
  // served by the native Gemini REST resource. Keep this distinction explicit
  // so the two endpoints cannot silently receive the wrong auth contract.
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
