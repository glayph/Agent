import {
  DIRECT_PROVIDERS,
  directProviderForModel,
  getDirectProviderById,
  normalizeDirectModelName,
} from "./catalog.js";
import {
  classifyError,
  openAICompatibleAdapter,
} from "./openai-compatible-adapter.js";
import { providerRegistry } from "./registry.js";
import {
  LLMMissingCredentialError,
  LLMEntitlementError,
  LLMRateLimitError,
} from "./errors.js";

describe("isolated two-provider LLM boundary", () => {
  it("keeps exactly Gemini and llama.cpp in the isolated catalog", () => {
    expect(DIRECT_PROVIDERS.map((provider) => provider.id)).toEqual([
      "gemini",
      "llama.cpp",
    ]);
    expect(getDirectProviderById("google")?.id).toBe("gemini");
    expect(getDirectProviderById("openai")).toBeUndefined();
    expect(getDirectProviderById("openrouter")).toBeUndefined();
    expect(getDirectProviderById("ollama")).toBeUndefined();
  });

  it("routes only Gemini and local model names", () => {
    expect(directProviderForModel("gemini/gemini-2.0-flash")?.id).toBe(
      "gemini",
    );
    expect(directProviderForModel("llama.cpp/local-model")?.id).toBe(
      "llama.cpp",
    );
    expect(directProviderForModel("gpt-4o")).toBeUndefined();
    expect(directProviderForModel("openrouter/model-a")).toBeUndefined();
    expect(normalizeDirectModelName("gemini", "gemini/gemini-2.0-flash")).toBe(
      "gemini-2.0-flash",
    );
    expect(normalizeDirectModelName("llama.cpp", "llama.cpp/local-model")).toBe(
      "local-model",
    );
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

  it("exposes a stable registry facade with only the two providers", () => {
    expect(providerRegistry.resolve("gemini/gemini-3.5-flash-lite")?.id).toBe(
      "gemini",
    );
    expect(providerRegistry.resolve("llama.cpp/local-model")?.id).toBe(
      "llama.cpp",
    );
    expect(providerRegistry.resolve("gpt-4o")).toBeUndefined();
    expect(
      providerRegistry.adapterFor(getDirectProviderById("gemini")!).providerId,
    ).toBe("openai-compatible");
    expect(() => providerRegistry.clearCaches()).not.toThrow();
  });
});
