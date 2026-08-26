import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SkillRegistry } from "@miki/installer";
import { ToolRegistry } from "../../src/tools/registry/executor";
import { registerRuntimePluginTools } from "../../src/plugins/plugin-tool-registration";
import {
  resolveDownloadedSkillsDir,
  type RuntimePaths,
} from "../../src/paths.js";

function makeRuntimePaths(workspaceDir: string): RuntimePaths {
  return {
    configDir: path.join(workspaceDir, "config"),
    dataDir: path.join(workspaceDir, "data"),
    skillsDir: path.join(workspaceDir, "src", "skills"),
    cacheDir: path.join(workspaceDir, "data", "cache"),
    binDir: path.join(workspaceDir, "bin"),
    docsDir: path.join(workspaceDir, "docs"),
    outputDir: path.join(workspaceDir, "output"),
    sourceDir: workspaceDir,
  };
}

// registerRuntimePluginTools resolves the actual skills directory via
// resolveDownloadedSkillsDir (isolated under dataDir when sandbox_mode is
// on, which is the default), not runtimePaths.skillsDir directly — the
// fixture below must write plugins to the same place production code reads.
function skillsDirFor(workspaceDir: string): string {
  return resolveDownloadedSkillsDir(
    makeRuntimePaths(workspaceDir),
    workspaceDir,
  );
}

function createWorkspace() {
  const workspaceDir = path.join(
    os.tmpdir(),
    `plugin-tool-registration-test-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  fs.mkdirSync(skillsDirFor(workspaceDir), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "config"), { recursive: true });
  return workspaceDir;
}

async function registerEchoPlugin(workspaceDir: string) {
  const skillsDir = skillsDirFor(workspaceDir);
  const assetsPath = path.join(skillsDir, "echo_plugin_assets");
  fs.mkdirSync(path.join(assetsPath, "tools"), { recursive: true });
  fs.writeFileSync(
    path.join(assetsPath, "tools", "echo.js"),
    [
      "let input = '';",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const payload = JSON.parse(input);",
      "  process.stdout.write(JSON.stringify({ output: `echo:${payload.args.message}` }));",
      "});",
    ].join("\n"),
  );

  const registry = new SkillRegistry(skillsDir);
  await registry.init();
  await registry.register({
    success: true,
    name: "echo_plugin",
    version: "1.0.0",
    path: path.join(skillsDir, "echo_plugin.ts"),
    action: "installed",
    entrypoint: "index.ts",
    assetsPath,
    contracts: {
      tools: [
        {
          name: "local.echo",
          description: "Echo an input message",
          entrypoint: "tools/echo.js",
          metadata: {
            parameters: {
              type: "object",
              properties: {
                message: { type: "string" },
              },
              required: ["message"],
            },
          },
        },
      ],
    },
  });
}

describe("registerRuntimePluginTools", () => {
  let workspaceDir: string;

  afterEach(() => {
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("registers ready plugin tools into ToolRegistry and executes them", async () => {
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
    await registerEchoPlugin(workspaceDir);

    const registry = new ToolRegistry(
      makeRuntimePaths(workspaceDir),
      configPath,
    );
    const registration = await registerRuntimePluginTools(
      registry,
      makeRuntimePaths(workspaceDir),
      {
        configPath,
      },
    );

    expect(registration.registered).toEqual([
      {
        toolName: "plugin_echo_plugin_local_echo",
        pluginName: "echo_plugin",
        contractName: "local.echo",
      },
    ]);
    expect(registry.getPluginToolNames()).toEqual([
      "plugin_echo_plugin_local_echo",
    ]);
    expect(
      registry
        .getToolDefinitions()
        .some((tool) => tool.function.name === "plugin_echo_plugin_local_echo"),
    ).toBe(true);

    const result = await registry.executeToolStructured(
      "plugin_echo_plugin_local_echo",
      { message: "hello" },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("echo:hello");
  });

  it("does not register plugin tools that are not policy-ready", async () => {
    workspaceDir = createWorkspace();
    const configPath = path.join(workspaceDir, "config", "tools.yaml");
    fs.writeFileSync(configPath, "runtime:\n  plugin_contracts: {}\n");
    await registerEchoPlugin(workspaceDir);

    const registry = new ToolRegistry(
      makeRuntimePaths(workspaceDir),
      configPath,
    );
    const registration = await registerRuntimePluginTools(
      registry,
      makeRuntimePaths(workspaceDir),
      {
        configPath,
      },
    );

    expect(registration.registered).toHaveLength(0);
    expect(registration.skipped[0]).toEqual(
      expect.objectContaining({
        pluginName: "echo_plugin",
        contractName: "local.echo",
        status: "policy_blocked",
      }),
    );
    expect(registry.getPluginToolNames()).toHaveLength(0);
  });

  it("replaces previously registered plugin tools during refresh", async () => {
    workspaceDir = createWorkspace();
    const configPath = path.join(workspaceDir, "config", "tools.yaml");
    fs.writeFileSync(
      configPath,
      ["runtime:", "  plugin_contracts:", "    allow_execution: true"].join(
        "\n",
      ),
    );
    await registerEchoPlugin(workspaceDir);

    const registry = new ToolRegistry(
      makeRuntimePaths(workspaceDir),
      configPath,
    );
    await registerRuntimePluginTools(registry, makeRuntimePaths(workspaceDir), {
      configPath,
    });

    expect(registry.getPluginToolNames()).toEqual([
      "plugin_echo_plugin_local_echo",
    ]);

    fs.writeFileSync(configPath, "runtime:\n  plugin_contracts: {}\n");
    const refreshed = await registerRuntimePluginTools(
      registry,
      makeRuntimePaths(workspaceDir),
      {
        configPath,
        replaceExisting: true,
      },
    );

    expect(refreshed.registered).toHaveLength(0);
    expect(refreshed.skipped[0]).toEqual(
      expect.objectContaining({
        pluginName: "echo_plugin",
        contractName: "local.echo",
        status: "policy_blocked",
      }),
    );
    expect(registry.getPluginToolNames()).toHaveLength(0);
  });
});
