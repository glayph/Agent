import { URL } from "node:url";

export type SearchMode = "local" | "cloud" | "auto";

export interface SearchFilters {
  domains?: string[];
  freshness?: "day" | "week" | "month" | "year" | "any";
  locale?: string;
  maxResults?: number;
}

export interface SearchQuery {
  query: string;
  filters?: SearchFilters;
  mode?: SearchMode;
  allowSensitiveCloud?: boolean;
}

export interface SearchResult {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  source: "local" | "cloud";
  provider: string;
  fetchedAt: string;
  contentHash?: string;
  citation?: string;
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  executionMode: "local" | "cloud";
  provider: string;
  results: SearchResult[];
  fallbackReason?: string;
  fetchedAt: string;
}

export interface PageFetchResponse {
  url: string;
  source: "local" | "cloud";
  provider: string;
  fetchedAt: string;
  status: number;
  contentType: string;
  text: string;
  contentHash: string;
}

export interface SearchProvider {
  readonly name: string;
  readonly executionMode: "local" | "cloud";
  search(query: SearchQuery): Promise<SearchResult[]>;
  fetch(url: string): Promise<PageFetchResponse>;
}

export type FetchLike = typeof fetch;

function clampResults(value: number | undefined): number {
  if (!Number.isFinite(value)) return 5;
  return Math.max(1, Math.min(20, Math.floor(value!)));
}

function normalizeText(value: string): string {
  return value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string): string {
  return normalizeText(value);
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function withTimeout(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1000, Math.min(timeoutMs, 120_000)));
}

function isSensitiveQuery(query: string): boolean {
  return /\b(password|passcode|api[ _-]?key|secret|token|private key|credit card|ssn|social security|one[- ]time password|otp)\b/i.test(
    query,
  );
}

function parseLocalSearchResults(
  html: string,
  maxResults: number,
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = [];
  const pattern =
    /<a[^>]*class=["'][^"']*result__a[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while (results.length < maxResults && (match = pattern.exec(html))) {
    const rawUrl = decodeHtml(match[1]);
    let url = rawUrl;
    try {
      const parsed = new URL(rawUrl, "https://html.duckduckgo.com");
      const redirected = parsed.searchParams.get("uddg");
      url = redirected ? decodeURIComponent(redirected) : parsed.toString();
    } catch {
      continue;
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const after = html.slice(
      match.index + match[0].length,
      match.index + match[0].length + 1600,
    );
    const snippetMatch = after.match(/result__snippet[^>]*>([\s\S]*?)<\/a?>/i);
    results.push({
      title: decodeHtml(match[2]),
      url,
      snippet: snippetMatch ? decodeHtml(snippetMatch[1]) : "",
    });
  }
  return results;
}

export class LocalSearchProvider implements SearchProvider {
  readonly name = "duckduckgo-html-local";
  readonly executionMode = "local" as const;

  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  async search(input: SearchQuery): Promise<SearchResult[]> {
    const maxResults = clampResults(input.filters?.maxResults);
    const query = input.filters?.domains?.length
      ? `${input.query} ${input.filters.domains.map((domain) => `site:${domain}`).join(" ")}`
      : input.query;
    const endpoint = new URL("https://html.duckduckgo.com/html/");
    endpoint.searchParams.set("q", query);
    if (input.filters?.locale)
      endpoint.searchParams.set("kl", input.filters.locale);
    const response = await this.fetchImpl(endpoint, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Agent-Miki-LocalSearch/1.0 (+local-first)",
      },
      signal: withTimeout(this.timeoutMs),
    });
    if (!response.ok) {
      throw new Error(`Local search provider returned HTTP ${response.status}`);
    }
    const html = await response.text();
    const fetchedAt = new Date().toISOString();
    const parsed = parseLocalSearchResults(html, maxResults);
    return Promise.all(
      parsed.map(async (result) => ({
        ...result,
        domain: domainOf(result.url),
        source: "local" as const,
        provider: this.name,
        fetchedAt,
        contentHash: await sha256(
          `${result.title}\n${result.url}\n${result.snippet}`,
        ),
        citation: `[${result.title}](${result.url})`,
      })),
    );
  }

  async fetch(url: string): Promise<PageFetchResponse> {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) {
      throw new Error("Local search fetch only permits http(s) URLs");
    }
    const response = await this.fetchImpl(parsed, {
      headers: {
        accept: "text/html,application/xhtml+xml,text/plain",
        "user-agent": "Agent-Miki-LocalSearch/1.0 (+local-first)",
      },
      signal: withTimeout(this.timeoutMs),
    });
    const body = await response.text();
    const text = normalizeText(body).slice(0, 200_000);
    return {
      url: parsed.toString(),
      source: "local",
      provider: this.name,
      fetchedAt: new Date().toISOString(),
      status: response.status,
      contentType: response.headers.get("content-type") || "unknown",
      text,
      contentHash: await sha256(text),
    };
  }
}

export class CloudSearchProvider implements SearchProvider {
  readonly name = "configured-cloud-search";
  readonly executionMode = "cloud" as const;

  constructor(
    private readonly endpoint: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 30_000,
  ) {}

  async search(input: SearchQuery): Promise<SearchResult[]> {
    if (!this.endpoint)
      throw new Error("Cloud search provider is not configured");
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({
        query: input.query,
        filters: input.filters || {},
        executionMode: "cloud",
      }),
      signal: withTimeout(this.timeoutMs),
    });
    if (!response.ok)
      throw new Error(`Cloud search provider returned HTTP ${response.status}`);
    const payload = (await response.json()) as { results?: unknown };
    const rawResults = Array.isArray(payload.results) ? payload.results : [];
    const fetchedAt = new Date().toISOString();
    return Promise.all(
      rawResults
        .slice(0, clampResults(input.filters?.maxResults))
        .map(async (raw) => {
          const result = (raw || {}) as Record<string, unknown>;
          const url = typeof result.url === "string" ? result.url : "";
          const title = typeof result.title === "string" ? result.title : url;
          const snippet =
            typeof result.snippet === "string" ? result.snippet : "";
          return {
            title,
            url,
            domain: domainOf(url),
            snippet,
            source: "cloud" as const,
            provider: this.name,
            fetchedAt,
            contentHash: await sha256(`${title}\n${url}\n${snippet}`),
            citation: url ? `[${title}](${url})` : undefined,
          };
        }),
    );
  }

  async fetch(): Promise<PageFetchResponse> {
    throw new Error(
      "Cloud page fetching requires a configured browser/search worker endpoint",
    );
  }
}

export class LocalFirstSearchRouter {
  readonly defaultMode: SearchMode;

  constructor(
    private readonly local: SearchProvider = new LocalSearchProvider(),
    private readonly cloud: SearchProvider | null = process.env
      .MIKI_CLOUD_SEARCH_URL
      ? new CloudSearchProvider(
          process.env.MIKI_CLOUD_SEARCH_URL,
          process.env.MIKI_CLOUD_SEARCH_TOKEN,
        )
      : null,
    defaultMode: SearchMode = normalizeMode(process.env.MIKI_WEB_SEARCH_MODE),
  ) {
    this.defaultMode = defaultMode;
  }

  async search(input: SearchQuery): Promise<SearchResponse> {
    const mode = input.mode || this.defaultMode;
    const startedAt = new Date().toISOString();
    if (!input.query.trim()) throw new Error("Search query cannot be empty");
    if (
      mode === "cloud" &&
      isSensitiveQuery(input.query) &&
      !input.allowSensitiveCloud
    ) {
      throw new Error(
        "Cloud search is blocked for sensitive queries unless explicitly allowed",
      );
    }
    if (mode === "local") {
      return this.response(
        input,
        mode,
        "local",
        await this.local.search(input),
        startedAt,
      );
    }
    if (mode === "cloud") {
      if (!this.cloud) throw new Error("Cloud search is not configured");
      return this.response(
        input,
        mode,
        "cloud",
        await this.cloud.search(input),
        startedAt,
      );
    }
    try {
      return this.response(
        input,
        mode,
        "local",
        await this.local.search(input),
        startedAt,
      );
    } catch (localError: unknown) {
      if (!this.cloud) throw localError;
      if (isSensitiveQuery(input.query) && !input.allowSensitiveCloud)
        throw localError;
      const reason =
        localError instanceof Error ? localError.message : String(localError);
      return this.response(
        input,
        mode,
        "cloud",
        await this.cloud.search(input),
        startedAt,
        reason,
      );
    }
  }

  async fetch(
    url: string,
    mode: SearchMode = this.defaultMode,
  ): Promise<PageFetchResponse> {
    if (mode === "cloud") {
      if (!this.cloud) throw new Error("Cloud search is not configured");
      return this.cloud.fetch(url);
    }
    if (mode === "local") return this.local.fetch(url);
    try {
      return await this.local.fetch(url);
    } catch (localError: unknown) {
      if (!this.cloud) throw localError;
      return this.cloud.fetch(url);
    }
  }

  private response(
    input: SearchQuery,
    mode: SearchMode,
    executionMode: "local" | "cloud",
    results: SearchResult[],
    _startedAt: string,
    fallbackReason?: string,
  ): SearchResponse {
    return {
      query: input.query,
      mode,
      executionMode,
      provider:
        executionMode === "local"
          ? this.local.name
          : this.cloud?.name || "unknown",
      results,
      fallbackReason,
      fetchedAt: new Date().toISOString(),
    };
  }
}

export function normalizeMode(value: string | undefined): SearchMode {
  return value === "cloud" || value === "auto" ? value : "local";
}

export function createDefaultSearchRouter(): LocalFirstSearchRouter {
  return new LocalFirstSearchRouter();
}
