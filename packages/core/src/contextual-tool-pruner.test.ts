import { ContextualToolPruner, type Tool } from "./contextual-tool-pruner.js";

describe("ContextualToolPruner", () => {
  it("prefers semantically relevant programming tools over arbitrary unknown tools", () => {
    const pruner = new ContextualToolPruner();
    const tools: Tool[] = [
      { name: "weather_lookup", description: "Fetch weather forecasts" },
      { name: "file_read", description: "Read files from the workspace" },
      { name: "git_diff", description: "Inspect code changes" },
      { name: "browser_screenshot", description: "Capture a screen image" },
      { name: "memory_search", description: "Search memory" },
    ];

    const result = pruner.getPrunedToolset(
      "debug code and inspect files",
      tools,
    );
    const names = result.map((tool) => tool.name);

    expect(names).toContain("file_read");
    expect(names).toContain("git_diff");
    expect(names).toContain("memory_search");
    expect(names).not.toContain("weather_lookup");
  });

  it("uses learned relevance when history is stronger than semantic defaults", () => {
    const pruner = new ContextualToolPruner();
    const tools: Tool[] = [
      { name: "weather_lookup", description: "Fetch weather forecasts" },
      { name: "memory_search", description: "Search memory" },
    ];
    pruner.recordToolUsage("weather_lookup", "programming", true);

    const result = pruner.getPrunedToolset("debug code", tools);
    const names = result.map((tool) => tool.name);

    expect(names).toContain("weather_lookup");
  });
});
