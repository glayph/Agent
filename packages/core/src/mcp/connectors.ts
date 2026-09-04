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
  McpToolSafety,
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
    headerEnv: config.headerEnv ?? {},
    env: config.env ?? {},
    enabled: config.enabled,
    allowSideEffects: config.allowSideEffects === true,
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

export function resolveMcpHeaders(
  config: McpServerConfig,
  environment: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...(config.headers || {}) };
  for (const [headerName, environmentName] of Object.entries(
    config.headerEnv || {},
  )) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) continue;
    const value = environment[environmentName];
    if (typeof value === "string" && value.length > 0)
      headers[headerName] = value;
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function requestInit(
  headers?: Record<string, string>,
): RequestInit | undefined {
  return headers && Object.keys(headers).length > 0 ? { headers } : undefined;
}

function validatedRemoteUrl(config: McpServerConfig): URL {
  if (!config.url) throw new Error(`MCP server ${config.name} needs url`);
  let url: URL;
  try {
    url = new URL(config.url);
  } catch {
    throw new Error(`MCP server ${config.name} has an invalid url`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `MCP server ${config.name} only supports http or https URLs`,
    );
  }
  if (url.username || url.password) {
    throw new Error(
      `MCP server ${config.name} must not embed credentials in its URL; use headers or environment variables instead`,
    );
  }
  return url;
}

function toolSafety(tool: {
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
  };
}): McpToolSafety {
  const annotations = tool.annotations;
  if (
    annotations?.readOnlyHint === false ||
    annotations?.destructiveHint === true ||
    annotations?.idempotentHint === true
  ) {
    return "side_effect";
  }
  if (annotations?.readOnlyHint === true) return "read_only";
  return "unknown";
}

export function isExternalMcpToolExecutionAllowed(
  server: McpServerConfig,
  safety: McpToolSafety,
): boolean {
  return (
    safety === "read_only" ||
    (safety === "side_effect" && server.allowSideEffects === true)
  );
}

function externalMcpFailurePrefix(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    /401|unauthori[sz]ed|forbidden|invalid token|authentication/i.test(message)
  ) {
    return "External MCP authentication failed.";
  }
  if (/timeout|timed out|abort/i.test(message)) {
    return "External MCP server timed out.";
  }
  if (/econn|enotfound|network|fetch failed|connect/i.test(message)) {
    return "External MCP server is unavailable.";
  }
  return "External MCP request failed.";
}

function toolDefinitionFromExternal(
  serverName: string,
  tool: {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    annotations?: {
      readOnlyHint?: boolean;
      destructiveHint?: boolean;
      idempotentHint?: boolean;
    };
  },
  safety: McpToolSafety,
): ToolDefinition {
  return {
    type: "function",
    ...(safety === "read_only"
      ? {}
      : {
          risk: {
            level: "high" as const,
            label: "External MCP side effect",
            reason:
              safety === "side_effect"
                ? "This external MCP tool is not read-only and requires allow_side_effects: true on its server configuration."
                : "This external MCP tool did not declare a read-only annotation and is blocked by default.",
          },
        }),
    function: {
      name: namespaceExternalMcpToolName(serverName, tool.name),
      description: tool.description || `External MCP tool ${tool.name}`,
      parameters: tool.inputSchema || { type: "object", properties: {} },
    },
  };
}

export async function executeMcpToolWithReconnect<T>(
  safety: McpToolSafety,
  invoke: () => Promise<T>,
  reconnect: () => Promise<void>,
): Promise<T> {
  try {
    return await invoke();
  } catch (firstError) {
    await reconnect();
    if (safety !== "read_only") {
      throw new Error(
        `${externalMcpFailurePrefix(firstError)} Side-effect outcome is unknown; automatic retry is blocked to prevent duplicate execution.`,
      );
    }
    try {
      return await invoke();
    } catch (secondError) {
      await reconnect();
      throw new Error(externalMcpFailurePrefix(secondError));
    }
  }
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
      return new StreamableHTTPClientTransport(validatedRemoteUrl(config), {
        requestInit: requestInit(resolveMcpHeaders(config)),
      });
    }
    if (config.type === "sse") {
      return new SSEClientTransport(validatedRemoteUrl(config), {
        requestInit: requestInit(resolveMcpHeaders(config)),
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
        const result = await executeMcpToolWithReconnect(
          "read_only",
          async () => {
            const client = await this.getClient(server);
            return client.listTools();
          },
          () => this.closeClient(server.name),
        );
        for (const tool of result.tools) {
          const namespacedName = namespaceExternalMcpToolName(
            server.name,
            tool.name,
          );
          const safety = toolSafety(tool);
          const definition = toolDefinitionFromExternal(
            server.name,
            tool,
            safety,
          );
          this.toolRefs.set(namespacedName, {
            serverName: server.name,
            toolName: tool.name,
            namespacedName,
            safety,
          });
          entries.push({
            name: namespacedName,
            description: definition.function.description,
            serverName: server.name,
            toolName: tool.name,
            kind: "external",
            definition,
            deferred: server.deferred === true,
            safety,
          });
        }
      } catch (err) {
        console.warn(
          `[MCP] external server ${server.name} unavailable: ${externalMcpFailurePrefix(err)}`,
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
    if (!isExternalMcpToolExecutionAllowed(server, ref.safety)) {
      throw new Error(
        ref.safety === "unknown"
          ? `External MCP tool '${namespacedName}' is blocked because it did not declare a read-only safety annotation.`
          : `External MCP tool '${namespacedName}' is blocked until allow_side_effects: true is configured for server '${server.name}'.`,
      );
    }

    const invoke = async () => {
      const client = await this.getClient(server);
      return client.callTool({
        name: ref.toolName,
        arguments: args,
      });
    };
    return executeMcpToolWithReconnect(ref.safety, invoke, () =>
      this.closeClient(server.name),
    );
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
