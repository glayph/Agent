import {
  builtinCapabilityRegistry,
  builtinPluginCatalog,
  getBuiltinPluginManifest,
  listBuiltinPluginManifests,
  listBuiltinPluginHealth,
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

  it("marks the Cron scheduler functional only when its persistent runtime is wired", () => {
    expect(getBuiltinPluginManifest("scheduler.cron")).toMatchObject({
      runtimeStatus: "functional",
      capabilities: ["scheduler"],
    });
  });

  it("does not report manifest-only capability metadata as live healthy", () => {
    const health = listBuiltinPluginHealth()
    expect(health["scheduler.cron"]).toMatchObject({
      ok: false,
      status: "functional",
      source: "manifest_only",
    })
    expect(health["scheduler.cron"]?.message).toMatch(/no live probe/i)
  })

  it("registers capability descriptors without allowing duplicate ids", () => {
    expect(builtinCapabilityRegistry.list().length).toBeGreaterThanOrEqual(15);
    expect(
      new Set(builtinCapabilityRegistry.list().map((item) => item.manifest.id))
        .size,
    ).toBe(builtinCapabilityRegistry.list().length);
  });
});
