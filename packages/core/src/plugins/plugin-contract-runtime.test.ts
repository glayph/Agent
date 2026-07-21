import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SkillRegistry } from "@hiro/installer";
import { SqliteAuditLog } from "../audit-log";
import {
  executeRuntimePluginTool,
  loadRuntimePluginContracts,
} from "./plugin-contract-runtime";

function createWorkspace() {
  const workspaceDir = path.join(
    os.tmpdir(),
    `plugin-runtime-test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );
  fs.mkdirSync(path.join(workspaceDir, "src", "skills"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "config"), { recursive: true });
  return workspaceDir;
}

async function registerPlugin(
  workspaceDir: string,
  options: {
    name?: string;
    permissions?: string[];
    contracts: Parameters<SkillRegistry["register"]>[0]["contracts"];
    plugin?: Parameters<SkillRegistry["register"]>[0]["plugin"];
    createToolEntrypoint?: boolean;
    toolEntrypointContent?: string;
  },
) {
  const skillsDir = path.join(workspaceDir, "src", "skills");
  const assetsPath = path.join(skillsDir, `${options.name || "plugin"}_assets`);
  fs.mkdirSync(path.join(assetsPath, "tools"), { recursive: true });
  if (options.createToolEntrypoint) {
    fs.writeFileSync(
      path.join(assetsPath, "tools", "run.js"),
      options.toolEntrypointContent || "process.stdin.resume();",
    );
  }

  const registry = new SkillRegistry(skillsDir);
  await registry.init();
  await registry.register({
    success: true,
    name: options.name || "plugin",
    version: "1.0.0",
    path: path.join(skillsDir, `${options.name || "plugin"}.ts`),
    action: "installed",
    entrypoint: "index.ts",
    assetsPath,
    permissions: options.permissions,
    contracts: options.contracts,
    plugin: options.plugin,
  });
}

describe("loadRuntimePluginContracts", () => {
  let workspaceDir: string;

  afterEach(() => {
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("marks executable tool contracts ready when policy allows requested permissions", async () => {
    workspaceDir = createWorkspace();
    fs.writeFileSync(
      path.join(workspaceDir, "config", "tools.yaml"),
      [
        "runtime:",
        "  plugin_contracts:",
        "    allow_execution: true",
        "    allow_network: true",
        "    allow_secrets: true",
      ].join("\n"),
    );
    await registerPlugin(workspaceDir, {
      permissions: ["network.http"],
      createToolEntrypoint: true,
      contracts: {
        tools: [
          {
            name: "github_pr_review",
            entrypoint: "tools/run.js",
            permissions: ["secrets.github"],
          },
        ],
      },
    });

    const contracts = await loadRuntimePluginContracts(workspaceDir, {
      kind: "tools",
    });

    expect(contracts).toHaveLength(1);
    expect(contracts[0].readiness.status).toBe("ready");
    expect(contracts[0].readiness.executable).toBe(true);
    expect(contracts[0].readiness.entrypointPath).toContain(
      path.join("tools", "run.js"),
    );
    expect(contracts[0].readiness.risk.level).toBe("high");
  });

  it("blocks executable tools when execution is disabled by default", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(workspaceDir, {
      createToolEntrypoint: true,
      contracts: {
        tools: [
          {
            name: "remote_lookup",
            entrypoint: "tools/run.js",
            permissions: ["network.http"],
          },
        ],
      },
    });

    const [contract] = await loadRuntimePluginContracts(workspaceDir, {
      kind: "tools",
    });

    expect(contract.readiness.status).toBe("policy_blocked");
    expect(contract.readiness.executable).toBe(false);
    expect(contract.readiness.risk.requiresPolicy).toEqual(["network.http"]);
    expect(contract.readiness.reasons).toContain(
      "Plugin contract execution is disabled by policy.",
    );
  });

  it("requires manifest permissions for capabilities detected in entrypoints", async () => {
    workspaceDir = createWorkspace();
    fs.writeFileSync(
      path.join(workspaceDir, "config", "tools.yaml"),
      [
        "runtime:",
        "  plugin_contracts:",
        "    allow_execution: true",
        "    allow_network: true",
      ].join("\n"),
    );
    await registerPlugin(workspaceDir, {
      createToolEntrypoint: true,
      toolEntrypointContent: [
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', async () => {",
        "  await fetch('https://example.com/status');",
        "  process.stdout.write(JSON.stringify({ output: input }));",
        "});",
      ].join("\n"),
      contracts: {
        tools: [{ name: "undeclared_remote", entrypoint: "tools/run.js" }],
      },
    });

    const [contract] = await loadRuntimePluginContracts(workspaceDir, {
      kind: "tools",
    });

    expect(contract.readiness.status).toBe("requires_policy");
    expect(contract.readiness.executable).toBe(false);
    expect(contract.readiness.staticAnalysis).toEqual(
      expect.objectContaining({
        scanned: true,
        detectedPermissions: ["network.http"],
        undeclaredPermissions: ["network.http"],
      }),
    );
    expect(contract.readiness.risk.undeclaredPermissions).toEqual([
      "network.http",
    ]);
    expect(contract.readiness.reasons).toContain(
      'Entrypoint appears to use "network.http" but the contract does not declare that permission.',
    );
  });

  it("marks non-executable channel contracts as metadata-only", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(workspaceDir, {
      contracts: {
        channels: [{ name: "ms_teams" }],
      },
    });

    const [contract] = await loadRuntimePluginContracts(workspaceDir, {
      kind: "channels",
    });

    expect(contract.kind).toBe("channels");
    expect(contract.readiness.status).toBe("metadata_only");
    expect(contract.readiness.executable).toBe(false);
  });

  it("blocks executable contracts when their entrypoint is missing", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(workspaceDir, {
      contracts: {
        tools: [{ name: "missing_tool", entrypoint: "tools/run.ts" }],
      },
    });

    const [contract] = await loadRuntimePluginContracts(workspaceDir, {
      kind: "tools",
    });

    expect(contract.readiness.status).toBe("needs_entrypoint");
    expect(contract.readiness.executable).toBe(false);
    expect(contract.readiness.reasons).toContain(
      "Entrypoint file is missing from installed plugin assets.",
    );
  });

  it("does not execute plugin tools until execution policy is enabled", async () => {
    workspaceDir = createWorkspace();
    fs.writeFileSync(
      path.join(workspaceDir, "config", "tools.yaml"),
      ["runtime:", "  plugin_contracts:", "    allow_network: true"].join("\n"),
    );
    await registerPlugin(workspaceDir, {
      createToolEntrypoint: true,
      contracts: {
        tools: [{ name: "local_echo", entrypoint: "tools/run.js" }],
      },
    });

    const result = await executeRuntimePluginTool(workspaceDir, "local_echo", {
      value: "test",
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe("policy_blocked");
    expect(result.error).toContain("allow_execution=true");

    const audit = new SqliteAuditLog(
      path.join(workspaceDir, "data", "audit.db"),
    );
    try {
      expect(audit.list({ type: "plugin.execute" })[0]).toEqual(
        expect.objectContaining({
          actor: "plugin-runtime",
          subject: "tools:local_echo",
          details: expect.objectContaining({
            action: "blocked",
            status: "policy_blocked",
            payloadKeys: ["args"],
          }),
        }),
      );
    } finally {
      audit.close();
    }
  });

  it("executes ready node plugin tools through a policy-gated stdin payload", async () => {
    workspaceDir = createWorkspace();
    fs.writeFileSync(
      path.join(workspaceDir, "config", "tools.yaml"),
      [
        "runtime:",
        "  plugin_contracts:",
        "    allow_execution: true",
        "    max_output_bytes: 2048",
      ].join("\n"),
    );
    await registerPlugin(workspaceDir, {
      createToolEntrypoint: true,
      toolEntrypointContent: [
        "let input = '';",
        "process.stdin.on('data', (chunk) => { input += chunk; });",
        "process.stdin.on('end', () => {",
        "  const payload = JSON.parse(input);",
        "  process.stdout.write(JSON.stringify({ output: `hello ${payload.args.name}:${payload.runtime.policy_sandbox}` }));",
        "});",
      ].join("\n"),
      contracts: {
        tools: [{ name: "local_echo", entrypoint: "tools/run.js" }],
      },
    });

    const result = await executeRuntimePluginTool(workspaceDir, "local_echo", {
      name: "Hiro",
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe("hello Hiro:true");
    expect(result.plugin?.name).toBe("plugin");
    expect(result.contract?.name).toBe("local_echo");

    const audit = new SqliteAuditLog(
      path.join(workspaceDir, "data", "audit.db"),
    );
    try {
      expect(audit.list({ type: "plugin.execute" })[0]).toEqual(
        expect.objectContaining({
          subject: "plugin:tools:local_echo",
          details: expect.objectContaining({
            action: "succeeded",
            kind: "tools",
            pluginName: "plugin",
            contractName: "local_echo",
            permissions: [],
            payloadKeys: ["args"],
          }),
        }),
      );
    } finally {
      audit.close();
    }
  });
});
