import { builtinProviderPlugins } from "../../src/llm/provider/sdk/builtin.js";
import { validateProviderManifest } from "../../src/llm/provider/sdk/loader.js";

describe("legacy provider policy", () => {
  it("exposes only the supported Gemini and llama.cpp built-ins", () => {
    expect(
      builtinProviderPlugins.map((provider) => provider.manifest.id),
    ).toEqual(["gemini", "llama.cpp"]);
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
