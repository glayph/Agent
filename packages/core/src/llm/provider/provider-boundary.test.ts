import {
  DIRECT_PROVIDERS,
  directProviderForModel,
  getDirectProviderById,
  normalizeDirectModelName,
} from "./catalog.js";
import {
  classifyError,
  defaultTimeoutMs,
  openAICompatibleAdapter,
} from "./openai-compatible-adapter.js";
import { providerRegistry } from "./registry.js";
import {
  LLMMissingCredentialError,
  LLMEntitlementError,
  LLMRateLimitError,
} from "./errors.js";

describe("provider gateway boundary", () => {
  it("exposes Gemini, local, OpenAI, OpenAI-compatible, and OpenRouter", () => {
    expect(DIRECT_PROVIDERS.map((provider) => provider.id)).toEqual([
      "gemini",
      "llama.cpp",
      "openai",
      "openai-compatible",
      "openrouter",
    ]);
    expect(getDirectProviderById("google")?.id).toBe("gemini");
    expect(getDirectProviderById("openai")?.id).toBe("openai");
    expect(getDirectProviderById("openrouter")?.id).toBe("openrouter");
    expect(getDirectProviderById("ollama")).toBeUndefined();
  });

  it("routes supported provider model names through the gateway", () => {
    expect(directProviderForModel("gemini/gemini-2.0-flash")?.id).toBe(
      "gemini",
    );
    expect(directProviderForModel("llama.cpp/local-model")?.id).toBe(
      "llama.cpp",
    );
    expect(directProviderForModel("gpt-4o")?.id).toBe("openai");
    expect(directProviderForModel("openrouter/model-a")?.id).toBe("openrouter");
    expect(normalizeDirectModelName("gemini", "gemini/gemini-2.0-flash")).toBe(
      "gemini-2.0-flash",
    );
    expect(normalizeDirectModelName("llama.cpp", "llama.cpp/local-model")).toBe(
      "local-model",
    );
  });

  it("uses a bounded 90-second default timeout for local llama.cpp", () => {
    const previous = process.env.MIKI_LOCAL_LLM_TIMEOUT_MS;
    const localProvider = getDirectProviderById("llama.cpp")!;
    const geminiProvider = getDirectProviderById("gemini")!;
    try {
      delete process.env.MIKI_LOCAL_LLM_TIMEOUT_MS;
      expect(defaultTimeoutMs(localProvider)).toBe(90_000);
      process.env.MIKI_LOCAL_LLM_TIMEOUT_MS = "60000";
      expect(defaultTimeoutMs(localProvider)).toBe(60_000);
      process.env.MIKI_LOCAL_LLM_TIMEOUT_MS = "1000";
      expect(defaultTimeoutMs(localProvider)).toBe(90_000);
      expect(defaultTimeoutMs(geminiProvider)).toBe(120_000);
    } finally {
      if (previous === undefined) delete process.env.MIKI_LOCAL_LLM_TIMEOUT_MS;
      else process.env.MIKI_LOCAL_LLM_TIMEOUT_MS = previous;
    }
  });

  it("uses typed provider errors for missing Gemini credentials", async () => {
    const provider = getDirectProviderById("gemini")!;
    await expect(
      openAICompatibleAdapter.complete({
        provider,
        model: "gemini-3.5-flash-lite",
        apiKey: "",
        messages: [{ role: "user", content: "test" }],
      }),
    ).rejects.toBeInstanceOf(LLMMissingCredentialError);
  });

  it("classifies payment blocks as entitlement errors", () => {
    expect(() =>
      classifyError(
        {
          status: 401,
          message: "No payment method. Add a payment method before completion.",
        },
        "gemini",
        {
          correlationId: "test-entitlement",
          providerId: "gemini",
          model: "gemini-3.5-flash-lite",
          status: 401,
          requestShape: { messageCount: 1, toolCount: 0, payloadBytes: 32 },
        },
      ),
    ).toThrow(LLMEntitlementError);
  });

  it("keeps rate-limit errors retryable and provider-labelled", () => {
    const error = new LLMRateLimitError("quota", {
      providerId: "gemini",
      status: 429,
    });
    expect(error.providerId).toBe("gemini");
    expect(error.status).toBe(429);
    expect(error.retryable).toBe(true);
  });

  it("exposes a stable registry facade for the expanded provider set", () => {
    expect(providerRegistry.resolve("gemini/gemini-3.5-flash-lite")?.id).toBe(
      "gemini",
    );
    expect(providerRegistry.resolve("llama.cpp/local-model")?.id).toBe(
      "llama.cpp",
    );
    expect(providerRegistry.resolve("gpt-4o")?.id).toBe("openai");
    expect(providerRegistry.resolve("openrouter/model-a")?.id).toBe("openrouter");
    expect(
      providerRegistry.adapterFor(getDirectProviderById("gemini")!).providerId,
    ).toBe("openai-compatible");
    expect(() => providerRegistry.clearCaches()).not.toThrow();
  });
});
