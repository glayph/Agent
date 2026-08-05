import OpenAI from "openai";
import { resolveConfiguredSecret } from "@hiro/config";

export type DirectProviderId =
  | "gemini"
  | "openrouter"
  | "openai"
  | "claude"
  | "ollama";

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
    // key is required for a local, unauthenticated Ollama instance, hence
    // emptyApiKeyAllowed. Override the default host with OLLAMA_BASE_URL
    // (see getDirectProviderById's runtime override below) if Ollama is
    // running on a non-default host/port.
    id: "ollama",
    displayName: "Local (Ollama)",
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
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
        displayName:
          typeof v.displayName === "string" ? v.displayName : id,
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
    (p) => p.id === normalized || (p.id === "gemini" && normalized === "google"),
  );
  if (builtin) {
    if (builtin.id === "ollama") {
      const override = process.env["OLLAMA_BASE_URL"];
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
  if (
    lower.startsWith("claude/") ||
    lower.startsWith("anthropic/") ||
    lower.startsWith("claude-")
  ) {
    return getDirectProviderById("claude");
  }
  if (lower.startsWith("ollama/") || lower.startsWith("local/")) {
    return getDirectProviderById("ollama");
  }
  if (lower.startsWith("openrouter/")) {
    return getDirectProviderById("openrouter");
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
    const base = model.replace(/^google\//, "").replace(/^gemini\//, "");
    return `gemini/${base}`;
  }
  if (provider.id === "openrouter") {
    return model.startsWith("openrouter/") ? model : `openrouter/${model}`;
  }
  if (provider.id === "claude") {
    return model.replace(/^claude\//, "").replace(/^anthropic\//, "");
  }
  if (provider.id === "ollama") {
    return model.replace(/^ollama\//, "").replace(/^local\//, "");
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
