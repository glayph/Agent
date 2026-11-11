import { describe, expect, it, vi } from "vitest";
import { ProviderGateway } from "./provider-gateway.js";

describe("ProviderGateway", () => {
  const gateway = new ProviderGateway();

  it("recognizes local provider aliases without exposing registry access to the Agent", () => {
    expect(gateway.isLocalProviderId("llama-cpp")).toBe(true);
    expect(gateway.isLocalProviderId("local")).toBe(true);
  });

  it("creates an OpenAI-compatible transport for a legacy provider route", () => {
    const client = gateway.createAgentClient({
      providerId: "legacy-unregistered-provider",
      model: "demo-model",
      baseUrl: "http://127.0.0.1:8000/v1",
      apiKey: "test-key-not-used",
    });

    expect(client.model).toBe("demo-model");
    expect(client.routeKey).toContain("demo-model");
  });

  it("re-resolves the active route and credentials at every completion", async () => {
    const mutableGateway = new ProviderGateway()
    let route = {
      providerId: "provider-a", model: "model-a", baseUrl: "http://127.0.0.1:8001/v1", apiKey: "key-a",
    }
    const providerResponse = { choices: [{ message: { role: "assistant", content: "response from provider-b" } }] } as never
    const complete = vi.fn(async () => providerResponse)
    const createClient = vi.spyOn(mutableGateway, "createAgentClient").mockImplementation((next) => ({
      model: next.model,
      providerId: next.providerId,
      routeKey: `${next.providerId}|${next.model}|${next.apiKey ?? ""}`,
      async complete(messages, options) { return complete() },
    }))
    const dynamic = mutableGateway.createDynamicAgentClient(() => route)
    expect(dynamic.model).toBe("model-a")
    expect(dynamic.providerId).toBe("provider-a")

    route = { providerId: "provider-b", model: "model-b", baseUrl: "http://127.0.0.1:8002/v1", apiKey: "key-b" }
    expect(dynamic.model).toBe("model-b")
    expect(dynamic.providerId).toBe("provider-b")
    expect(await dynamic.complete([])).toBe(providerResponse)
    expect(createClient).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "provider-b", model: "model-b", apiKey: "key-b",
    }))
  })

  it("returns no credential fallbacks for an unknown provider model", () => {
    expect(gateway.credentialFallbacks("unknown-provider/demo-model", [])).toEqual([]);
  });
});
