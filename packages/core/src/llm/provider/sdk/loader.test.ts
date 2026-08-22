import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ProviderPluginLoader, validateProviderManifest } from "./loader.js";
import { ProviderPluginRegistry } from "./registry.js";
import type { MikiProviderPlugin } from "./index.js";
import { omniRouteProviderPlugin } from "./builtin.js";

function manifest(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    displayName: id,
    version: "1.0.0",
    pluginApiVersion: "1.0",
    capabilities: {
      chat: true,
      tools: true,
      streaming: true,
      vision: false,
      local: false,
    },
    ...overrides,
  };
}

describe("provider-plugin manifest validation", () => {
  it("accepts a valid metadata-only manifest", () => {
    const result = validateProviderManifest(manifest("example-provider"));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects incompatible API versions and unsafe entrypoints", () => {
    const result = validateProviderManifest(
      manifest("example-provider", {
        pluginApiVersion: "2.0",
        entrypoint: "../escape.mjs",
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/incompatible|entrypoint/);
  });

  it("rejects a provider that requires a newer major Miki version", () => {
    const result = validateProviderManifest(
      manifest("example-provider", { minMikiVersion: "9.0.0" }),
      { mikiVersion: "1.3.3" },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/minMikiVersion/);
  });

  it("enforces external permission policy before execution", () => {
    const result = validateProviderManifest(
      manifest("external-provider", { permissions: ["filesystem"] }),
      { source: "external", allowedExternalPermissions: ["network"] },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toMatch(/permission is not allowed/);
  });
});

describe("ProviderPluginLoader", () => {
  it("discovers duplicate IDs deterministically and never executes metadata discovery", () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-provider-loader-"),
    );
    const builtin = path.join(root, "builtin");
    const first = path.join(builtin, "first");
    const second = path.join(builtin, "second");
    fs.mkdirSync(first, { recursive: true });
    fs.mkdirSync(second, { recursive: true });
    for (const directory of [first, second]) {
      fs.writeFileSync(
        path.join(directory, "miki.provider.json"),
        JSON.stringify(manifest("duplicate-provider")),
      );
    }

    const records = new ProviderPluginLoader({
      builtinDirectories: [builtin],
    }).discover();
    expect(records).toHaveLength(2);
    expect(records[0].descriptor.readiness).toBe("metadata_only");
    expect(records[1].descriptor.readiness).toBe("rejected");
    expect(records[1].descriptor.reason).toMatch(/duplicate/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("blocks external executable plugins unless external loading and permissions are explicit", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-provider-external-"),
    );
    fs.writeFileSync(
      path.join(root, "miki.provider.json"),
      JSON.stringify(
        manifest("external-provider", {
          entrypoint: "index.mjs",
          permissions: ["network"],
        }),
      ),
    );
    fs.writeFileSync(path.join(root, "index.mjs"), "export default {};\n");
    const blocked = new ProviderPluginLoader({
      externalDirectory: root,
    }).discover();
    expect(blocked).toHaveLength(0);
    const allowed = new ProviderPluginLoader({
      externalDirectory: root,
      allowExternal: true,
    }).discover();
    expect(allowed[0].descriptor.readiness).toBe("ready");
    await expect(
      new ProviderPluginLoader({ allowExternal: true }).load(allowed[0]),
    ).rejects.toThrow(/bounded runtime-contract/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("reports a missing entrypoint when a built-in executable manifest is loaded", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-provider-missing-"),
    );
    fs.writeFileSync(
      path.join(root, "miki.provider.json"),
      JSON.stringify(
        manifest("missing-provider", { entrypoint: "missing.mjs" }),
      ),
    );
    const loader = new ProviderPluginLoader({ builtinDirectories: [root] });
    const [record] = loader.discover();
    await expect(loader.load(record)).rejects.toThrow(/entrypoint is missing/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("ProviderPluginRegistry", () => {
  const plugin = (id: string, prefixes: string[]): MikiProviderPlugin => ({
    manifest: {
      ...manifest(id, { modelPrefixes: prefixes }),
      capabilities: manifest(id)
        .capabilities as MikiProviderPlugin["manifest"]["capabilities"],
    },
    auth: { mode: "none", allowEmptyKey: true },
    async catalog() {
      return {
        baseUrl: "http://127.0.0.1",
        api: "local",
        auth: this.auth,
        models: [],
      };
    },
    async complete() {
      return {
        choices: [{ message: { role: "assistant", content: "ok" } }],
      } as never;
    },
  });

  it("resolves provider/model references and rejects duplicate registrations", () => {
    const registry = new ProviderPluginRegistry({
      workspaceDir: "/tmp",
      configDir: "/tmp",
    });
    registry.register(plugin("example-provider", ["example"]));
    expect(registry.resolve("example/auto")?.manifest.id).toBe(
      "example-provider",
    );
    expect(() =>
      registry.register(plugin("example-provider", ["example"])),
    ).toThrow(/duplicate/);
  });

  it("exposes OmniRoute’s local endpoint and placeholder authentication policy", async () => {
    const catalog = await omniRouteProviderPlugin.catalog({
      workspaceDir: "/tmp",
      configDir: "/tmp",
      mikiVersion: "1.3.3",
      log() {},
    });
    expect(catalog?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:20128\/v1/);
    expect(omniRouteProviderPlugin.auth.allowEmptyKey).toBe(true);
    expect(omniRouteProviderPlugin.auth.mode).toBe("local");
  });

  it("dispatches through a selected local plugin without requiring a cloud credential", async () => {
    const localPlugin = plugin("local-test", ["local-test"]);
    const registry = new ProviderPluginRegistry({
      workspaceDir: "/tmp",
      configDir: "/tmp",
      resolveCredentials: (auth) => ({
        apiKey: auth.allowEmptyKey ? "" : "synthetic-test-key",
      }),
    });
    registry.register({
      ...localPlugin,
      auth: {
        mode: "local",
        allowEmptyKey: true,
        envVars: [],
        secretFields: [],
      },
    });
    const result = await registry.complete("local-test/auto", [
      { role: "user", content: "test" },
    ]);
    expect(result.choices?.[0]?.message?.content).toBe("ok");
  });

  it("runs provider shutdown hooks when unregistering and shutting down", async () => {
    let shutdownCount = 0;
    const registry = new ProviderPluginRegistry({
      workspaceDir: "/tmp",
      configDir: "/tmp",
    });
    registry.register({
      ...plugin("shutdown-provider", ["shutdown"]),
      async shutdown() {
        shutdownCount += 1;
      },
    });
    await registry.unregister("shutdown-provider");
    expect(shutdownCount).toBe(1);
    registry.register({
      ...plugin("shutdown-provider-2", ["shutdown-two"]),
      async shutdown() {
        shutdownCount += 1;
      },
    });
    await registry.shutdown();
    expect(shutdownCount).toBe(2);
  });
});
