import {
  PluginLifecycleManager,
  PluginRegistry,
  pluginManifest,
  type ManagedPlugin,
} from "./index.js";

describe("shared capability plugin SDK", () => {
  const manifest = pluginManifest({
    id: "test.plugin",
    displayName: "Test Plugin",
    version: "1.0.0",
    capabilities: ["tool"],
    runtimeStatus: "functional",
    requiredConfig: [],
    secretFields: ["token"],
    permissions: [],
    platform: ["any"],
  });

  it("rejects duplicate ids and incompatible API versions", () => {
    const descriptor = { manifest, create: () => ({}) };
    expect(() => new PluginRegistry([descriptor, descriptor])).toThrow(
      "Duplicate plugin registration",
    );
    expect(
      () =>
        new PluginRegistry([
          {
            ...descriptor,
            manifest: { ...manifest, apiVersion: "0.9" as never },
          },
        ]),
    ).toThrow("Unsupported plugin API version");
  });

  it("returns defensive manifest copies", () => {
    const registry = new PluginRegistry([{ manifest, create: () => ({}) }]);
    const copy = registry.manifests()[0];
    copy.capabilities.push("security");
    copy.secretFields?.push("password");
    expect(registry.manifests()[0].capabilities).toEqual(["tool"]);
    expect(registry.manifests()[0].secretFields).toEqual(["token"]);
  });


  it("validates untyped manifests and requires unique supported capabilities", () => {
    expect(() => new PluginRegistry([{
      manifest: { ...manifest, id: "Bad ID", capabilities: ["tool", "tool"] as never },
      create: () => ({}),
    }])).toThrow(/Invalid plugin manifest/)
    expect(() => new PluginRegistry([{
      manifest: { ...manifest, capabilities: ["not-a-capability"] as never },
      create: () => ({}),
    }])).toThrow(/capabilities/)
  })

  it("keeps the registered manifest isolated from caller mutation", () => {
    const mutable = { ...manifest, capabilities: [...manifest.capabilities] }
    const registry = new PluginRegistry([{ manifest: mutable, create: () => ({}) }])
    mutable.displayName = "Changed after registration"
    mutable.capabilities.push("security")
    expect(registry.manifests()[0].displayName).toBe("Test Plugin")
    expect(registry.manifests()[0].capabilities).toEqual(["tool"])
  })

  it("stops already-created runtimes when a later plugin fails to initialize", async () => {
    const events: string[] = []
    const registry = new PluginRegistry([
      { manifest, create: () => ({ stop: () => { events.push("stopped") } }) },
      { manifest: { ...manifest, id: "test.second" }, create: () => { throw new Error("cannot initialize") } },
    ])
    await expect(registry.createRuntimes({
      workspaceDir: "/tmp", configDir: "/tmp/config", dataDir: "/tmp/data", mikiVersion: "test",
      getSecret: () => undefined, log: () => {},
    })).rejects.toThrow(/cannot initialize/)
    expect(events).toEqual(["stopped"])
  })

  it("reuses a runtime and supports reload fallback", async () => {
    const events: string[] = [];
    const runtime: ManagedPlugin = {
      start: () => events.push("start"),
      stop: () => events.push("stop"),
    };
    const registry = new PluginRegistry([{ manifest, create: () => runtime }]);
    const runtimes = await registry.createRuntimes({
      workspaceDir: "/tmp",
      configDir: "/tmp/config",
      dataDir: "/tmp/data",
      mikiVersion: "test",
      getSecret: () => undefined,
      log: () => {},
    });
    const manager = new PluginLifecycleManager(runtimes);
    await manager.startAll();
    await manager.reload(["test.plugin"]);
    await manager.stopAll();
    expect(events).toEqual(["start", "stop", "start", "stop"]);
  });

  it("isolates lifecycle failures and reports them", async () => {
    const manager = new PluginLifecycleManager(
      new Map([
        [
          "broken",
          {
            start: () => {
              throw new Error("boom");
            },
          },
        ],
        ["healthy", { start: () => {} }],
      ]),
    );
    const errors = await manager.startAll();
    expect(errors).toEqual([{ pluginId: "broken", message: "boom" }]);
  });
});
