import type { SystemIndexSearchResult } from "./types.js";
import { type RuntimePaths } from "../paths.js";

const MAX_SNIPPET_CHARS = 320;

export interface AgentSystemIndexSearchPayload {
  query: string;
  indexedFiles: number;
  contentIndexedFiles: number;
  lastIndexedAt: string | null;
  results: SystemIndexSearchResult[];
}

export interface AgentSystemIndexContextOptions {
  cacheTtlMs?: number;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncateText(value: string, maxChars: number): string {
  const compact = compactText(value);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

export function searchSystemIndexForAgent(
  _paths: RuntimePaths,
  _query: string,
  _limit?: number,
): AgentSystemIndexSearchPayload {
  return {
    query: "",
    indexedFiles: 0,
    contentIndexedFiles: 0,
    lastIndexedAt: null,
    results: [],
  };
}

export function formatSystemIndexContext(
  payload: AgentSystemIndexSearchPayload,
): string {
  if (payload.results.length === 0) return "";

  const lines = [
    `Top indexed workspace matches for "${payload.query}" (${payload.results.length}/${payload.indexedFiles} indexed files):`,
  ];

  payload.results.forEach((result, index) => {
    const indexedKind = result.contentIndexed ? "content" : "metadata";
    lines.push(
      `${index + 1}. ${result.path}`,
      `   name: ${result.name}; kind: ${indexedKind}; modified: ${result.modifiedAt}`,
      `   snippet: ${truncateText(result.snippet, MAX_SNIPPET_CHARS)}`,
    );
  });

  lines.push(
    "Use these matches as navigation hints. Verify with file_read before relying on file contents or editing.",
  );

  return lines.join("\n");
}

export function buildSystemIndexContext(
  _paths: RuntimePaths,
  _query: string,
  _limit?: number,
  _options: AgentSystemIndexContextOptions = {},
): string {
  return "";
}
