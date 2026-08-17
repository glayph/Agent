import type {
  McpCatalogEntry,
  McpDiscoveryConfig,
  McpDiscoveryResult,
} from "./types.js";

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "by",
  "from",
  "is",
  "are",
  "tool",
  "tools",
  "mcp",
]);

const MAX_QUERY_LENGTH = 512;
const MAX_DISCOVERY_RESULTS = 50;

function tokenize(text: string): string[] {
  return [
    ...new Set(
      text
        .slice(0, MAX_QUERY_LENGTH)
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.flatMap((term) => [term, ...term.split(/[_-]+/)])
        .map((item) => item.trim())
        .filter((item) => item.length > 1 && !STOP_WORDS.has(item)) || [],
    ),
  ];
}

function regexScore(query: string, entry: McpCatalogEntry): number {
  try {
    const trimmedQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
    if (!trimmedQuery) return 0;
    const re = new RegExp(trimmedQuery, "i");
    const text = `${entry.name} ${entry.description} ${entry.serverName || ""}`;
    return re.test(text) ? 100 : 0;
  } catch {
    return 0;
  }
}

function bm25Score(query: string, entry: McpCatalogEntry): number {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0) return 0;
  const text = `${entry.name} ${entry.description} ${entry.serverName || ""}`;
  const docTerms = tokenize(text);
  if (docTerms.length === 0) return 0;
  const termCounts = new Map<string, number>();
  for (const term of docTerms) {
    termCounts.set(term, (termCounts.get(term) || 0) + 1);
  }
  let score = 0;
  for (const term of queryTerms) {
    const exact = termCounts.get(term) || 0;
    const partial = docTerms.some((docTerm) => docTerm.includes(term))
      ? 0.5
      : 0;
    score += exact * 2 + partial;
    if (entry.name.toLowerCase().includes(term)) score += 3;
  }
  return score;
}

export function searchMcpCatalog(
  query: string,
  catalog: McpCatalogEntry[],
  config: McpDiscoveryConfig,
): McpDiscoveryResult {
  const normalizedQuery = query.trim().slice(0, MAX_QUERY_LENGTH);
  const maxSearchResults = Math.max(
    0,
    Math.min(config.maxSearchResults, MAX_DISCOVERY_RESULTS),
  );
  const matches = catalog
    .map((entry) => {
      const regex = config.useRegex ? regexScore(normalizedQuery, entry) : 0;
      const bm25 = config.useBM25 ? bm25Score(normalizedQuery, entry) : 0;
      return { entry, score: Math.max(regex, bm25) };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.entry.name.localeCompare(b.entry.name) ||
        (a.entry.serverName || "").localeCompare(b.entry.serverName || ""),
    )
    .slice(0, maxSearchResults)
    .map(({ entry, score }) => ({
      name: entry.name,
      description: entry.description,
      serverName: entry.serverName,
      score,
      deferred: entry.deferred === true,
    }));

  return { query: normalizedQuery, matches };
}

export class DiscoveryUnlocks {
  private readonly unlockedUntil = new Map<string, number>();

  constructor(private readonly ttlTicks: number) {}

  unlock(toolNames: string[]): void {
    for (const name of toolNames) {
      this.unlockedUntil.set(name, this.ttlTicks);
    }
  }

  isUnlocked(toolName: string): boolean {
    return (this.unlockedUntil.get(toolName) || 0) > 0;
  }

  tick(): void {
    for (const [name, ttl] of this.unlockedUntil) {
      if (ttl <= 1) {
        this.unlockedUntil.delete(name);
      } else {
        this.unlockedUntil.set(name, ttl - 1);
      }
    }
  }
}
