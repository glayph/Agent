import {
  DIRECT_PROVIDERS,
  directProviderForModel,
  getDirectProviderById,
  normalizeDirectModelName,
  registerCustomProviders,
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

describe("isolated LLM provider boundary", () => {
  beforeEach(() => registerCustomProviders(null));

  it("keeps builtin provider metadata in the isolated catalog", () => {
    expect(DIRECT_PROVIDERS.map((provider) => provider.id)).toEqual([
      "gemini",
      "openai",
      "opencode",
      "openrouter",
      "claude",
      "ollama",
      "omniroute",
      "llama.cpp",
    ]);
    expect(getDirectProviderById("google")?.id).toBe("gemini");
    expect(getDirectProviderById("anthropic")?.id).toBeUndefined();
  });

  it("routes model names without exposing SDK details to callers", () => {
    expect(directProviderForModel("gemini/gemini-2.0-flash")?.id).toBe(
      "gemini",
    );
    expect(directProviderForModel("gpt-4o")?.id).toBe("openai");
    expect(directProviderForModel("claude/claude-sonnet-4-5")?.id).toBe(
      "claude",
    );
    expect(normalizeDirectModelName("gemini", "gemini/gemini-2.0-flash")).toBe(
      "gemini-2.0-flash",
    );
    expect(
      normalizeDirectModelName("claude", "anthropic/claude-sonnet-4-5"),
    ).toBe("claude-sonnet-4-5");
  });

  it("supports custom OpenAI-compatible providers without changing core callers", () => {
    registerCustomProviders({
      internal: {
        displayName: "Internal Gateway",
        baseUrl: "http://127.0.0.1:4096/v1",
        apiKeyEnv: "INTERNAL_API_KEY",
      },
    });
    expect(directProviderForModel("internal/model-a")?.id).toBe("internal");
    expect(normalizeDirectModelName("internal", "internal/model-a")).toBe(
      "model-a",
    );
  });

  it("uses typed provider errors for missing credentials", async () => {
    const provider = getDirectProviderById("openai")!;
    await expect(
      openAICompatibleAdapter.complete({
        provider,
        model: "gpt-4o",
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
        "opencode",
        {
          correlationId: "test-entitlement",
          providerId: "opencode",
          model: "mimo-v2.5-free",
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

  it("exposes a stable registry facade with provider-specific adapters", () => {
    expect(providerRegistry.resolve("gpt-4o")?.id).toBe("openai");
    expect(providerRegistry.resolve("claude/claude-sonnet-4-5")?.id).toBe(
      "claude",
    );
    expect(
      providerRegistry.adapterFor(getDirectProviderById("gemini")!).providerId,
    ).toBe("openai-compatible");
    expect(
      providerRegistry.adapterFor(getDirectProviderById("claude")!).providerId,
    ).toBe("claude");
    expect(() => providerRegistry.clearCaches()).not.toThrow();
  });
});
