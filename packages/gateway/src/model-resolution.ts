/**
 * Single source of truth for "which model will actually run, and can it?".
 *
 * Before this module existed the Models page / health endpoints (index.ts) and
 * the chat runtime (agent-runtime.ts `llmFor`) each had their own copy of the
 * logic and they disagreed:
 *   - an `openai-compatible` model with no key counted as "configured" on the
 *     Models page but `llmFor` returned undefined for any non-local base URL,
 *     so chat said "No model is configured" while the Models page said healthy;
 *   - a request for an unknown model name built a ghost client from an empty
 *     payload instead of falling back to the default model;
 *   - key checks only tested presence, so "your_api_key" counted as valid.
 *
 * Everything here is pure (no I/O) except `probeModelProvider`, which is only
 * used by the explicit "verify" endpoint and never on the chat hot path.
 */

export interface StoredModelEntry {
  payload: Record<string, unknown>
  isDefault: boolean
}

export type ApiKeyStatus = "valid" | "missing" | "malformed" | "placeholder" | "not_required"

export interface ApiKeyCheck {
  status: ApiKeyStatus
  /** Human readable explanation for non-valid states. Never contains the key. */
  reason?: string
}

export interface ResolvedModel {
  /** True when a client can be built and the credentials are structurally usable. */
  configured: boolean
  source: "stored" | "env" | "none"
  /** Provider-facing model identifier (e.g. gemini-3.5-flash-lite). */
  model: string
  /** UI label; may differ from `model`. */
  modelName: string
  provider: string
  baseUrl: string
  /** Server-side only. Never serialise this to the client. */
  apiKey: string
  keyCheck: ApiKeyCheck
  isDefault: boolean
  /** The caller asked for a specific model and it matched a stored entry. */
  matchedRequested: boolean
  /** Why `configured` is false. */
  reason?: string
  entry?: StoredModelEntry
}

type Env = Record<string, string | undefined>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const normalizeProvider = (provider: unknown): string => String(provider ?? "").trim().toLowerCase()

const isGemini = (p: string) => p === "gemini" || p === "google"
const isOpenRouter = (p: string) => p === "openrouter" || p === "open-router"
const isCompatible = (p: string) => p === "openai-compatible" || p === "compatible" || p === "openai_compatible"
const isLocalProvider = (p: string) => ["llama.cpp", "llama-cpp", "llamacpp", "local"].includes(p)

export function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
  } catch {
    return false
  }
}

export function providerDefaults(provider: string, env: Env = process.env): { baseUrl: string; apiKey: string } {
  const p = normalizeProvider(provider)
  if (isGemini(p)) return { baseUrl: env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/", apiKey: env.GEMINI_API_KEY || "" }
  if (isOpenRouter(p)) return { baseUrl: "https://openrouter.ai/api/v1", apiKey: env.OPENROUTER_API_KEY || "" }
  if (isCompatible(p)) return { baseUrl: env.OPENAI_COMPATIBLE_BASE_URL || env.OPENAI_API_BASE || "http://127.0.0.1:8000/v1", apiKey: env.OPENAI_COMPATIBLE_API_KEY || env.OPENAI_API_KEY || "" }
  if (isLocalProvider(p)) return { baseUrl: env.MIKI_LLAMA_BASE_URL || "http://127.0.0.1:39200/v1", apiKey: "" }
  return { baseUrl: env.OPENAI_API_BASE || "https://api.openai.com/v1", apiKey: env.OPENAI_API_KEY || "" }
}

/** Providers that can legitimately run without a key. */
export function providerKeyOptional(provider: unknown, baseUrl = ""): boolean {
  const p = normalizeProvider(provider)
  return isLocalProvider(p) || isCompatible(p) || (baseUrl !== "" && isLocalUrl(baseUrl))
}

const PLACEHOLDER = /^(?:your[\w-]*|changeme|change[_-]?me|replace[\w-]*|insert[\w-]*|paste[\w-]*|put[_-]?your[\w-]*|x{3,}|\.{3,}|todo|dummy|example|sample|none|null|undefined|test|<.*>|\[.*\]|\$\{.*\})$/i

/**
 * Structural validation of an API key. This deliberately stays provider
 * agnostic (new key formats appear often) and only rejects keys that cannot
 * possibly work: empty, placeholders, whitespace/quotes, absurd length or
 * characters that are never valid in an HTTP bearer token.
 */
export function checkApiKey(provider: unknown, rawKey: unknown, options: { baseUrl?: string } = {}): ApiKeyCheck {
  const key = typeof rawKey === "string" ? rawKey.trim() : ""
  const optional = providerKeyOptional(provider, options.baseUrl)
  if (!key) {
    return optional
      ? { status: "not_required" }
      : { status: "missing", reason: `No API key is set for provider "${normalizeProvider(provider) || "openai"}".` }
  }
  if (PLACEHOLDER.test(key) || /^sk-?x{3,}/i.test(key) || /your[_-]?(?:api[_-]?)?key/i.test(key)) {
    return { status: "placeholder", reason: "The API key looks like a placeholder, not a real key." }
  }
  if (/\s/.test(key) || /["'`]/.test(key)) {
    return { status: "malformed", reason: "The API key contains whitespace or quote characters (copy/paste error?)." }
  }
  if (!/^[\x21-\x7e]+$/.test(key)) {
    return { status: "malformed", reason: "The API key contains characters that are not valid in an HTTP header." }
  }
  if (key.length < 8 || key.length > 4096) {
    return { status: "malformed", reason: "The API key has an implausible length." }
  }
  return { status: "valid" }
}

function matchesRequested(entry: StoredModelEntry, requested: string): boolean {
  return entry.payload.model === requested || entry.payload.model_name === requested
}

/** Entry that should run when the caller did not (or could not) pick one. */
export function pickDefaultEntry(stored: StoredModelEntry[]): StoredModelEntry | undefined {
  const enabled = stored.filter((item) => item.payload.enabled !== false)
  return enabled.find((item) => item.isDefault) ?? enabled[0] ?? stored.find((item) => item.isDefault) ?? stored[0]
}

export function resolveModel(stored: StoredModelEntry[], requested?: string, env: Env = process.env): ResolvedModel {
  const wanted = (requested ?? "").trim()
  const matched = wanted ? stored.find((item) => matchesRequested(item, wanted)) : undefined
  // An unknown requested name must NOT produce a ghost client built from an
  // empty payload: fall back to the configured default instead.
  const entry = matched ?? pickDefaultEntry(stored)
  const payload: Record<string, unknown> = entry?.payload ?? {}
  const source: ResolvedModel["source"] = entry ? "stored" : "env"

  const envModel = (env.MIKI_MODEL || env.OPENAI_MODEL || "").trim()
  const model = String(payload.model || payload.model_name || (!entry ? wanted : "") || envModel).trim()
  const provider = String(payload.provider || env.MIKI_PROVIDER || "openai-compatible").trim()
  const defaults = providerDefaults(provider, env)
  const baseUrl = String(payload.api_base || defaults.baseUrl || env.OPENAI_API_BASE || "https://api.openai.com/v1").trim()
  const apiKey = String(payload.api_key || defaults.apiKey || "").trim()
  const modelName = String(payload.model_name || model)
  const local = isRecord(payload.local) ? payload.local : undefined
  const localConfigured = normalizeProvider(provider).includes("llama") && Boolean(local?.model_path)
  const keyCheck = localConfigured ? ({ status: "not_required" } as ApiKeyCheck) : checkApiKey(provider, apiKey, { baseUrl })

  let reason: string | undefined
  if (!model) reason = "No model name is configured."
  else if (entry && entry.payload.enabled === false) reason = `Model "${modelName}" is disabled.`
  else if (keyCheck.status === "missing" || keyCheck.status === "placeholder" || keyCheck.status === "malformed") reason = keyCheck.reason

  return {
    configured: reason === undefined,
    source: model ? source : "none",
    model,
    modelName,
    provider,
    baseUrl,
    apiKey,
    keyCheck,
    isDefault: entry?.isDefault ?? !entry,
    matchedRequested: Boolean(matched),
    ...(reason ? { reason } : {}),
    ...(entry ? { entry } : {}),
  }
}

/** Client-safe summary (no key material). */
export function describeResolution(resolved: ResolvedModel) {
  return {
    configured: resolved.configured,
    source: resolved.source,
    model: resolved.model,
    model_name: resolved.modelName,
    provider: resolved.provider,
    api_base: resolved.baseUrl,
    is_default: resolved.isDefault,
    key_status: resolved.keyCheck.status,
    ...(resolved.reason ? { reason: resolved.reason } : {}),
  }
}

export interface ProbeResult {
  reachable: boolean
  /** HTTP status of the provider's model list endpoint, if any response was received. */
  status?: number
  /** "ok" | "key_rejected" | "unreachable" | "unexpected_status" */
  state: "ok" | "key_rejected" | "unreachable" | "unexpected_status"
  detail?: string
}

/**
 * Availability probe: asks the provider's cheap `GET /models` endpoint. Used
 * only by the explicit verify endpoint (never during chat) with a hard timeout.
 */
export async function probeModelProvider(
  resolved: Pick<ResolvedModel, "baseUrl" | "apiKey">,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 5_000)
  try {
    const url = `${resolved.baseUrl.replace(/\/+$/, "")}/models`
    const response = await fetchImpl(url, {
      method: "GET",
      headers: resolved.apiKey ? { Authorization: `Bearer ${resolved.apiKey}` } : {},
      signal: controller.signal,
    })
    if (response.status === 401 || response.status === 403) {
      return { reachable: true, status: response.status, state: "key_rejected", detail: "The provider rejected the API key." }
    }
    // 404/405 on /models still proves the host is reachable and the key was not rejected.
    if (response.ok || response.status === 404 || response.status === 405) return { reachable: true, status: response.status, state: "ok" }
    return { reachable: true, status: response.status, state: "unexpected_status", detail: `Provider answered HTTP ${response.status}.` }
  } catch (error) {
    return { reachable: false, state: "unreachable", detail: error instanceof Error ? error.message : String(error) }
  } finally {
    clearTimeout(timer)
  }
}
