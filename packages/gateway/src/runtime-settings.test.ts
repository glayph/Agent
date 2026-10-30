import { DEFAULT_MAX_COMPLETION_TOKENS, DEFAULT_MAX_TOOL_ITERATIONS, DEFAULT_MAX_WALL_TIME_MS, resolveContextWindowTokens, resolveMaxToolIterations, resolveMaxWallTimeMs, resolveToolFeedbackMaxArgsLength } from "./runtime-settings.js";

describe("runtime settings defaults", () => {
  it("preserves zero as unlimited tool feedback argument preview length", () => {
    expect(resolveToolFeedbackMaxArgsLength(0)).toBe(0)
    expect(resolveToolFeedbackMaxArgsLength("0")).toBe(0)
    expect(resolveToolFeedbackMaxArgsLength(120)).toBe(120)
    expect(resolveToolFeedbackMaxArgsLength(-1)).toBe(300)
    expect(resolveToolFeedbackMaxArgsLength("bad")).toBe(300)
    expect(resolveToolFeedbackMaxArgsLength(null)).toBe(300)
    expect(resolveToolFeedbackMaxArgsLength(" ")).toBe(300)
  })

  it("uses the configured max tool iterations and falls back to the Settings default", () => {
    expect(resolveMaxToolIterations({ max_tool_iterations: 7 }, {})).toBe(7);
    expect(resolveMaxToolIterations({}, { MIKI_AGENT_MAX_TURNS: "9" })).toBe(9);
    expect(resolveMaxToolIterations({}, {})).toBe(DEFAULT_MAX_TOOL_ITERATIONS);
  });

  it("uses an explicit context window, then the model's real window, and only then the 4x max-token estimate", () => {
    const lookup = (model: string) => (model === "big-model" ? 1_000_000 : undefined);
    expect(resolveContextWindowTokens({ context_window: 131072, max_tokens: 100 }, "big-model", lookup)).toBe(131072);
    // context_window: 0 means "not set": use the model's real window, not 4 x max_completion_tokens.
    expect(resolveContextWindowTokens({ context_window: 0, max_completion_tokens: 16384 }, "big-model", lookup)).toBe(1_000_000);
    // Unknown model or no model: legacy estimate.
    expect(resolveContextWindowTokens({ context_window: 0, max_tokens: 8192 }, "other", lookup)).toBe(32768);
    expect(resolveContextWindowTokens({ context_window: 0, max_tokens: 8192 })).toBe(32768);
    // Optional cap bounds unusually large provider windows without overriding an explicit window.
    expect(resolveContextWindowTokens({ context_window: 0, context_window_cap: 65536 }, "big-model", lookup)).toBe(65536);
    expect(resolveContextWindowTokens({ context_window: 0, context_window_cap: 65536 }, "small-model", () => 32000)).toBe(32000);
    expect(resolveContextWindowTokens({ context_window: 131072, context_window_cap: 65536 }, "big-model", lookup)).toBe(131072);
    expect(resolveContextWindowTokens({})).toBe(DEFAULT_MAX_COMPLETION_TOKENS * 4);
  });

  it("uses the built-in model limits by default", () => {
    expect(resolveContextWindowTokens({ context_window: 0, max_completion_tokens: 16384 }, "gemini-3.5-flash-lite")).toBe(1_000_000);
    expect(resolveContextWindowTokens({ context_window: 0, context_window_cap: 65536 }, "gemini-3.5-flash-lite")).toBe(65536);
    expect(resolveContextWindowTokens({ context_window: 0, max_completion_tokens: 16384 }, "some-unknown-model")).toBe(128_000);
  });

  it("resolves an optional non-negative wall-time budget from settings or environment", () => {
    expect(resolveMaxWallTimeMs({ max_wall_time_ms: 1500 }, {})).toBe(1500);
    expect(resolveMaxWallTimeMs({}, { MIKI_AGENT_MAX_WALL_TIME_MS: "2500" })).toBe(2500);
    expect(resolveMaxWallTimeMs({}, {})).toBe(DEFAULT_MAX_WALL_TIME_MS);
    expect(resolveMaxWallTimeMs({ max_wall_time_ms: -1 }, {})).toBe(DEFAULT_MAX_WALL_TIME_MS);
  });
});
