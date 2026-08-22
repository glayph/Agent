import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import {
  createWorkspaceSecretVault,
  resolveConfiguredSecret,
} from "@miki/config";

export type WebSearchExecutionMode = "local" | "cloud" | "auto";

export interface WebSearchProviderSettings {
  enabled?: boolean;
  max_results?: number;
  base_url?: string;
  api_key_set?: boolean;
  model?: string;
}

export interface WebSearchConfig {
  execution_mode?: WebSearchExecutionMode;
  provider?: string;
  current_service?: string;
  prefer_native?: boolean;
  proxy?: string;
  providers?: Array<{
    id?: string;
    configured?: boolean;
    current?: boolean;
    requires_auth?: boolean;
  }>;
  settings?: Record<string, WebSearchProviderSettings>;
}

export interface WebSearchResult {
  rank: number;
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface WebSearchResponse {
  query: string;
  requested_mode: WebSearchExecutionMode;
  mode: "local" | "api";
  provider: string;
  fallback_used: boolean;
  results: WebSearchResult[];
  citations: Array<{ id: number; title: string; url: string }>;
}

const LOCAL_PROVIDERS = new Set(["native", "duckduckgo"]);
const API_PROVIDERS = new Set(["brave", "tavily", "serpapi", "serper", "bing"]);
const API_ENV_KEYS: Record<string, string> = {
  brave: "BRAVE_SEARCH_API_KEY",
  tavily: "TAVILY_API_KEY",
  serpapi: "SERPAPI_API_KEY",
  serper: "SERPER_API_KEY",
  bing: "BING_SEARCH_API_KEY",
};
const DEFAULT_API_BASES: Record<string, string> = {
  brave: "https://api.search.brave.com/res/v1/web/search",
  tavily: "https://api.tavily.com/search",
  serpapi: "https://serpapi.com/search.json",
  serper: "https://google.serper.dev/search",
  bing: "https://api.bing.microsoft.com/v7.0/search",
};
const DEFAULT_MAX_RESULTS = 5;
const REQUEST_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeMode(value: unknown): WebSearchExecutionMode {
  if (value === "cloud" || value === "api") return "cloud";
  return value === "auto" ? value : "local";
}

function normalizeMaxResults(
  value: unknown,
  fallback = DEFAULT_MAX_RESULTS,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(10, Math.floor(parsed)));
}

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function dedupeResults(
  source: string,
  raw: Array<{ title?: unknown; url?: unknown; snippet?: unknown }>,
  maxResults: number,
): WebSearchResult[] {
  const seen = new Set<string>();
  const results: WebSearchResult[] = [];
  for (const item of raw) {
    const url = safeHttpUrl(item.url);
    const title = cleanText(item.title);
    if (!url || !title || seen.has(url)) continue;
    seen.add(url);
    results.push({
      rank: results.length + 1,
      title: title.slice(0, 300),
      url,
      snippet: cleanText(item.snippet).slice(0, 800),
      source,
    });
    if (results.length >= maxResults) break;
  }
  return results;
}

function apiKeyFor(provider: string, configDir: string): string {
  const envKey = API_ENV_KEYS[provider];
  if (!envKey) return "";
  try {
    const vaultValue = createWorkspaceSecretVault(configDir).get(
      `web_search/${provider}/api_key`,
    );
    if (vaultValue?.trim()) return vaultValue.trim();
  } catch {
    // Fall through to the configured environment lookup.
  }
  return resolveConfiguredSecret(envKey, configDir)?.trim() || "";
}

function configuredApiProviders(
  config: WebSearchConfig,
  configDir: string,
  preferred?: string,
): string[] {
  const settings = config.settings || {};
  const configured = new Set(
    (config.providers || [])
      .map((provider) => provider.id?.trim().toLowerCase())
      .filter((id): id is string => Boolean(id) && API_PROVIDERS.has(id)),
  );
  for (const provider of API_PROVIDERS) {
    if (apiKeyFor(provider, configDir)) configured.add(provider);
  }
  const candidates =
    preferred && API_PROVIDERS.has(preferred)
      ? [preferred, ...Array.from(configured)]
      : [
          ...(config.provider && API_PROVIDERS.has(config.provider)
            ? [config.provider]
            : []),
          ...Array.from(configured),
        ];
  return Array.from(new Set(candidates)).filter(
    (provider) =>
      settings[provider]?.enabled !== false && apiKeyFor(provider, configDir),
  );
}

function isSensitiveQuery(query: string): boolean {
  return /\b(api[_ -]?key|access[_ -]?token|password|secret|private[_ -]?key|otp|one[- ]time password|bearer)\b/i.test(
    query,
  );
}

function decodeDuckDuckGoUrl(value: string, endpoint: string): string | null {
  try {
    const parsed = new URL(value, endpoint);
    const redirect = parsed.searchParams.get("uddg");
    return safeHttpUrl(
      redirect ? decodeURIComponent(redirect) : parsed.toString(),
    );
  } catch {
    return null;
  }
}

async function searchDuckDuckGo(
  query: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const endpoint = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, {
    headers: { "user-agent": "Agent-Miki/1.0 (+native-web-search)" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Local web search returned HTTP ${response.status}`);
  const html = await response.text();
  const raw: Array<{ title: string; url: string; snippet: string }> = [];
  const resultPattern =
    /<a[^>]+class=["']result__a["'][^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class=["']result__snippet["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match: RegExpExecArray | null;
  while (raw.length < maxResults && (match = resultPattern.exec(html))) {
    const url = decodeDuckDuckGoUrl(match[1], endpoint);
    if (url)
      raw.push({
        title: cleanText(match[2]),
        url,
        snippet: cleanText(match[3]),
      });
  }
  return dedupeResults("duckduckgo", raw, maxResults);
}

function decodeBingUrl(value: string): string | null {
  const direct = safeHttpUrl(value);
  if (!direct) return null;
  try {
    const parsed = new URL(direct);
    const encoded = parsed.searchParams.get("u") || "";
    if (encoded.startsWith("a1")) {
      const decoded = Buffer.from(encoded.slice(2), "base64").toString("utf8");
      return safeHttpUrl(decoded) || direct;
    }
  } catch {
    // Keep the original URL if the redirect payload is malformed.
  }
  return direct;
}

async function searchBingHtml(
  query: string,
  maxResults: number,
): Promise<WebSearchResult[]> {
  const endpoint = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const response = await fetch(endpoint, {
    headers: { "user-agent": "Agent-Miki/1.0 (+native-web-search)" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`Local Bing fallback returned HTTP ${response.status}`);
  const html = await response.text();
  const raw: Array<{ title: string; url: string; snippet: string }> = [];
  const resultPattern =
    /<li[^>]+class=["'][^"']*b_algo[^"']*["'][\s\S]*?<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>[\s\S]*?<\/li>/gi;
  let match: RegExpExecArray | null;
  while (raw.length < maxResults && (match = resultPattern.exec(html))) {
    const url = decodeBingUrl(cleanText(match[1]));
    if (url)
      raw.push({
        title: cleanText(match[2]),
        url,
        snippet: cleanText(match[3]),
      });
  }
  return dedupeResults("bing-html", raw, maxResults);
}

async function searchSearxng(
  query: string,
  maxResults: number,
  baseUrl: string,
): Promise<WebSearchResult[]> {
  if (!baseUrl.trim())
    throw new Error("Local SearXNG search requires settings.searxng.base_url");
  const endpoint = new URL("/search", baseUrl);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");
  const response = await fetch(endpoint, {
    headers: { accept: "application/json", "user-agent": "Agent-Miki/1.0" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);
  const body = (await response.json()) as { results?: unknown };
  const raw = Array.isArray(body.results)
    ? body.results.filter(isRecord).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content,
      }))
    : [];
  return dedupeResults("searxng", raw, maxResults);
}

async function searchLocal(
  query: string,
  maxResults: number,
  provider: string,
  settings: Record<string, WebSearchProviderSettings>,
): Promise<{ provider: string; results: WebSearchResult[] }> {
  if (provider === "searx" || provider === "searxng") {
    return {
      provider: "searxng",
      results: await searchSearxng(
        query,
        maxResults,
        settings.searxng?.base_url || "",
      ),
    };
  }
  if (LOCAL_PROVIDERS.has(provider)) {
    try {
      const results = await searchDuckDuckGo(query, maxResults);
      if (results.length > 0) return { provider, results };
    } catch {
      // The native path below keeps Local mode usable when DuckDuckGo is unreachable.
    }
    return {
      provider: "bing-html",
      results: await searchBingHtml(query, maxResults),
    };
  }
  return {
    provider: "bing-html",
    results: await searchBingHtml(query, maxResults),
  };
}

async function fetchJson(
  url: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    signal: init.signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(`API web search returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  if (!isRecord(body))
    throw new Error("API web search returned an invalid response");
  return body;
}

function apiResults(
  provider: string,
  body: Record<string, unknown>,
): Array<{ title?: unknown; url?: unknown; snippet?: unknown }> {
  if (provider === "brave") {
    const web =
      isRecord(body.web) && Array.isArray(body.web.results)
        ? body.web.results
        : [];
    return web.filter(isRecord).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.description,
    }));
  }
  if (provider === "tavily") {
    const results = Array.isArray(body.results) ? body.results : [];
    return results.filter(isRecord).map((item) => ({
      title: item.title,
      url: item.url,
      snippet: item.content,
    }));
  }
  if (provider === "serpapi") {
    const results = Array.isArray(body.organic_results)
      ? body.organic_results
      : [];
    return results.filter(isRecord).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
    }));
  }
  if (provider === "serper") {
    const results = Array.isArray(body.organic) ? body.organic : [];
    return results.filter(isRecord).map((item) => ({
      title: item.title,
      url: item.link,
      snippet: item.snippet,
    }));
  }
  const pages =
    isRecord(body.webPages) && Array.isArray(body.webPages.value)
      ? body.webPages.value
      : [];
  return pages.filter(isRecord).map((item) => ({
    title: item.name,
    url: item.url,
    snippet: item.snippet,
  }));
}

async function searchApi(
  provider: string,
  query: string,
  maxResults: number,
  config: WebSearchConfig,
  configDir: string,
): Promise<WebSearchResult[]> {
  if (!API_PROVIDERS.has(provider))
    throw new Error(`Unsupported API web-search provider: ${provider}`);
  const apiKey = apiKeyFor(provider, configDir);
  if (!apiKey)
    throw new Error(
      `No API key configured for web-search provider '${provider}'`,
    );
  const providerSettings = config.settings?.[provider] || {};
  const baseUrl = providerSettings.base_url || DEFAULT_API_BASES[provider];
  if (provider === "tavily") {
    const body = await fetchJson(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: "basic",
      }),
    });
    return dedupeResults(provider, apiResults(provider, body), maxResults);
  }
  if (provider === "serper") {
    const body = await fetchJson(baseUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({ q: query, num: maxResults }),
    });
    return dedupeResults(provider, apiResults(provider, body), maxResults);
  }
  const endpoint = new URL(baseUrl);
  endpoint.searchParams.set("q", query);
  if (provider === "brave")
    endpoint.searchParams.set("count", String(maxResults));
  if (provider === "serpapi") {
    endpoint.searchParams.set("engine", "google");
    endpoint.searchParams.set("num", String(maxResults));
    endpoint.searchParams.set("api_key", apiKey);
  }
  if (provider === "bing")
    endpoint.searchParams.set("count", String(maxResults));
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "Agent-Miki/1.0",
  };
  if (provider === "brave") headers["X-Subscription-Token"] = apiKey;
  if (provider === "bing") headers["Ocp-Apim-Subscription-Key"] = apiKey;
  const body = await fetchJson(endpoint.toString(), { headers });
  return dedupeResults(provider, apiResults(provider, body), maxResults);
}

function output(
  query: string,
  requestedMode: WebSearchExecutionMode,
  mode: "local" | "api",
  provider: string,
  fallbackUsed: boolean,
  results: WebSearchResult[],
): WebSearchResponse {
  return {
    query,
    requested_mode: requestedMode,
    mode,
    provider,
    fallback_used: fallbackUsed,
    results,
    citations: results.map((result) => ({
      id: result.rank,
      title: result.title,
      url: result.url,
    })),
  };
}

export function loadWebSearchConfig(configDir: string): WebSearchConfig {
  try {
    const file = path.join(configDir, "tools.yaml");
    if (!fs.existsSync(file)) return {};
    const parsed: unknown = yaml.load(fs.readFileSync(file, "utf8"));
    if (!isRecord(parsed) || !isRecord(parsed.web_search)) return {};
    return parsed.web_search as WebSearchConfig;
  } catch {
    return {};
  }
}

export async function searchWeb(
  configDir: string,
  config: WebSearchConfig,
  query: string,
  options: { maxResults?: unknown; mode?: unknown; provider?: unknown } = {},
): Promise<WebSearchResponse> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) throw new Error("query parameter is required");
  const requestedMode = normalizeMode(options.mode ?? config.execution_mode);
  const selectedProvider = String(
    options.provider || config.provider || config.current_service || "native",
  )
    .trim()
    .toLowerCase();
  const maxResults = normalizeMaxResults(
    options.maxResults,
    normalizeMaxResults(config.settings?.[selectedProvider]?.max_results),
  );
  const settings = config.settings || {};
  const localProvider =
    LOCAL_PROVIDERS.has(selectedProvider) ||
    selectedProvider === "searx" ||
    selectedProvider === "searxng"
      ? selectedProvider
      : "native";

  if (requestedMode === "local") {
    const local = await searchLocal(
      trimmedQuery,
      maxResults,
      localProvider,
      settings,
    );
    return output(
      trimmedQuery,
      requestedMode,
      "local",
      local.provider,
      false,
      local.results,
    );
  }

  if (requestedMode === "cloud") {
    const [provider] = configuredApiProviders(
      config,
      configDir,
      selectedProvider,
    );
    if (!provider)
      throw new Error(
        "Cloud/API mode requires an enabled provider with a configured API key",
      );
    const results = await searchApi(
      provider,
      trimmedQuery,
      maxResults,
      config,
      configDir,
    );
    return output(trimmedQuery, requestedMode, "api", provider, false, results);
  }

  try {
    const local = await searchLocal(
      trimmedQuery,
      maxResults,
      localProvider,
      settings,
    );
    if (local.results.length > 0 || isSensitiveQuery(trimmedQuery)) {
      return output(
        trimmedQuery,
        requestedMode,
        "local",
        local.provider,
        false,
        local.results,
      );
    }
  } catch {
    if (isSensitiveQuery(trimmedQuery)) {
      throw new Error(
        "Local search failed and cloud fallback is blocked for sensitive queries",
      );
    }
  }

  const [provider] = configuredApiProviders(
    config,
    configDir,
    selectedProvider,
  );
  if (!provider)
    throw new Error(
      "Auto mode found no local results and no enabled API provider is configured",
    );
  const results = await searchApi(
    provider,
    trimmedQuery,
    maxResults,
    config,
    configDir,
  );
  return output(trimmedQuery, requestedMode, "api", provider, true, results);
}
