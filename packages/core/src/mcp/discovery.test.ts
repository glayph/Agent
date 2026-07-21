import { DiscoveryUnlocks, searchMcpCatalog } from "./discovery.js";
import type { McpCatalogEntry } from "./types.js";

const catalog: McpCatalogEntry[] = [
  {
    name: "github__list_pull_requests",
    description: "List pull requests in a GitHub repository",
    serverName: "github",
    toolName: "list_pull_requests",
    kind: "external",
    deferred: true,
    definition: {
      type: "function",
      function: {
        name: "github__list_pull_requests",
        description: "List pull requests in a GitHub repository",
        parameters: { type: "object", properties: {} },
      },
    },
  },
  {
    name: "file_read",
    description: "Read a local file",
    kind: "local",
    definition: {
      type: "function",
      function: {
        name: "file_read",
        description: "Read a local file",
        parameters: { type: "object", properties: {} },
      },
    },
  },
];

describe("MCP discovery", () => {
  test("finds deferred external tools and reports server metadata", () => {
    const result = searchMcpCatalog("pull requests", catalog, {
      enabled: true,
      ttl: 2,
      maxSearchResults: 5,
      useBM25: true,
      useRegex: false,
    });

    expect(result.matches[0]).toMatchObject({
      name: "github__list_pull_requests",
      serverName: "github",
      deferred: true,
    });
  });

  test("tracks unlock TTL ticks", () => {
    const unlocks = new DiscoveryUnlocks(2);
    unlocks.unlock(["github__list_pull_requests"]);

    expect(unlocks.isUnlocked("github__list_pull_requests")).toBe(true);
    unlocks.tick();
    expect(unlocks.isUnlocked("github__list_pull_requests")).toBe(true);
    unlocks.tick();
    expect(unlocks.isUnlocked("github__list_pull_requests")).toBe(false);
  });

  test("caps discovery results and returns deterministic ordering", () => {
    const wideCatalog = Array.from({ length: 60 }, (_, index) => {
      const name = `tool_${String(index).padStart(2, "0")}`;
      return {
        name,
        description: "Search repository data",
        kind: "local" as const,
        definition: {
          type: "function" as const,
          function: {
            name,
            description: "Search repository data",
            parameters: { type: "object", properties: {} },
          },
        },
      };
    }).reverse();

    const result = searchMcpCatalog("repository", wideCatalog, {
      enabled: true,
      ttl: 2,
      maxSearchResults: 1000,
      useBM25: true,
      useRegex: false,
    });

    expect(result.matches).toHaveLength(50);
    expect(result.matches[0].name).toBe("tool_00");
  });

  test("normalizes long discovery queries", () => {
    const result = searchMcpCatalog(
      `pull requests ${"x".repeat(800)}`,
      catalog,
      {
        enabled: true,
        ttl: 2,
        maxSearchResults: 5,
        useBM25: true,
        useRegex: true,
      },
    );

    expect(result.query.length).toBeLessThanOrEqual(512);
    expect(result.matches[0].name).toBe("github__list_pull_requests");
  });
});
