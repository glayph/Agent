import * as fs from "fs";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ExternalMcpToolRef,
  McpCatalogEntry,
  McpRuntimeConfig,
  McpServerConfig,
} from "./types.js";
import type { ToolDefinition } from "./contracts/tools.js";

interface ExternalClient {
  client: Client;
  transport: Transport;
  /** Fingerprint of connection-relevant config used to create this client. */
  fingerprint: string;
}

/** Stable fingerprint of the fields that affect the transport/connection. */
function connectionFingerprint(config: McpServerConfig): string {
  return JSON.stringify({
    type: config.type,
    url: config.url ?? null,
    command: config.command ?? null,
    args: config.args ?? [],
    headers: config.headers ?? {},
    env: config.env ?? {},
    enabled: config.enabled,
  });
}

export function namespaceExternalMcpToolName(
  serverName: string,
  toolName: string,
): string {
  return `${serverName}__${toolName}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function parseEnvFile(filePath: string): Record<string, string> {
  if (!fs.existsSync(filePath)) return {};
  const env: Record<string, string> = {};
  const content = fs.readFileSync(filePath, "utf-8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed
      .slice(index + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    env[key] = value;
  }
  return env;
}

function mergeEnv(
  baseDir: string,
  config: McpServerConfig,
): Record<string, string> | undefined {
  const fileEnv = config.envFile
    ? parseEnvFile(
        path.isAbsolute(config.envFile)
          ? config.envFile
          : path.resolve(baseDir, config.envFile),
      )
    : {};
  const merged = {
    ...fileEnv,
    ...(config.env || {}),
  };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function requestInit(
  headers?: Record<string, string>,
): RequestInit | undefined {
  return headers && Object.keys(headers).length > 0 ? { headers } : undefined;
}

function toolDefinitionFromExternal(
  serverName: string,
  tool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
  },
): ToolDefinition {
  return {
    type: "function",
    function: {
      name: namespaceExternalMcpToolName(serverName, tool.name),
      description: tool.description || `External MCP tool ${tool.name}`,
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  };
}

export class ExternalMcpConnectorManager {
  private clients = new Map<string, ExternalClient>();
  private toolRefs = new Map<string, ExternalMcpToolRef>();

  constructor(
    private readonly workspaceDir: string,
    private runtimeConfig: McpRuntimeConfig,
  ) {}

  updateConfig(runtimeConfig: McpRuntimeConfig): void {
    this.runtimeConfig = runtimeConfig;
    // Close clients whose connection config changed or that are no longer enabled
    // so the next list/call recreates them with the new settings (Issue #55).
    for (const [name, existing] of this.clients) {
      const server = runtimeConfig.servers[name];
      if (!server || !server.enabled) {
        void this.closeClient(name);
        continue;
      }
      const nextFp = connectionFingerprint(server);
      if (existing.fingerprint !== nextFp) {
        void this.closeClient(name);
      }
    }
  }

  private async closeClient(name: string): Promise<void> {
    const existing = this.clients.get(name);
    if (!existing) return;
    this.clients.delete(name);
    // Remove tool refs for this server
    for (const [toolName, ref] of this.toolRefs) {
      if (ref.serverName === name) this.toolRefs.delete(toolName);
    }
    try {
      await existing.client.close();
    } catch {
      // best-effort
    }
  }

  private enabledServers(): McpServerConfig[] {
    return Object.values(this.runtimeConfig.servers).filter(
      (server) => server.enabled,
    );
  }

  private createTransport(config: McpServerConfig): Transport {
    if (config.type === "http") {
      if (!config.url) throw new Error(`MCP server ${config.name} needs url`);
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: requestInit(config.headers),
      });
    }
    if (config.type === "sse") {
      if (!config.url) throw new Error(`MCP server ${config.name} needs url`);
      return new SSEClientTransport(new URL(config.url), {
        requestInit: requestInit(config.headers),
      });
    }
    if (!config.command) {
      throw new Error(`MCP stdio server ${config.name} needs command`);
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args || [],
      env: mergeEnv(this.workspaceDir, config),
      cwd: this.workspaceDir,
      stderr: "pipe",
    });
  }

  private async getClient(config: McpServerConfig): Promise<Client> {
    const fingerprint = connectionFingerprint(config);
    const existing = this.clients.get(config.name);
    if (existing && existing.fingerprint === fingerprint) {
      return existing.client;
    }
    if (existing) {
      await this.closeClient(config.name);
    }

    const client = new Client({
      name: `Miki-mcp-connector-${config.name}`,
      version: "1.0.0",
    });
    const transport = this.createTransport(config);
    await client.connect(transport);
    this.clients.set(config.name, { client, transport, fingerprint });
    return client;
  }

  async listCatalogEntries(includeDeferred = true): Promise<McpCatalogEntry[]> {
    const entries: McpCatalogEntry[] = [];
    for (const server of this.enabledServers()) {
      if (server.deferred && !includeDeferred) continue;
      try {
        const client = await this.getClient(server);
        const result = await client.listTools();
        for (const tool of result.tools) {
          const namespacedName = namespaceExternalMcpToolName(
            server.name,
            tool.name,
          );
          const definition = toolDefinitionFromExternal(server.name, tool);
          this.toolRefs.set(namespacedName, {
            serverName: server.name,
            toolName: tool.name,
            namespacedName,
          });
          entries.push({
            name: namespacedName,
            description: definition.function.description,
            serverName: server.name,
            toolName: tool.name,
            kind: "external",
            definition,
            deferred: server.deferred === true,
          });
        }
      } catch (err) {
        console.warn(
          `[MCP] external server ${server.name} unavailable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
    return entries;
  }

  async callTool(
    namespacedName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const ref = this.toolRefs.get(namespacedName);
    if (!ref) throw new Error(`Unknown external MCP tool '${namespacedName}'`);
    const server = this.runtimeConfig.servers[ref.serverName];
    if (!server) throw new Error(`Unknown MCP server '${ref.serverName}'`);
    const client = await this.getClient(server);
    return client.callTool({
      name: ref.toolName,
      arguments: args,
    });
  }

  async close(): Promise<void> {
    const clients = [...this.clients.values()];
    this.clients.clear();
    this.toolRefs.clear();
    await Promise.allSettled(
      clients.map(async ({ client, transport }) => {
        await client.close();
        await transport.close();
      }),
    );
  }
}
