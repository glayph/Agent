import { describe, expect, it } from "@jest/globals"
import { buildConfiguredModelFallbackCandidates, checkApiKey, probeModelProvider, resolveModel, type StoredModelEntry } from "./model-resolution.js"

const GOOD_KEY = "AIzaSyD-example_key-0123456789abcdefghij"
const gemini = (extra: Record<string, unknown> = {}, isDefault = true): StoredModelEntry => ({
  isDefault,
  payload: { model: "gemini-3.5-flash-lite", model_name: "Gemini Flash Lite", provider: "gemini", api_key: GOOD_KEY, ...extra },
})

describe("checkApiKey", () => {
  it("accepts a plausible key", () => {
    expect(checkApiKey("gemini", GOOD_KEY).status).toBe("valid")
  })
  it("reports missing for providers that need a key", () => {
    expect(checkApiKey("gemini", "").status).toBe("missing")
    expect(checkApiKey("openai", undefined).status).toBe("missing")
  })
  it("does not require a key for local / compatible providers", () => {
    expect(checkApiKey("llama.cpp", "").status).toBe("not_required")
    expect(checkApiKey("openai-compatible", "").status).toBe("not_required")
    expect(checkApiKey("openai", "", { baseUrl: "http://127.0.0.1:8000/v1" }).status).toBe("not_required")
  })
  it("rejects placeholders and malformed keys", () => {
    for (const key of ["your_api_key", "YOUR_GEMINI_API_KEY", "changeme", "<paste-key>", "xxxxxxxxxxxx", "${GEMINI_API_KEY}"]) {
      expect(checkApiKey("gemini", key).status).toBe("placeholder")
    }
    expect(checkApiKey("gemini", "abc def ghi jkl").status).toBe("malformed")
    expect(checkApiKey("gemini", '"AIzaSyD-quoted-key-0123456789"').status).toBe("malformed")
    expect(checkApiKey("gemini", "short").status).toBe("malformed")
  })
})

describe("resolveModel", () => {
  it("resolves the stored default and exposes the provider-facing model id", () => {
    const resolved = resolveModel([gemini()], undefined, {})
    expect(resolved).toMatchObject({ configured: true, source: "stored", model: "gemini-3.5-flash-lite", provider: "gemini", matchedRequested: false })
  })
  it("matches a request by label or model id", () => {
    expect(resolveModel([gemini()], "Gemini Flash Lite", {}).matchedRequested).toBe(true)
    expect(resolveModel([gemini()], "gemini-3.5-flash-lite", {}).matchedRequested).toBe(true)
  })
  it("uses the stable stored row id when model names are duplicated", () => {
    const duplicateRows: StoredModelEntry[] = [
      { id: 11, isDefault: true, payload: { model: "shared-model", model_name: "Shared model", provider: "openai-compatible", api_base: "http://127.0.0.1:8001/v1", enabled: true } },
      { id: 12, isDefault: false, payload: { model: "shared-model", model_name: "Shared model", provider: "openai-compatible", api_base: "http://127.0.0.1:8002/v1", enabled: true } },
    ]

    const selected = resolveModel(duplicateRows, "shared-model", {}, 12)
    expect(selected.configured).toBe(true)
    expect(selected.entry?.id).toBe(12)
    expect(selected.baseUrl).toBe("http://127.0.0.1:8002/v1")
    expect(selected.matchedRequested).toBe(true)
  })

  it("discovers configured fallbacks from any provider using stable row IDs", () => {
    const rows: StoredModelEntry[] = [
      { id: 11, isDefault: true, payload: { model: "shared-model", provider: "provider-alpha", api_base: "https://alpha.example/v1", api_key: GOOD_KEY } },
      { id: 12, isDefault: false, payload: { model: "shared-model", provider: "provider-beta", api_base: "https://beta.example/v1", api_key: GOOD_KEY } },
      { id: 13, isDefault: false, payload: { model: "disabled-model", provider: "provider-gamma", api_base: "https://gamma.example/v1", api_key: GOOD_KEY, enabled: false } },
      { id: 14, isDefault: false, payload: { model: "unconfigured-model", provider: "provider-delta", api_base: "https://delta.example/v1" } },
    ]
    const primary = resolveModel(rows, "shared-model", {}, 11)
    const candidates = buildConfiguredModelFallbackCandidates(
      rows,
      (entry) => resolveModel(rows, String(entry.payload.model || entry.payload.model_name || ""), {}, entry.id),
      primary,
    )

    expect(candidates).toEqual([{ model: "shared-model", modelIndex: 12 }])
  })

  it("fails closed when a stable model row id is deleted or no longer matches", () => {
    const rows: StoredModelEntry[] = [
      { id: 11, isDefault: true, payload: { model: "shared-model", model_name: "Shared model", provider: "openai-compatible", api_base: "http://127.0.0.1:8001/v1", enabled: true } },
    ]
    expect(resolveModel(rows, "shared-model", {}, 12)).toMatchObject({ configured: false, source: "none", model: "" })
    expect(resolveModel(rows, "different-model", {}, 11)).toMatchObject({ configured: false, source: "none", model: "" })
  })
  it("matches a provider-prefixed fallback to its stored provider and model id", () => {
    const local: StoredModelEntry = { isDefault: false, payload: { model: "lfm2.5-1.2b-instruct-q4_0", model_name: "Local LFM", provider: "llama.cpp", api_base: "http://127.0.0.1:39200/v1" } }
    const resolved = resolveModel([gemini(), local], "llama.cpp/lfm2.5-1.2b-instruct-q4_0", {})
    expect(resolved.matchedRequested).toBe(true)
    expect(resolved.provider).toBe("llama.cpp")
    expect(resolved.model).toBe("lfm2.5-1.2b-instruct-q4_0")
  })
  it("fails closed when the requested name is unknown instead of silently running the default", () => {
    const resolved = resolveModel([gemini()], "Test", { OPENAI_MODEL: "env-default", OPENAI_API_KEY: GOOD_KEY })
    expect(resolved.configured).toBe(false)
    expect(resolved.model).toBe("")
    expect(resolved.source).toBe("none")
    expect(resolved.matchedRequested).toBe(false)
    expect(resolved.reason).toMatch(/Requested model \"Test\" is not configured/)
  })

  it("does not fall back to an environment model when an explicit selection was deleted", () => {
    const resolved = resolveModel([], "deleted-model", { MIKI_MODEL: "other-model", OPENAI_API_KEY: GOOD_KEY })
    expect(resolved.configured).toBe(false)
    expect(resolved.model).toBe("")
    expect(resolved.reason).toMatch(/deleted-model/)
  })
  it("accepts the exact environment-only model id exposed by the virtual Models row", () => {
    const resolved = resolveModel([], "gpt-5-mini", { MIKI_PROVIDER: "openai", OPENAI_MODEL: "gpt-5-mini", OPENAI_API_KEY: "sk-abcdefghijklmnop" })
    expect(resolved).toMatchObject({ configured: true, source: "env", model: "gpt-5-mini", isDefault: true, matchedRequested: false })
  })

  it("accepts an explicit DEFAULT_MODEL id in environment-only deployments", () => {
    const resolved = resolveModel([], "gemini-3.5-flash-lite", { DEFAULT_MODEL: "gemini/gemini-3.5-flash-lite", GEMINI_API_KEY: GOOD_KEY })
    expect(resolved).toMatchObject({ configured: true, source: "env", model: "gemini-3.5-flash-lite", provider: "gemini", isDefault: true })
  })
  it("uses the provider environment key when the stored entry has none", () => {
    const resolved = resolveModel([gemini({ api_key: "" })], undefined, { GEMINI_API_KEY: GOOD_KEY })
    expect(resolved.configured).toBe(true)
    expect(resolved.apiKey).toBe(GOOD_KEY)
  })
  it("is not configured, with a reason, when the key is missing or a placeholder", () => {
    const missing = resolveModel([gemini({ api_key: "" })], undefined, {})
    expect(missing.configured).toBe(false)
    expect(missing.reason).toMatch(/API key/)
    const placeholder = resolveModel([gemini({ api_key: "your_api_key" })], undefined, {})
    expect(placeholder.configured).toBe(false)
    expect(placeholder.keyCheck.status).toBe("placeholder")
  })
  it("treats an openai-compatible model without a key as configured on every surface", () => {
    const resolved = resolveModel(
      [{ isDefault: true, payload: { model: "qwen", provider: "openai-compatible", api_base: "http://10.0.0.5:8000/v1" } }],
      undefined,
      {},
    )
    expect(resolved.configured).toBe(true)
    expect(resolved.keyCheck.status).toBe("not_required")
  })
  it("honours OPENAI_API_BASE for environment-only compatible setups", () => {
    const resolved = resolveModel([], undefined, { MIKI_MODEL: "fake", OPENAI_API_KEY: "test-key-123", OPENAI_API_BASE: "http://127.0.0.1:5555/v1" })
    expect(resolved).toMatchObject({ configured: true, baseUrl: "http://127.0.0.1:5555/v1", model: "fake" })
  })
  it("skips disabled models when choosing the default", () => {
    const disabled = gemini({ enabled: false })
    const other: StoredModelEntry = { isDefault: false, payload: { model: "gemini-3.5-flash", provider: "gemini", api_key: GOOD_KEY } }
    expect(resolveModel([disabled, other], undefined, {}).model).toBe("gemini-3.5-flash")
  })
  it("falls back to environment configuration when nothing is stored", () => {
    const resolved = resolveModel([], undefined, { MIKI_PROVIDER: "openai", OPENAI_MODEL: "gpt-5-mini", OPENAI_API_KEY: "sk-abcdefghijklmnop" })
    expect(resolved).toMatchObject({ configured: true, source: "env", model: "gpt-5-mini" })
  })
  it("reports no model when neither store nor environment provide one", () => {
    const resolved = resolveModel([], undefined, {})
    expect(resolved.configured).toBe(false)
    expect(resolved.source).toBe("none")
  })
})

describe("probeModelProvider", () => {
  const response = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch
  it("flags a rejected key", async () => {
    expect((await probeModelProvider({ baseUrl: "https://x/v1", apiKey: "k" }, { fetchImpl: response(401) })).state).toBe("key_rejected")
  })
  it("reports ok when the provider answers", async () => {
    expect((await probeModelProvider({ baseUrl: "https://x/v1", apiKey: "k" }, { fetchImpl: response(200) })).state).toBe("ok")
  })
  it("reports unreachable on network errors", async () => {
    const failing = (async () => { throw new Error("ECONNREFUSED") }) as unknown as typeof fetch
    const result = await probeModelProvider({ baseUrl: "http://127.0.0.1:1/v1", apiKey: "" }, { fetchImpl: failing })
    expect(result).toMatchObject({ reachable: false, state: "unreachable" })
  })
})

describe("resolveModel: DEFAULT_MODEL / GOOGLE_API_KEY env fallbacks", () => {
  const FAKE = "test-key-0123456789abcdef"

  it("honours DEFAULT_MODEL with a provider prefix when nothing is stored", () => {
    const r = resolveModel([], undefined, { DEFAULT_MODEL: "gemini/gemini-3.5-flash-lite", GEMINI_API_KEY: FAKE })
    expect(r).toMatchObject({ configured: true, provider: "gemini", model: "gemini-3.5-flash-lite" })
  })

  it("accepts GOOGLE_API_KEY for Gemini", () => {
    const r = resolveModel([], undefined, { DEFAULT_MODEL: "google/gemini-2.0-flash-001", GOOGLE_API_KEY: FAKE })
    expect(r).toMatchObject({ configured: true, provider: "gemini", model: "gemini-2.0-flash-001" })
  })

  it("never invents a key: DEFAULT_MODEL without credentials stays unconfigured with an API-key reason", () => {
    const r = resolveModel([], undefined, { DEFAULT_MODEL: "gemini/gemini-3.5-flash-lite" })
    expect(r.configured).toBe(false)
    expect(r.reason).toMatch(/API key/)
  })

  it("keeps precedence: stored default > MIKI_MODEL > DEFAULT_MODEL", () => {
    const stored = resolveModel(
      [{ isDefault: true, payload: { provider: "openai-compatible", model: "stored-one", api_base: "http://127.0.0.1:1/v1", enabled: true } }],
      undefined,
      { DEFAULT_MODEL: "gemini/x", GEMINI_API_KEY: FAKE },
    )
    expect(stored.model).toBe("stored-one")
    const env = resolveModel([], undefined, { MIKI_MODEL: "env-one", MIKI_PROVIDER: "openai-compatible", DEFAULT_MODEL: "gemini/x", GEMINI_API_KEY: FAKE })
    expect(env.model).toBe("env-one")
  })

  it("explains an empty configuration instead of a bare 'no model'", () => {
    const r = resolveModel([], undefined, {})
    expect(r.configured).toBe(false)
    expect(r.reason).toMatch(/No model name is configured.*DEFAULT_MODEL/)
  })
})
