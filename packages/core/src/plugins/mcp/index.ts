import { createMcpServer } from "../../mcp/server.js";
import type { RuntimePaths } from "../../paths.js";
import {
  pluginManifest,
  type ManagedPlugin,
  type PluginContext,
  type PluginDescriptor,
  type PluginHealth,
} from "../sdk/index.js";

export type McpPluginServer = Awaited<ReturnType<typeof createMcpServer>>;

export interface McpPluginConfig {
  paths?: RuntimePaths | string;
  workspaceDir?: string;
  enabled?: boolean;
}

export interface McpPluginRuntime extends ManagedPlugin {
  readonly server: McpPluginServer;
}

class McpRuntime implements McpPluginRuntime {
  private closed = false;

  constructor(readonly server: McpPluginServer) {}

  health(): PluginHealth {
    return {
      ok: !this.closed,
      status: this.closed ? "disabled" : "functional",
      details: { protocol: "MCP", externalConnectors: true },
    };
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.server.close();
  }
}

export const mcpPlugin: PluginDescriptor<McpPluginConfig, McpPluginRuntime> = {
  manifest: pluginManifest({
    id: "mcp.server",
    displayName: "Model Context Protocol",
    version: "1.0.0",
    capabilities: ["mcp", "integration"],
    runtimeStatus: "functional",
    description:
      "MCP server, discovery, local-tool bridge, and external connector runtime.",
    configKey: "mcp",
    requiredConfig: [],
    secretFields: ["headers", "env"],
    permissions: ["network", "filesystem-read", "secrets", "mcp"],
    platform: ["any"],
  }),

  async create(
    context: PluginContext,
    config: McpPluginConfig = {},
  ): Promise<McpPluginRuntime> {
    const server = await createMcpServer(undefined, {
      ...config,
      paths: config.paths || context.workspaceDir,
      workspaceDir: config.workspaceDir || context.workspaceDir,
    });
    context.log("plugin.mcp.created", { enabled: config.enabled !== false });
    return new McpRuntime(server);
  },
};
