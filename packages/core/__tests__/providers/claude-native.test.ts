import { builtinProviderPlugins } from "../../src/llm/provider/sdk/builtin.js";
import { validateProviderManifest } from "../../src/llm/provider/sdk/loader.js";

describe("legacy provider policy", () => {
  it("exposes only the supported built-in providers", () => {
    expect(
      builtinProviderPlugins.map((provider) => provider.manifest.id),
    ).toEqual([
      "gemini",
      "llama.cpp",
      "openai",
      "openai-compatible",
      "openrouter",
    ]);
    expect(
      builtinProviderPlugins.every(
        (provider) => validateProviderManifest(provider.manifest).valid,
      ),
    ).toBe(true);
  });

  it("does not register the removed Claude provider", () => {
    expect(
      builtinProviderPlugins.some(
        (provider) => provider.manifest.id === "claude",
      ),
    ).toBe(false);
  });
});
