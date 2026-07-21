import type { ToolDefinition } from "./contracts/tools.js";

export interface McpDiscoveryConfig {
  enabled: boolean;
  ttl: number;
  maxSearchResults: number;
  useBM25: boolean;
  useRegex: boolean;
}

export interface McpServerConfig {
  name: string;
  enabled: boolean;
  type: "stdio" | "http" | "sse";
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  envFile?: string;
  deferred?: boolean | null;
}

export interface McpRuntimeConfig {
  enabled: boolean;
  discovery: McpDiscoveryConfig;
  servers: Record<string, McpServerConfig>;
}

export interface McpCatalogEntry {
  name: string;
  description: string;
  serverName?: string;
  toolName?: string;
  kind: "local" | "external" | "discovery";
  definition: ToolDefinition;
  deferred?: boolean;
}

export interface McpDiscoveryResult {
  query: string;
  matches: Array<{
    name: string;
    description: string;
    serverName?: string;
    score: number;
    deferred: boolean;
  }>;
}

export interface ExternalMcpToolRef {
  serverName: string;
  toolName: string;
  namespacedName: string;
}

export type McpToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<{ success: boolean; output: string; error?: string }>;
