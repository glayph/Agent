import {
  probeProviderCompletion,
  type CompletionHealthInput,
} from "./completion-health.js";
import type { DirectProviderConfig } from "./catalog.js";

const provider: DirectProviderConfig = {
  id: "opencode",
  displayName: "OpenCode Zen",
  baseUrl: "https://opencode.example/v1",
  apiKeyEnv: "OPENCODE_API_KEY",
  emptyApiKeyAllowed: false,
};

const geminiProvider: DirectProviderConfig = {
  id: "gemini",
  displayName: "Google Gemini",
  baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
  apiKeyEnv: "GEMINI_API_KEY",
  emptyApiKeyAllowed: false,
};

function input(
  overrides: Partial<CompletionHealthInput> = {},
): CompletionHealthInput {
  return {
    provider,
    model: "opencode/mimo-v2.5-free",
    apiKey: "test-key",
    ...overrides,
  };
}

describe("provider completion health", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("reports ready only when a completion choice contains content", async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "READY" }, finish_reason: "stop" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch;

    const result = await probeProviderCompletion(input());

    expect(result.status).toBe("ready");
    expect(result.completionTested).toBe(true);
    expect(result.modelId).toBe("mimo-v2.5-free");
    expect(result.responseShape).toEqual({
      choiceCount: 1,
      contentPresent: true,
      finishReason: "stop",
    });
    expect(global.fetch).toHaveBeenCalledWith(
      "https://opencode.example/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("separates payment entitlement blocks from invalid credentials", async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "No payment method configured" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    ) as typeof fetch;

    const result = await probeProviderCompletion(input());

    expect(result.status).toBe("entitlement_blocked");
    expect(result.error).toContain("active payment method");
  });

  it("reports invalid credentials for an authentication rejection", async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid api key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    const result = await probeProviderCompletion(input());

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("API key");
  });

  it("reports a retryable rate-limit outcome without retrying inside the probe", async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: "quota exceeded" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    const result = await probeProviderCompletion(input());

    expect(result.status).toBe("rate_limited");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("uses Bearer auth for Gemini's OpenAI-compatible completion endpoint", async () => {
    global.fetch = jest.fn(async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer test-gemini-key");
      expect(headers.get("x-goog-api-key")).toBeNull();
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "READY" }, finish_reason: "stop" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const result = await probeProviderCompletion({
      provider: geminiProvider,
      model: "gemini/gemini-3.6-flash",
      apiKey: "test-gemini-key",
    });

    expect(result.status).toBe("ready");
    expect(result.modelId).toBe("gemini-3.6-flash");
  });

  it("classifies Gemini HTTP 400 as invalid configuration rather than unreachable", async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "invalid model" } }), {
          status: 400,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    const result = await probeProviderCompletion({
      provider: geminiProvider,
      model: "gemini/gemini-3.6-flash",
      apiKey: "test-gemini-key",
    });

    expect(result.status).toBe("invalid");
    expect(result.error).toContain("HTTP 400");
  });

  it("does not report ready when the provider returns no message content", async () => {
    global.fetch = jest.fn(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: {} }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as typeof fetch;

    const result = await probeProviderCompletion(input());

    expect(result.status).toBe("unreachable");
    expect(result.completionTested).toBe(true);
    expect(result.responseShape?.contentPresent).toBe(false);
  });
});
