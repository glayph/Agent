import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SkillRegistry,
  type PluginContracts,
} from "@hiro/installer";
import {
  listRuntimePluginChannelMetadata,
  probeRuntimePluginChannel,
} from "./plugin-channel-adapter";

function createWorkspace() {
  const workspaceDir = path.join(
    os.tmpdir(),
    `plugin-channel-adapter-test-${Date.now()}-${Math.random()
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
  const assetsPath = path.join(skillsDir, "channel_plugin_assets");
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
    name: "channel_plugin",
    version: "1.0.0",
    path: path.join(skillsDir, "channel_plugin.ts"),
    action: "installed",
    entrypoint: "index.ts",
    assetsPath,
    contracts,
  });
}

describe("plugin channel adapter bridge", () => {
  let workspaceDir: string;

  afterEach(() => {
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("lists metadata-only plugin channel contracts and probes safe config", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(workspaceDir, {
      channels: [
        {
          name: "ms-teams",
          description: "Microsoft Teams",
          metadata: {
            display_name: "Microsoft Teams",
            config_key: "ms_teams",
            required_fields: ["webhook_url", "token"],
            secret_fields: ["token"],
          },
        },
      ],
    });

    const channels = await listRuntimePluginChannelMetadata(workspaceDir);
    expect(channels).toEqual([
      expect.objectContaining({
        name: "ms_teams",
        display_name: "Microsoft Teams",
        config_key: "ms_teams",
        runtime_status: "config_only",
      }),
    ]);

    const probe = await probeRuntimePluginChannel(
      workspaceDir,
      "ms_teams",
      { enabled: true, webhook_url: "https://example.test/hook" },
      {
        configuredSecrets: ["token"],
        env: {},
        now: new Date("2026-01-01T00:00:00.000Z"),
      },
    );

    expect(probe?.probe_status).toBe("not_implemented");
    expect(probe?.missing_fields).toEqual([]);
    expect(
      probe?.checks.find((check) => check.id === "required:token")?.status,
    ).toBe("pass");
    expect(
      probe?.checks.find((check) => check.id === "plugin_contract_readiness")
        ?.status,
    ).toBe("pass");
  });

  it("keeps executable plugin channels blocked until execution policy is enabled", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(
      workspaceDir,
      {
        channels: [
          {
            name: "teams-probe",
            entrypoint: "channels/probe.js",
            metadata: {
              config_key: "teams_probe",
              required_fields: ["token"],
              secret_fields: ["token"],
            },
          },
        ],
      },
      {
        "channels/probe.js": "process.exit(1);",
      },
    );

    const probe = await probeRuntimePluginChannel(
      workspaceDir,
      "teams_probe",
      { enabled: true },
      { configuredSecrets: ["token"], env: {}, mode: "mock" },
    );

    expect(probe?.probe_status).toBe("needs_config");
    expect(
      probe?.checks.find((check) => check.id === "plugin_contract_readiness")
        ?.status,
    ).toBe("fail");
    expect(
      probe?.checks.find((check) => check.id === "plugin_probe")?.status,
    ).toBe("warn");
  });

  it("executes ready plugin channel probes in sandbox mode", async () => {
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
        channels: [
          {
            name: "teams-probe",
            entrypoint: "channels/probe.js",
            metadata: {
              config_key: "teams_probe",
              required_fields: ["token"],
              secret_fields: ["token"],
            },
          },
        ],
      },
      {
        "channels/probe.js": [
          "let input = '';",
          "process.stdin.on('data', (chunk) => { input += chunk; });",
          "process.stdin.on('end', () => {",
          "  const payload = JSON.parse(input);",
          "  const hasToken = payload.configuredSecrets.includes('token');",
          "  const tokenRedacted = payload.config.token === '[redacted]';",
          "  process.stdout.write(JSON.stringify({ checks: [",
          "    { id: 'plugin_live', status: hasToken ? 'pass' : 'fail', message: 'sandbox probe executed' },",
          "    { id: 'secret_redaction', status: tokenRedacted ? 'pass' : 'fail', message: 'plugin probe received redacted channel config' }",
          "  ] }));",
          "});",
        ].join("\n"),
      },
    );

    const probe = await probeRuntimePluginChannel(
      workspaceDir,
      "teams_probe",
      { enabled: true, token: "super-secret-token" },
      {
        configPath,
        configuredSecrets: ["token"],
        env: {},
        mode: "sandbox",
      },
    );

    expect(probe?.runtime_status).toBe("functional");
    expect(probe?.probe_status).toBe("ready");
    expect(probe?.check_mode).toBe("sandbox");
    expect(
      probe?.checks.find((check) => check.id === "plugin_live")?.status,
    ).toBe("pass");
    expect(
      probe?.checks.find((check) => check.id === "secret_redaction")?.status,
    ).toBe("pass");
  });
});
