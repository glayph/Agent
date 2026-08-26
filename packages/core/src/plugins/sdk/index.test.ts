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
