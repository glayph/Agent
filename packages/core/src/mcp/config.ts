import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import type { McpRuntimeConfig, McpServerConfig } from "./types.js";
import { type RuntimePaths } from "../paths.js";

const DEFAULT_CONFIG: McpRuntimeConfig = {
  enabled: true,
  discovery: {
    enabled: true,
    ttl: 5,
    maxSearchResults: 5,
    useBM25: true,
    useRegex: false,
  },
  servers: {},
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  const record = asRecord(value);
  const entries = Object.entries(record)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, item]) => [key, item] as const);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string => typeof item === "string",
  );
  return items.length > 0 ? items : undefined;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function int(value: unknown, fallback: number, min = 1): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.floor(value))
    : fallback;
}

function normalizeServer(name: string, value: unknown): McpServerConfig {
  const record = asRecord(value);
  const type =
    record.type === "http" || record.type === "sse" || record.type === "stdio"
      ? record.type
      : "stdio";
  return {
    name,
    enabled: bool(record.enabled, true),
    type,
    url: typeof record.url === "string" ? record.url : undefined,
    headers: asStringMap(record.headers),
    command: typeof record.command === "string" ? record.command : undefined,
    args: asStringArray(record.args),
    env: asStringMap(record.env),
    envFile:
      typeof record.env_file === "string"
        ? record.env_file
        : typeof record.envFile === "string"
          ? record.envFile
          : undefined,
    deferred: typeof record.deferred === "boolean" ? record.deferred : null,
  };
}

export function loadMcpRuntimeConfig(
  paths: RuntimePaths,
  configPath = path.join(paths.configDir, "tools.yaml"),
): McpRuntimeConfig {
  if (!fs.existsSync(configPath)) return DEFAULT_CONFIG;

  try {
    const raw = yaml.load(fs.readFileSync(configPath, "utf-8"));
    const root = asRecord(raw);
    const runtime = asRecord(root.runtime);
    const mcp = asRecord(runtime.mcp);
    const discovery = asRecord(mcp.discovery);
    const servers = asRecord(mcp.servers);

    return {
      enabled: bool(mcp.enabled, DEFAULT_CONFIG.enabled),
      discovery: {
        enabled: bool(discovery.enabled, DEFAULT_CONFIG.discovery.enabled),
        ttl: int(discovery.ttl, DEFAULT_CONFIG.discovery.ttl),
        maxSearchResults: int(
          discovery.max_search_results,
          DEFAULT_CONFIG.discovery.maxSearchResults,
        ),
        useBM25: bool(discovery.use_bm25, DEFAULT_CONFIG.discovery.useBM25),
        useRegex: bool(discovery.use_regex, DEFAULT_CONFIG.discovery.useRegex),
      },
      servers: Object.fromEntries(
        Object.entries(servers).map(([name, value]) => [
          name,
          normalizeServer(name, value),
        ]),
      ),
    };
  } catch {
    return DEFAULT_CONFIG;
  }
}
