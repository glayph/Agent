import { DEFAULT_MAX_COMPLETION_TOKENS, DEFAULT_MAX_TOOL_ITERATIONS, resolveContextWindowTokens, resolveMaxToolIterations } from "./runtime-settings.js";

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
});
