import { CoreCapabilityPluginHost } from "./core-host.js";

describe("core capability plugin host", () => {
  it("activates safe adapters against injected core services", async () => {
    const services = {
      toolRegistry: {
        getToolDefinitions: () => [],
        executeTool: async () => "ok",
      },
      browser: { setWorkspaceDir: () => {}, close: async () => "closed" },
      computer: {},
      runtimeFetcher: {},
      providerRegistry: {
        pluginDescriptors: () => [],
        resolve: () => undefined,
        complete: async () => ({}),
      },
    };
    const host = new CoreCapabilityPluginHost({
      paths: {
        sourceDir: "/tmp/miki-source",
        configDir: "/tmp/miki-config",
        dataDir: "/tmp/miki-data",
      } as never,
      services: () => services,
      log: () => {},
    });

    await host.start();
    expect(host.isActive("tools.core-registry")).toBe(true);
    expect(host.isActive("browser.playwright")).toBe(true);
    expect(host.isActive("authentication.core")).toBe(false);
    expect(host.isActive("mcp.server")).toBe(false);
    expect(host.isActive("memory.temporal-knowledge-graph")).toBe(false);
    const health = await host.health();
    expect(health["tools.core-registry"]?.ok).toBe(true);
    expect(health["code-execution.runtime-fetch"]?.ok).toBe(true);
    await host.stop();
    expect(await host.health()).toEqual({});
  });
});
