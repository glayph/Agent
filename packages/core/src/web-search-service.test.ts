import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearWebSearchCache,
  searchWeb,
  type WebSearchConfig,
} from "./web-search-service.js";

const originalFetch = globalThis.fetch;
const originalTavilyKey = process.env.TAVILY_API_KEY;
const originalBraveKey = process.env.BRAVE_SEARCH_API_KEY;

function response(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
    text: async () => String(body),
  } as Response;
}

function localHtml(): string {
  return `
    <a class="result__a" href="https://example.com/one">First result</a>
    <a class="result__snippet">First snippet</a>
    <a class="result__a" href="https://example.com/two">Second result</a>
    <a class="result__snippet">Second snippet</a>
  `;
}

afterEach(() => {
  clearWebSearchCache();
  globalThis.fetch = originalFetch;
  if (originalTavilyKey === undefined) delete process.env.TAVILY_API_KEY;
  else process.env.TAVILY_API_KEY = originalTavilyKey;
  if (originalBraveKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalBraveKey;
  vi.restoreAllMocks();
});

describe("dual-mode web search", () => {
  it("runs local native retrieval and returns numbered citations", async () => {
    globalThis.fetch = vi.fn(async () => response(localHtml())) as typeof fetch;
    const config: WebSearchConfig = {
      execution_mode: "local",
      provider: "native",
      settings: { native: { enabled: true, max_results: 2 } },
    };

    const result = await searchWeb(os.tmpdir(), config, "local test", {});

    expect(result.mode).toBe("local");
    expect(result.provider).toBe("native");
    expect(result.results).toHaveLength(2);
    expect(result.results[0]?.url).toBe("https://example.com/one");
    expect(result.citations).toEqual([
      { id: 1, title: "First result", url: "https://example.com/one" },
      { id: 2, title: "Second result", url: "https://example.com/two" },
    ]);
  });

  it("bounds snippets, removes tracking duplicates, and caches normalized queries", async () => {
    const longSnippet = "x".repeat(500);
    const fetchMock = vi.fn(async () =>
      response(`
        <a class="result__a" href="https://example.com/one?utm_source=test">First result</a>
        <a class="result__snippet">${longSnippet}</a>
        <a class="result__a" href="https://example.com/one#section">Duplicate result</a>
        <a class="result__snippet">Duplicate snippet</a>
        <a class="result__a" href="https://example.com/two">Second result</a>
        <a class="result__snippet">Second snippet</a>
      `),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const config: WebSearchConfig = {
      execution_mode: "local",
      provider: "native",
      optimization: {
        cache_enabled: true,
        cache_ttl_ms: 300000,
        snippet_chars: 120,
      },
    };

    const first = await searchWeb(os.tmpdir(), config, "cached test", {});
    const second = await searchWeb(
      os.tmpdir(),
      config,
      "  CACHED   TEST  ",
      {},
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.results).toHaveLength(2);
    expect(first.results[0]?.url).toBe("https://example.com/one");
    expect(first.results[0]?.snippet).toHaveLength(120);
    expect(second.results).toEqual(first.results);
  });

  it("uses an enabled API provider only in explicit cloud mode", async () => {
    process.env.TAVILY_API_KEY = "test-tavily-secret";
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        results: [
          {
            title: "API result",
            url: "https://api.example/result",
            content: "API snippet",
          },
        ],
      }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const config: WebSearchConfig = {
      execution_mode: "cloud",
      provider: "tavily",
      settings: { tavily: { enabled: true, max_results: 4 } },
    };

    const result = await searchWeb(os.tmpdir(), config, "api test", {});

    expect(result.mode).toBe("api");
    expect(result.provider).toBe("tavily");
    expect(result.fallback_used).toBe(false);
    expect(result.results[0]?.title).toBe("API result");
    expect(JSON.stringify(result)).not.toContain("test-tavily-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(String(init.body)).toContain('"query":"api test"');
    expect(String(init.body)).toContain('"api_key":"test-tavily-secret"');
  });

  it("uses API fallback in auto mode only after local retrieval returns no results", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-secret";
    const fetchMock = vi
      .fn()
      .mockImplementation(async (input: RequestInfo | URL) => {
        if (String(input).includes("duckduckgo"))
          return response("no result html");
        return response({
          web: {
            results: [
              {
                title: "Fallback result",
                url: "https://fallback.example/result",
                description: "Fallback snippet",
              },
            ],
          },
        });
      });
    globalThis.fetch = fetchMock as typeof fetch;
    const config: WebSearchConfig = {
      execution_mode: "auto",
      provider: "brave",
      settings: { brave: { enabled: true, max_results: 3 } },
    };

    const result = await searchWeb(os.tmpdir(), config, "fallback test", {});

    expect(result.mode).toBe("api");
    expect(result.provider).toBe("brave");
    expect(result.fallback_used).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("blocks cloud fallback for sensitive queries when local retrieval fails", async () => {
    process.env.BRAVE_SEARCH_API_KEY = "test-brave-secret";
    globalThis.fetch = vi
      .fn()
      .mockRejectedValue(new Error("network unavailable")) as typeof fetch;
    const config: WebSearchConfig = {
      execution_mode: "auto",
      provider: "brave",
      settings: { brave: { enabled: true } },
    };

    await expect(
      searchWeb(os.tmpdir(), config, "what is my api key", {}),
    ).rejects.toThrow("cloud fallback is blocked");
  });

  it("requires credentials for explicit API mode", async () => {
    delete process.env.TAVILY_API_KEY;
    const config: WebSearchConfig = {
      execution_mode: "cloud",
      provider: "tavily",
      settings: { tavily: { enabled: true } },
    };

    await expect(
      searchWeb(os.tmpdir(), config, "missing key", {}),
    ).rejects.toThrow("requires an enabled provider");
  });

  it("decodes Bing tracking URLs when DuckDuckGo is unavailable", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("DuckDuckGo unavailable"))
      .mockResolvedValueOnce(
        response(
          '<li class="b_algo"><h2><a href="https://www.bing.com/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9uZXdz">Direct source</a></h2><p>Direct snippet</p></li>',
        ),
      );
    globalThis.fetch = fetchMock as typeof fetch;

    const result = await searchWeb(
      os.tmpdir(),
      { execution_mode: "local", provider: "native" },
      "fallback parser",
      {},
    );

    expect(result.provider).toBe("bing-html");
    expect(result.results[0]?.url).toBe("https://example.com/news");
  });

  it("loads web-search configuration from the workspace tools file", async () => {
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-web-search-"),
    );
    try {
      fs.writeFileSync(
        path.join(configDir, "tools.yaml"),
        [
          "web_search:",
          "  execution_mode: local",
          "  provider: duckduckgo",
          "  settings:",
          "    duckduckgo:",
          "      enabled: true",
        ].join("\n"),
        "utf8",
      );
      const { loadWebSearchConfig } = await import("./web-search-service.js");
      expect(loadWebSearchConfig(configDir)).toEqual({
        execution_mode: "local",
        provider: "duckduckgo",
        settings: { duckduckgo: { enabled: true } },
      });
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
