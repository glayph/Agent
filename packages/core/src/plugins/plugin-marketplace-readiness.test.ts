import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { SkillRegistry, type PluginContracts } from "@hiro/installer";
import { SqliteAuditLog } from "../audit-log";
import { buildPluginMarketplaceReadinessReport } from "./plugin-marketplace-readiness";

function createWorkspace() {
  const workspaceDir = path.join(
    os.tmpdir(),
    `plugin-marketplace-readiness-test-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
  fs.mkdirSync(path.join(workspaceDir, "src", "skills"), { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "config"), { recursive: true });
  return workspaceDir;
}

async function registerPlugin(
  workspaceDir: string,
  options: {
    name?: string;
    description?: string;
    author?: string;
    license?: string;
    contracts?: PluginContracts;
    permissions?: string[];
    files?: Record<string, string>;
    includeAssetsPath?: boolean;
  },
) {
  const name = options.name || "market_plugin";
  const skillsDir = path.join(workspaceDir, "src", "skills");
  const assetsPath = path.join(skillsDir, `${name}_assets`);
  fs.mkdirSync(assetsPath, { recursive: true });

  for (const [relativePath, contents] of Object.entries(options.files || {})) {
    const target = path.join(assetsPath, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  const registry = new SkillRegistry(skillsDir);
  await registry.init();
  await registry.register({
    success: true,
    name,
    version: "1.0.0",
    description: options.description || "",
    author: options.author,
    license: options.license,
    path: path.join(skillsDir, `${name}.ts`),
    action: "installed",
    entrypoint: "index.ts",
    assetsPath: options.includeAssetsPath === false ? undefined : assetsPath,
    permissions: options.permissions,
    contracts: options.contracts,
  });
}

describe("buildPluginMarketplaceReadinessReport", () => {
  let workspaceDir: string;

  afterEach(() => {
    if (workspaceDir) {
      fs.rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("marks executable plugin contracts ready when marketplace metadata and policy are complete", async () => {
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
      description: "GitHub review automation plugin",
      author: "Hiro",
      license: "MIT",
      files: {
        "tools/review.js": "process.stdin.resume();",
      },
      contracts: {
        tools: [
          {
            name: "github_review",
            description: "Review a GitHub pull request.",
            entrypoint: "tools/review.js",
            permissions: ["network.http"],
          },
        ],
      },
    });

    const report = await buildPluginMarketplaceReadinessReport(workspaceDir);

    expect(report.total).toBe(1);
    expect(report.summary.ready).toBe(1);
    expect(report.data[0]).toEqual(
      expect.objectContaining({
        status: "ready",
        marketplaceReady: true,
        score: 100,
      }),
    );
    expect(report.data[0].summary).toEqual(
      expect.objectContaining({
        total: 1,
        executable: 1,
        ready: 1,
        risk: "medium",
      }),
    );
    expect(report.data[0].issues).toEqual([]);
  });

  it("reports policy gaps for executable plugins without enabling unsafe execution by default", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(workspaceDir, {
      description: "Remote lookup plugin",
      author: "Hiro",
      license: "MIT",
      files: {
        "tools/lookup.js": "process.stdin.resume();",
      },
      contracts: {
        tools: [
          {
            name: "remote_lookup",
            description: "Fetch remote lookup data.",
            entrypoint: "tools/lookup.js",
            permissions: ["network.http"],
          },
        ],
      },
    });

    const report = await buildPluginMarketplaceReadinessReport(workspaceDir);

    expect(report.data[0].status).toBe("needs_policy");
    expect(report.data[0].marketplaceReady).toBe(false);
    expect(report.data[0].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "execution_policy_required" }),
        expect.objectContaining({ code: "permission_policy_required" }),
      ]),
    );
  });

  it("blocks marketplace readiness for undeclared entrypoint capabilities", async () => {
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
      name: "undeclared_remote_plugin",
      description: "Remote plugin with incomplete manifest permissions",
      author: "Hiro",
      license: "MIT",
      files: {
        "tools/remote.js": [
          "process.stdin.on('data', () => {});",
          "process.stdin.on('end', async () => {",
          "  await fetch('https://example.com/api');",
          "  process.stdout.write(JSON.stringify({ output: 'ok' }));",
          "});",
        ].join("\n"),
      },
      contracts: {
        tools: [
          {
            name: "undeclared_remote",
            description: "Remote call without declared network permission.",
            entrypoint: "tools/remote.js",
          },
        ],
      },
    });

    const report = await buildPluginMarketplaceReadinessReport(workspaceDir);

    expect(report.data[0].status).toBe("blocked");
    expect(report.data[0].marketplaceReady).toBe(false);
    expect(report.data[0].contracts[0].readiness.staticAnalysis).toEqual(
      expect.objectContaining({
        detectedPermissions: ["network.http"],
        undeclaredPermissions: ["network.http"],
      }),
    );
    expect(report.data[0].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "undeclared_entrypoint_capability",
          permission: "network.http",
        }),
      ]),
    );
  });

  it("allows fully documented metadata-only plugin contracts to remain catalog-ready", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(workspaceDir, {
      description: "Local provider catalog plugin",
      author: "Hiro",
      license: "MIT",
      contracts: {
        providers: [
          {
            name: "local_provider",
            description: "Expose local provider metadata.",
            metadata: {
              id: "local-ai",
              display_name: "Local AI",
            },
          },
        ],
      },
    });

    const report = await buildPluginMarketplaceReadinessReport(workspaceDir);

    expect(report.data[0].status).toBe("metadata_only");
    expect(report.data[0].marketplaceReady).toBe(true);
    expect(report.data[0].summary).toEqual(
      expect.objectContaining({
        metadataOnly: 1,
        executable: 0,
      }),
    );
  });

  it("flags incomplete marketplace metadata without treating metadata-only contracts as unsafe", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(workspaceDir, {
      name: "incomplete_plugin",
      description: "Incomplete plugin",
      includeAssetsPath: false,
      contracts: {
        channels: [
          {
            name: "teams",
            description: "Microsoft Teams channel metadata.",
          },
        ],
      },
    });

    const report = await buildPluginMarketplaceReadinessReport(workspaceDir);

    expect(report.data[0].status).toBe("incomplete");
    expect(report.data[0].marketplaceReady).toBe(false);
    expect(report.data[0].issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing_author" }),
        expect.objectContaining({ code: "missing_license" }),
        expect.objectContaining({ code: "missing_assets_path" }),
      ]),
    );
  });

  it("attaches per-plugin runtime audit evidence when audit records exist", async () => {
    workspaceDir = createWorkspace();
    await registerPlugin(workspaceDir, {
      description: "Audited plugin",
      author: "Hiro",
      license: "MIT",
      contracts: {
        tools: [
          {
            name: "audit_tool",
            description: "Audited tool contract.",
          },
        ],
      },
    });
    const audit = new SqliteAuditLog(
      path.join(workspaceDir, "data", "audit.db"),
    );
    try {
      audit.record({
        type: "plugin.execute",
        actor: "test",
        subject: "market_plugin:tools:audit_tool",
        createdAt: "2026-06-04T01:00:00.000Z",
        details: {
          action: "succeeded",
          status: "ready",
          pluginName: "market_plugin",
          contractName: "audit_tool",
          kind: "tools",
        },
      });
      audit.record({
        type: "plugin.channel_runtime",
        actor: "test",
        subject: "market_plugin:channels:chat",
        createdAt: "2026-06-04T02:00:00.000Z",
        details: {
          action: "message_failed",
          status: "running",
          pluginName: "market_plugin",
          contractName: "chat",
          error: "upstream failed",
        },
      });
    } finally {
      audit.close();
    }

    const report = await buildPluginMarketplaceReadinessReport(workspaceDir);

    expect(report.summary.auditEvents).toBe(2);
    expect(report.data[0].audit).toEqual(
      expect.objectContaining({
        total: 2,
        executions: 1,
        channelRuntimeEvents: 1,
        succeeded: 1,
        failed: 1,
        lastAction: "message_failed",
        lastStatus: "running",
        lastEventAt: "2026-06-04T02:00:00.000Z",
      }),
    );
    expect(report.data[0].audit.recent[0]).toEqual(
      expect.objectContaining({
        type: "plugin.channel_runtime",
        action: "message_failed",
        contractName: "chat",
      }),
    );
  });
});
