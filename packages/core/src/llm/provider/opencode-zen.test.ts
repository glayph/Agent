import {
  directProviderForModel,
  getDirectProviderById,
  normalizeDirectModelName,
} from "./catalog.js";

describe("OpenCode Zen provider routing", () => {
  it("resolves the opencode model prefix to the Zen endpoint", () => {
    const provider = directProviderForModel("opencode/mimo-v2.5-free");
    expect(provider?.id).toBe("opencode");
    expect(provider?.baseUrl).toBe("https://opencode.ai/zen/v1");
    expect(provider?.apiKeyEnv).toBe("OPENCODE_API_KEY");
  });

  it("normalizes the provider prefix before sending the model to the API", () => {
    expect(
      normalizeDirectModelName("opencode", "opencode/mimo-v2.5-free"),
    ).toBe("mimo-v2.5-free");
  });

  it("exposes the same provider metadata to direct callers", () => {
    expect(getDirectProviderById("opencode")).toMatchObject({
      displayName: "OpenCode Zen",
      emptyApiKeyAllowed: false,
    });
  });
});
