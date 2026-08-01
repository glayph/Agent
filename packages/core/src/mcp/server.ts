import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import crypto from "crypto";
import { callCoreApi, withRetry } from "./core-client.js";
import { currentMcpSessionId } from "./context.js";
import { jsonSchemaToShape } from "./contracts/json-schema.js";
import type { ToolDefinition } from "./contracts/tools.js";
import { loadMcpRuntimeConfig } from "./config.js";
import { ExternalMcpConnectorManager } from "./connectors.js";
import { DiscoveryUnlocks, searchMcpCatalog } from "./discovery.js";
import { mcpErrorContent } from "./errors.js";
import { registerMcpPrompts } from "./prompts.js";
import { registerMcpResources } from "./resources.js";
import type { McpCatalogEntry, McpToolExecutor } from "./types.js";
import {
  normalizeRuntimePaths,
  type RuntimePaths,
  resolveRuntimePaths,
} from "../paths.js";

const TOOL_REFRESH_MS_MIN = parseInt(
  process.env["MCP_TOOL_REFRESH_MIN"] || "10000",
  10,
);
const TOOL_REFRESH_MS_MAX = parseInt(
  process.env["MCP_TOOL_REFRESH_MAX"] || "120000",
  10,
);
const MAX_CONCURRENT_TOOLS = parseInt(
  process.env["MCP_MAX_CONCURRENT_TOOLS"] || "8",
  10,
);

interface CreateMcpServerOptions {
  paths?: RuntimePaths | string;
  workspaceDir?: string;
}

interface RegisteredToolState {
  entry: McpCatalogEntry;
}

class Semaphore {
  private queue: Array<() => void> = [];
  private running = 0;

  constructor(private readonly max: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) next();
  }
}

const toolSemaphore = new Semaphore(MAX_CONCURRENT_TOOLS);

function hashTool(tool: ToolDefinition): string {
  return crypto
    .createHash("md5")
    .update(JSON.stringify(tool.function))
    .digest("hex");
}

function inferRuntimePaths(): RuntimePaths {
  return resolveRuntimePaths();
}

function toCatalogEntry(definition: ToolDefinition): McpCatalogEntry {
  return {
    name: definition.function.name,
    description: definition.function.description,
    kind: "local",
    definition,
  };
}

function discoveryToolDefinition(
  name: "tool_search_tool_regex" | "tool_search_tool_bm25",
): ToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description:
        name === "tool_search_tool_regex"
          ? "Discover available MCP tools by regex search."
          : "Discover available MCP tools by lexical BM25-style ranking.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query or regular expression.",
          },
        },
        required: ["query"],
      },
    },
  };
}

export async function createMcpServer(
  executeTool?: McpToolExecutor,
  options: CreateMcpServerOptions = {},
): Promise<{
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  close: () => Promise<void>;
}> {
  const paths = options.paths
    ? normalizeRuntimePaths(options.paths)
    : options.workspaceDir
      ? normalizeRuntimePaths(options.workspaceDir)
      : inferRuntimePaths();
  let runtimeConfig = loadMcpRuntimeConfig(paths);
  const connectorManager = new ExternalMcpConnectorManager(
    paths.sourceDir ?? paths.dataDir,
    runtimeConfig,
  );
  const discoveryUnlocks = new DiscoveryUnlocks(runtimeConfig.discovery.ttl);

  const server = new McpServer(
    { name: "Hiro-miki-agent", version: "2.0.0" },
    {
      instructions:
        "Hiro autonomous AI agent v2 MCP server. Tools execute through the core ToolRegistry; resources expose agent memory, config, health, heartbeat, self-improvement, metrics, and tasks; prompts help analyze, plan, and debug.",
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true },
      },
    },
  );

  const registeredTools = new Map<
    string,
    ReturnType<typeof server.registerTool>
  >();
  const registeredToolHashes = new Map<string, string>();
  const activeToolState = new Map<string, RegisteredToolState>();
  let catalog: McpCatalogEntry[] = [];
  let currentRefreshMs = TOOL_REFRESH_MS_MIN;
  let consecutiveNoChanges = 0;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  async function executeLocalTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (executeTool) {
      return (await executeTool(name, args)) as unknown as Record<
        string,
        unknown
      >;
    }
    return withRetry(() =>
      callCoreApi<{ error?: string } & Record<string, unknown>>(
        `/tools/${encodeURIComponent(name)}/call`,
        "POST",
        { args, session_id: currentMcpSessionId(), caller: "mcp" },
      ),
    );
  }

  function discoveryHandler(
    mode: "tool_search_tool_regex" | "tool_search_tool_bm25",
  ) {
    return async (args: Record<string, unknown>) => {
      try {
        const query = String(args.query || "").trim();
        if (!query) {
          return {
            content: [{ type: "text" as const, text: "query is required" }],
            isError: true,
          };
        }
        const discoveryConfig = {
          ...runtimeConfig.discovery,
          useRegex: mode === "tool_search_tool_regex",
          useBM25: mode === "tool_search_tool_bm25",
        };
        const result = searchMcpCatalog(query, catalog, discoveryConfig);
        discoveryUnlocks.unlock(result.matches.map((match) => match.name));
        await loadTools();
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        return mcpErrorContent(err, "Discovery error");
      }
    };
  }

  function createToolHandler(name: string) {
    return async (args: Record<string, unknown>) => {
      await toolSemaphore.acquire();
      try {
        const state = activeToolState.get(name);
        if (!state) {
          return {
            content: [
              { type: "text" as const, text: `Tool '${name}' is not active` },
            ],
            isError: true,
          };
        }

        if (state.entry.kind === "discovery") {
          return discoveryHandler(
            name as "tool_search_tool_regex" | "tool_search_tool_bm25",
          )(args);
        }

        if (state.entry.kind === "external") {
          const result = await connectorManager.callTool(name, args);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        const result = await executeLocalTool(name, args);
        if (result && typeof result === "object" && result.error) {
          return {
            content: [{ type: "text" as const, text: String(result.error) }],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (err) {
        return mcpErrorContent(err, "Tool error");
      } finally {
        toolSemaphore.release();
      }
    };
  }

  function discoveryEntries(): McpCatalogEntry[] {
    if (!runtimeConfig.discovery.enabled) return [];
    const entries: McpCatalogEntry[] = [];
    if (runtimeConfig.discovery.useRegex) {
      const definition = discoveryToolDefinition("tool_search_tool_regex");
      entries.push({
        name: definition.function.name,
        description: definition.function.description,
        kind: "discovery",
        definition,
      });
    }
    if (runtimeConfig.discovery.useBM25) {
      const definition = discoveryToolDefinition("tool_search_tool_bm25");
      entries.push({
        name: definition.function.name,
        description: definition.function.description,
        kind: "discovery",
        definition,
      });
    }
    return entries;
  }

  async function loadTools(): Promise<void> {
    try {
      runtimeConfig = loadMcpRuntimeConfig(paths);
      connectorManager.updateConfig(runtimeConfig);

      if (runtimeConfig.enabled === false) {
        let changed = false;
        for (const [name, tool] of registeredTools) {
          tool.remove();
          registeredTools.delete(name);
          registeredToolHashes.delete(name);
          activeToolState.delete(name);
          changed = true;
        }
        catalog = [];
        if (changed) {
          server.sendToolListChanged();
        }
        return;
      }

      const localTools = await callCoreApi<{ tools: ToolDefinition[] }>(
        "/tools",
      );
      const localEntries = (localTools.tools || []).map(toCatalogEntry);
      const externalEntries = await connectorManager.listCatalogEntries(true);
      catalog = [...localEntries, ...externalEntries];
      const visibleEntries = [
        ...localEntries,
        ...externalEntries.filter(
          (entry) => !entry.deferred || discoveryUnlocks.isUnlocked(entry.name),
        ),
        ...discoveryEntries(),
      ];
      const visibleNames = new Set(visibleEntries.map((entry) => entry.name));
      let changed = false;

      for (const [name, tool] of registeredTools) {
        if (!visibleNames.has(name)) {
          tool.remove();
          registeredTools.delete(name);
          registeredToolHashes.delete(name);
          activeToolState.delete(name);
          changed = true;
        }
      }

      for (const entry of visibleEntries) {
        const definition = entry.definition;
        const fn = definition.function;
        const newHash = hashTool(definition);
        const oldHash = registeredToolHashes.get(fn.name);
        activeToolState.set(fn.name, { entry });

        if (oldHash === newHash && registeredTools.has(fn.name)) continue;

        const shape = jsonSchemaToShape(fn.parameters);
        if (registeredTools.has(fn.name)) {
          registeredTools.get(fn.name)!.update({
            description: fn.description,
            paramsSchema: shape,
            callback: createToolHandler(fn.name),
          });
        } else {
          const tool = server.registerTool(
            fn.name,
            { description: fn.description, inputSchema: shape },
            createToolHandler(fn.name),
          );
          registeredTools.set(fn.name, tool);
        }
        registeredToolHashes.set(fn.name, newHash);
        changed = true;
      }

      if (changed) {
        server.sendToolListChanged();
        consecutiveNoChanges = 0;
        currentRefreshMs = TOOL_REFRESH_MS_MIN;
      } else {
        consecutiveNoChanges++;
        if (consecutiveNoChanges >= 3) {
          currentRefreshMs = Math.min(
            currentRefreshMs * 1.5,
            TOOL_REFRESH_MS_MAX,
          );
        }
      }
      discoveryUnlocks.tick();
    } catch (err) {
      console.error("Failed to refresh MCP tools:", err);
    } finally {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(loadTools, currentRefreshMs);
    }
  }

  await loadTools();
  let cleanupCalled = false;

  registerMcpResources(server);
  registerMcpPrompts(server);

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
  });
  await server.connect(transport);

  return {
    server,
    transport,
    close: async () => {
      if (cleanupCalled) return;
      cleanupCalled = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      await connectorManager.close();
      await server.close();
    },
  };
}
