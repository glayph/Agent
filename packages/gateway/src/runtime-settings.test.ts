import { DEFAULT_MAX_COMPLETION_TOKENS, DEFAULT_MAX_TOOL_ITERATIONS, DEFAULT_MAX_WALL_TIME_MS, resolveContextWindowTokens, resolveMaxToolIterations, resolveMaxWallTimeMs } from "./runtime-settings.js";

describe("runtime settings defaults", () => {
  it("uses the configured max tool iterations and falls back to the Settings default", () => {
    expect(resolveMaxToolIterations({ max_tool_iterations: 7 }, {})).toBe(7);
    expect(resolveMaxToolIterations({}, { MIKI_AGENT_MAX_TURNS: "9" })).toBe(9);
    expect(resolveMaxToolIterations({}, {})).toBe(DEFAULT_MAX_TOOL_ITERATIONS);
  });

  it("uses an explicit context window and otherwise applies the 4x max-token rule", () => {
    expect(resolveContextWindowTokens({ context_window: 131072, max_tokens: 100 })).toBe(131072);
    expect(resolveContextWindowTokens({ context_window: 0, max_tokens: 8192 })).toBe(32768);
    expect(resolveContextWindowTokens({})).toBe(DEFAULT_MAX_COMPLETION_TOKENS * 4);
  });

  it("resolves an optional non-negative wall-time budget from settings or environment", () => {
    expect(resolveMaxWallTimeMs({ max_wall_time_ms: 1500 }, {})).toBe(1500);
    expect(resolveMaxWallTimeMs({}, { MIKI_AGENT_MAX_WALL_TIME_MS: "2500" })).toBe(2500);
    expect(resolveMaxWallTimeMs({}, {})).toBe(DEFAULT_MAX_WALL_TIME_MS);
    expect(resolveMaxWallTimeMs({ max_wall_time_ms: -1 }, {})).toBe(DEFAULT_MAX_WALL_TIME_MS);
  });
});
