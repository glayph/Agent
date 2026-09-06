import {
  builtinChannelRegistry,
  SUPPORTED_BUILTIN_CHANNELS,
} from "./builtin-channel-registry.js";
import {
  ChannelPluginLifecycleManager,
  ChannelPluginRegistry,
  channelManifest,
  type BuiltinChannelPlugin,
} from "./sdk/index.js";

describe("built-in channel Plug-in registry", () => {
  it("enumerates every supported dashboard channel exactly once", () => {
    const names = builtinChannelRegistry
      .list()
      .map((plugin) => plugin.manifest.name);
    expect(names).toEqual([
      "telegram",
      "discord",
      "slack",
      "feishu",
      "dingtalk",
      "qq",
      "weixin",
      "wecom",
      "line",
      "onebot",
      "whatsapp",
      "miki",
      "matrix",
      "irc",
      "mqtt",
    ]);
    expect(new Set(names).size).toBe(names.length);
    expect(SUPPORTED_BUILTIN_CHANNELS).toHaveLength(names.length);
  });

  it("keeps partial channels honest and gives every channel a manifest boundary", () => {
    expect(builtinChannelRegistry.get("weixin")?.manifest.runtime_status).toBe(
      "partial",
    );
    expect(builtinChannelRegistry.get("wecom")?.manifest.runtime_status).toBe(
      "partial",
    );
    expect(builtinChannelRegistry.get("weixin")?.createRuntime).toBeUndefined();
    expect(builtinChannelRegistry.get("wecom")?.createRuntime).toBeUndefined();
    for (const plugin of builtinChannelRegistry.list()) {
      expect(plugin.manifest.api_version).toBe("1.0");
      expect(plugin.manifest.config_key).toBe(plugin.manifest.name);
      expect(Array.isArray(plugin.manifest.required_fields)).toBe(true);
      expect(Array.isArray(plugin.manifest.secret_fields)).toBe(true);
    }
  });

  it("mounts only declared webhook hooks through the generic registry", () => {
    const fakeOrchestrator = {} as never;
    const mounted = builtinChannelRegistry.createRouters(fakeOrchestrator);
    expect(mounted.map((item) => item.channel)).toEqual([
      "feishu",
      "dingtalk",
      "qq",
      "line",
      "whatsapp",
    ]);
    for (const item of mounted) {
      expect(typeof item.router).toBe("function");
      expect(Array.isArray(item.router.stack)).toBe(true);
    }
  });

  it("starts, reloads, and stops the same built-in runtime instances", () => {
    const events: string[] = [];
    const runtime = {
      start: () => events.push("start"),
      stop: () => events.push("stop"),
    };
    const plugin: BuiltinChannelPlugin = {
      manifest: channelManifest({
        name: "test",
        config_key: "test",
        required_fields: [],
        secret_fields: [],
      }),
      createRuntime: () => runtime,
    };
    const registry = new ChannelPluginRegistry([plugin]);
    const manager = new ChannelPluginLifecycleManager(
      registry.createRuntimes({} as never),
    );

    manager.startAll();
    manager.reload(["test"]);
    manager.stopAll();

    expect(events).toEqual(["start", "stop", "start", "stop"]);
  });
});
