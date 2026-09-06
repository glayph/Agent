import {
  builtinCapabilityRegistry,
  builtinPluginCatalog,
  getBuiltinPluginManifest,
  listBuiltinPluginManifests,
} from "./builtin-plugin-catalog.js";

describe("unified built-in plugin catalog", () => {
  it("contains every requested capability family that has a current implementation or adapter", () => {
    const capabilities = new Set(
      listBuiltinPluginManifests().flatMap((manifest) => manifest.capabilities),
    );
    expect(capabilities).toEqual(
      new Set([
        "ai-provider",
        "channel",
        "mcp",
        "tool",
        "memory",
        "search",
        "browser",
        "computer-use",
        "knowledge",
        "storage",
        "authentication",
        "security",
        "scheduler",
        "workflow",
        "code-execution",
        "integration",
        "notification",
        "model-router",
        "observability",
        "guardrail",
        "agent-to-agent",
      ]),
    );
  });

  it("keeps provider, channel, and capability families distinct", () => {
    expect(
      builtinPluginCatalog.filter((entry) => entry.family === "provider")
        .length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      builtinPluginCatalog.filter((entry) => entry.family === "channel").length,
    ).toBeGreaterThanOrEqual(12);
    expect(
      builtinPluginCatalog.filter((entry) => entry.family === "capability")
        .length,
    ).toBeGreaterThanOrEqual(15);
    expect(getBuiltinPluginManifest("channel.telegram")?.capabilities).toEqual([
      "channel",
    ]);
    expect(getBuiltinPluginManifest("provider.gemini")?.capabilities).toEqual([
      "ai-provider",
    ]);
  });

  it("registers capability descriptors without allowing duplicate ids", () => {
    expect(builtinCapabilityRegistry.list().length).toBeGreaterThanOrEqual(15);
    expect(
      new Set(builtinCapabilityRegistry.list().map((item) => item.manifest.id))
        .size,
    ).toBe(builtinCapabilityRegistry.list().length);
  });
});
