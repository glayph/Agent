import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SkillRegistry,
  type PluginContracts,
} from "@hiro/installer";
import {
  listRuntimePluginProviderMetadata,
  probeRuntimePluginProvider,
} from "./plugin-provider-adapter";

function createWorkspace() {
  const workspaceDir = path.join(
    os.tmpdir(),
    `plugin-provider-adapter-test-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  fs.mkdirSync(path.join(workspaceDir, "src", "skills"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "config"), { recursive: true });
  return workspaceDir;
}

async function registerPlugin(
  workspaceDir: string,
  contracts: PluginContracts,
  files: Record<string, string> = {},
) {
  const skillsDir = path.join(workspaceDir, "src", "skills");
  const assetsPath = path.join(skillsDir, "provider_plugin_assets");
  fs.mkdirSync(assetsPath, { recursive: true });
  for (const [relativePath, contents] of Object.entries(files)) {
    const target = path.join(assetsPath, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  const registry = new SkillRegistry(skillsDir);
  await registry.init();
  await registry.register({
    success: true,
    name: "provider_plugin",
    version: "1.0.0",
    path: path.join(skillsDir, "provider_plugin.ts"),
    action: "installed",
    entrypoint: "index.ts",
    assetsPath,
    contracts,
  });
}

describe("plugin provider adapter bridge", () => {
  let workspaceDir: string;

  afterEach(() => {
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("lists metadata-only provider contracts as plugin providers", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(workspaceDir, {
      providers: [
        {
          name: "local-openai-compatible",
          description: "Local OpenAI-compatible provider",
          metadata: {
            id: "local-ai",
            display_name: "Local AI",
            base_url: "http://127.0.0.1:9000/v1",
            auth_method: "none",
            local: true,
            models: ["local-chat", "local-reasoner"],
          },
        },
      ],
    });

    const providers = await listRuntimePluginProviderMetadata(workspaceDir);

    expect(providers).toEqual([
      expect.objectContaining({
        id: "local-ai",
        name: "Local AI",
        displayName: "Local AI",
        baseUrl: "http://127.0.0.1:9000/v1",
        authMethod: "none",
        local: true,
        models: ["local-chat", "local-reasoner"],
        source: "plugin",
      }),
    ]);

    const probe = await probeRuntimePluginProvider(workspaceDir, "local-ai");
    expect(probe).toEqual(
      expect.objectContaining({
        success: true,
        status: "metadata_only",
        models: ["local-chat", "local-reasoner"],
      }),
    );
  });

  it("executes ready provider probes and normalizes model output", async () => {
    workspaceDir = createWorkspace();
    const configPath = path.join(workspaceDir, "config", "tools.yaml");
    fs.writeFileSync(
      configPath,
      [
        "runtime:",
        "  plugin_contracts:",
        "    allow_execution: true",
        "    max_output_bytes: 2048",
      ].join("\n"),
    );
    await registerPlugin(
      workspaceDir,
      {
        providers: [
          {
            name: "dynamic-provider",
            entrypoint: "providers/probe.js",
            metadata: {
              id: "dynamic-ai",
              display_name: "Dynamic AI",
              supports_fetch: true,
              models: ["fallback-model"],
            },
          },
        ],
      },
      {
        "providers/probe.js": [
          "let input = '';",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          "  const payload = JSON.parse(input);",
          "  const suffix = payload.args.action === 'models' ? 'models' : 'probe';",
          "  process.stdout.write(JSON.stringify({ models: [`dynamic-${suffix}`, { id: 'dynamic-json' }] }));",
          "});",
        ].join("\n"),
      },
    );

    const probe = await probeRuntimePluginProvider(
      workspaceDir,
      "dynamic-ai",
      {},
      { configPath },
    );

    expect(probe?.success).toBe(true);
    expect(probe?.status).toBe("ready");
    expect(probe?.models).toEqual(["dynamic-probe", "dynamic-json"]);
  });

  it("keeps executable provider probes policy-blocked by default", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(
      workspaceDir,
      {
        providers: [
          {
            name: "dynamic-provider",
            entrypoint: "providers/probe.js",
            metadata: {
              id: "dynamic-ai",
              display_name: "Dynamic AI",
            },
          },
        ],
      },
      { "providers/probe.js": "process.exit(0);" },
    );

    const probe = await probeRuntimePluginProvider(workspaceDir, "dynamic-ai");

    expect(probe?.success).toBe(false);
    expect(probe?.status).toBe("policy_blocked");
    expect(probe?.error).toContain("Plugin contract execution is disabled");
  });
});
