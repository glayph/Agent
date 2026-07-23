import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createWorkspaceSecretVault } from "@hiro/config";
import { SkillRegistry, type PluginContracts } from "@hiro/installer";
import type { AgentOrchestrator } from "../agent";
import { SqliteAuditLog } from "../audit-log";
import { normalizeRuntimePaths } from "../paths";
import { PluginChannelRuntimeManager } from "./plugin-channel-runtime";

function createWorkspace() {
  const workspaceDir = path.join(
    os.tmpdir(),
    `plugin-channel-runtime-test-${Date.now()}-${Math.random()
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
  files: Record<string, string>,
) {
  const skillsDir = path.join(workspaceDir, "src", "skills");
  const assetsPath = path.join(skillsDir, "runtime_channel_plugin_assets");
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
    name: "runtime_channel_plugin",
    version: "1.0.0",
    path: path.join(skillsDir, "runtime_channel_plugin.ts"),
    action: "installed",
    entrypoint: "index.ts",
    assetsPath,
    contracts,
  });
}

function runtimeScript() {
  return [
    "const fs = require('fs');",
    "let buffer = '';",
    "let markerPath = '';",
    "function handle(event) {",
    "  if (event.type === 'start') {",
    "    markerPath = event.config.settings.marker_path;",
    "    fs.writeFileSync(`${markerPath}.secret`, event.config.settings.token || '');",
    "    console.log(JSON.stringify({ type: 'ready' }));",
    "    console.log(JSON.stringify({ type: 'message', id: 'm1', userId: 'u1', text: 'hello plugin' }));",
    "  }",
    "  if (event.type === 'reply') {",
    "    fs.writeFileSync(markerPath, event.text);",
    "  }",
    "}",
    "process.stdin.on('data', (chunk) => {",
    "  buffer += chunk.toString('utf8');",
    "  let idx = buffer.indexOf('\\n');",
    "  while (idx >= 0) {",
    "    const line = buffer.slice(0, idx).trim();",
    "    buffer = buffer.slice(idx + 1);",
    "    if (line) handle(JSON.parse(line));",
    "    idx = buffer.indexOf('\\n');",
    "  }",
    "});",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

function createOrchestrator(
  config: Record<string, unknown>,
  seen: Array<{ sessionId: string; message: string }>,
): AgentOrchestrator {
  return {
    config,
    runAgentLoop: async function* (sessionId: string, message: string) {
      seen.push({ sessionId, message });
      yield JSON.stringify({
        type: "stream_chunk",
        content: `reply:${message}`,
      });
    },
  } as unknown as AgentOrchestrator;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

describe("PluginChannelRuntimeManager", () => {
  let workspaceDir: string;
  let manager: PluginChannelRuntimeManager | undefined;

  afterEach(async () => {
    manager?.stopAll();
    manager = undefined;

    if (workspaceDir) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          fs.rmSync(workspaceDir, { recursive: true, force: true });
          return;
        } catch (error) {
          if (attempt === 9) throw error;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  });

  it("starts trusted executable plugin channels and bridges replies", async () => {
    workspaceDir = createWorkspace();
    const markerPath = path.join(workspaceDir, "plugin-reply.txt");
    const configPath = path.join(workspaceDir, "config", "tools.yaml");
    fs.writeFileSync(
      configPath,
      [
        "runtime:",
        "  plugin_contracts:",
        "    allow_execution: true",
        "    allow_channel_runtime: true",
        "    allow_secrets: true",
        "    allow_filesystem_write: true",
        "    max_output_bytes: 8192",
      ].join("\n"),
    );
    createWorkspaceSecretVault(workspaceDir).set(
      "channels/plugin_chat/token",
      "secret-token",
    );
    await registerPlugin(
      workspaceDir,
      {
        channels: [
          {
            name: "plugin-chat",
            entrypoint: "channels/runtime.js",
            permissions: ["secrets.channel", "fs.write"],
            metadata: {
              config_key: "plugin_chat",
              required_fields: ["token"],
              secret_fields: ["token"],
            },
          },
        ],
      },
      { "channels/runtime.js": runtimeScript() },
    );

    const seen: Array<{ sessionId: string; message: string }> = [];
    const orchestrator = createOrchestrator(
      {
        channels: {
          plugin_chat: {
            enabled: true,
            type: "plugin_chat",
            settings: { marker_path: markerPath },
          },
        },
      },
      seen,
    );
    manager = new PluginChannelRuntimeManager(
      orchestrator,
      normalizeRuntimePaths(workspaceDir),
      {
        configPath,
      },
    );

    await manager.startAll();
    await waitFor(() => fs.existsSync(markerPath));

    expect(seen).toEqual([
      { sessionId: "plugin_plugin_chat_u1", message: "hello plugin" },
    ]);
    expect(fs.readFileSync(markerPath, "utf-8")).toBe("reply:hello plugin");
    expect(fs.readFileSync(`${markerPath}.secret`, "utf-8")).toBe(
      "secret-token",
    );
    expect(manager.getStatuses()[0]).toEqual(
      expect.objectContaining({
        channelName: "plugin_chat",
        configKey: "plugin_chat",
        status: "running",
      }),
    );

    const audit = new SqliteAuditLog(
      path.join(workspaceDir, "data", "audit.db"),
    );
    try {
      const actions = audit
        .list({ type: "plugin.channel_runtime", limit: 20 })
        .map((event) => event.details.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "started",
          "message_received",
          "message_replied",
        ]),
      );
      const auditJson = JSON.stringify(
        audit.list({ type: "plugin.channel_runtime", limit: 20 }),
      );
      expect(auditJson).not.toContain("hello plugin");
      expect(auditJson).not.toContain("reply:hello plugin");
    } finally {
      audit.close();
    }

    manager.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const stoppedAudit = new SqliteAuditLog(
      path.join(workspaceDir, "data", "audit.db"),
    );
    try {
      expect(
        stoppedAudit
          .list({ type: "plugin.channel_runtime", limit: 20 })
          .map((event) => event.details.action),
      ).toEqual(expect.arrayContaining(["stopped"]));
    } finally {
      stoppedAudit.close();
    }
  }, 15_000);

  it("skips executable plugin channel runtime without explicit runtime policy", async () => {
    workspaceDir = createWorkspace();
    const configPath = path.join(workspaceDir, "config", "tools.yaml");
    fs.writeFileSync(
      configPath,
      [
        "runtime:",
        "  plugin_contracts:",
        "    allow_execution: true",
        "    allow_secrets: true",
      ].join("\n"),
    );
    await registerPlugin(
      workspaceDir,
      {
        channels: [
          {
            name: "plugin-chat",
            entrypoint: "channels/runtime.js",
            metadata: {
              config_key: "plugin_chat",
              required_fields: [],
              secret_fields: [],
            },
          },
        ],
      },
      { "channels/runtime.js": runtimeScript() },
    );

    manager = new PluginChannelRuntimeManager(
      createOrchestrator(
        {
          channels: {
            plugin_chat: { enabled: true, type: "plugin_chat" },
          },
        },
        [],
      ),
      normalizeRuntimePaths(workspaceDir),
      { configPath },
    );

    await manager.startAll();

    expect(manager.getStatuses()[0]).toEqual(
      expect.objectContaining({
        channelName: "plugin_chat",
        status: "skipped",
      }),
    );
    expect(manager.getStatuses()[0].reason).toContain(
      "allow_channel_runtime=true",
    );
    const audit = new SqliteAuditLog(
      path.join(workspaceDir, "data", "audit.db"),
    );
    try {
      expect(audit.list({ type: "plugin.channel_runtime" })[0]).toEqual(
        expect.objectContaining({
          subject: "runtime_channel_plugin:channels:plugin-chat",
          details: expect.objectContaining({
            action: "skipped",
            status: "skipped",
          }),
        }),
      );
    } finally {
      audit.close();
    }
  });
});
