import {
  CloudSearchProvider,
  LocalFirstSearchRouter,
  LocalSearchProvider,
  type FetchLike,
} from "./local-first-search.js";

function mockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): FetchLike {
  return handler as FetchLike;
}

describe("LocalFirstSearchRouter", () => {
  it("defaults to local mode and returns provenance-rich results", async () => {
    const local = new LocalSearchProvider(
      mockFetch(
        () =>
          new Response(
            '<a class="result__a" href="https://example.com/article">Example result</a><a class="result__snippet">Useful detail</a>',
            { status: 200, headers: { "content-type": "text/html" } },
          ),
      ),
    );
    const router = new LocalFirstSearchRouter(local, null);
    const result = await router.search({ query: "example" });
    expect(result.mode).toBe("local");
    expect(result.executionMode).toBe("local");
    expect(result.results[0]?.url).toBe("https://example.com/article");
    expect(result.results[0]?.citation).toContain("example.com");
    expect(result.results[0]?.contentHash).toHaveLength(64);
  });

  it("falls back once from auto local failure to configured cloud provider", async () => {
    const local = new LocalSearchProvider(
      mockFetch(() => {
        throw new Error("local network unavailable");
      }),
    );
    const cloud = new CloudSearchProvider(
      "https://cloud.example/search",
      "test-token",
      mockFetch((_input, init) => {
        expect(init?.headers).toMatchObject({
          authorization: "Bearer test-token",
        });
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Cloud result",
                url: "https://cloud.example/r",
                snippet: "remote",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const router = new LocalFirstSearchRouter(local, cloud, "auto");
    const result = await router.search({ query: "fallback" });
    expect(result.executionMode).toBe("cloud");
    expect(result.fallbackReason).toContain("local network unavailable");
    expect(result.results[0]?.source).toBe("cloud");
  });

  it("blocks sensitive queries from cloud unless explicitly allowed", async () => {
    const cloud = new CloudSearchProvider(
      "https://cloud.example/search",
      undefined,
      mockFetch(
        () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
      ),
    );
    const router = new LocalFirstSearchRouter(undefined, cloud, "cloud");
    await expect(router.search({ query: "find my API key" })).rejects.toThrow(
      "Cloud search is blocked for sensitive queries",
    );
  });

  it("never silently uses cloud in local mode", async () => {
    const local = new LocalSearchProvider(
      mockFetch(() => new Response("blocked", { status: 403 })),
    );
    const cloud = new CloudSearchProvider(
      "https://cloud.example/search",
      undefined,
      mockFetch(
        () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
      ),
    );
    const router = new LocalFirstSearchRouter(local, cloud, "local");
    await expect(router.search({ query: "public query" })).rejects.toThrow(
      "HTTP 403",
    );
  });
});
