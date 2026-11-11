import { DEFAULT_CHAT_INACTIVITY_TIMEOUT_MS, DEFAULT_CHAT_QUEUE_WAIT_MS, DEFAULT_UNKNOWN_MODEL_CONTEXT_ESTIMATE_TOKENS, DEFAULT_MAX_TOOL_ITERATIONS, DEFAULT_MAX_WALL_TIME_MS, DEFAULT_TOOL_TIMEOUT_MS, resolveBackgroundTaskInactivityTimeoutMs, resolveChatInactivityTimeoutMs, resolveChatQueueWaitMs, resolveContextWindowTokens, resolveMaxToolIterations, resolveMaxWallTimeMs, resolveToolFeedbackMaxArgsLength, resolveToolTimeoutMs } from "./runtime-settings.js";

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

  it("ignores legacy iteration caps in config and environment", () => {
    expect(resolveMaxToolIterations({ max_tool_iterations: 7 }, {})).toBe(Number.POSITIVE_INFINITY);
    expect(resolveMaxToolIterations({}, { MIKI_AGENT_MAX_TURNS: "9" })).toBe(Number.POSITIVE_INFINITY);
    expect(resolveMaxToolIterations({}, {})).toBe(DEFAULT_MAX_TOOL_ITERATIONS);
  });

  it("uses an explicit context window, then the model's real window, and only then the conservative unknown-model context estimate", () => {
    const lookup = (model: string) => (model === "big-model" ? 1_000_000 : undefined);
    expect(resolveContextWindowTokens({ context_window: 131072, max_tokens: 100 }, "big-model", lookup)).toBe(131072);
    // context_window: 0 means "not set": use the model's real window, not 4 x max_completion_tokens.
    expect(resolveContextWindowTokens({ context_window: 0, max_completion_tokens: 16384 }, "big-model", lookup)).toBe(1_000_000);
    // Unknown model or no model: context-size estimate, not a model output-token cap.
    expect(resolveContextWindowTokens({ context_window: 0, max_tokens: 8192 }, "other", lookup)).toBe(32768);
    expect(resolveContextWindowTokens({ context_window: 0, max_tokens: 8192 })).toBe(32768);
    // Optional cap bounds unusually large provider windows without overriding an explicit window.
    expect(resolveContextWindowTokens({ context_window: 0, context_window_cap: 65536 }, "big-model", lookup)).toBe(65536);
    expect(resolveContextWindowTokens({ context_window: 0, context_window_cap: 65536 }, "small-model", () => 32000)).toBe(32000);
    expect(resolveContextWindowTokens({ context_window: 131072, context_window_cap: 65536 }, "big-model", lookup)).toBe(131072);
    expect(resolveContextWindowTokens({})).toBe(DEFAULT_UNKNOWN_MODEL_CONTEXT_ESTIMATE_TOKENS * 4);
  });

  it("uses the built-in model limits by default", () => {
    expect(resolveContextWindowTokens({ context_window: 0, max_completion_tokens: 16384 }, "gemini-3.5-flash-lite")).toBe(1_000_000);
    expect(resolveContextWindowTokens({ context_window: 0, context_window_cap: 65536 }, "gemini-3.5-flash-lite")).toBe(65536);
    expect(resolveContextWindowTokens({ context_window: 0, max_completion_tokens: 16384 }, "some-unknown-model")).toBe(128_000);
  });

  it("disables default wall-time limits and ignores legacy environment overrides", () => {
    expect(resolveMaxWallTimeMs({ max_wall_time_ms: 1500 }, {})).toBe(0);
    expect(resolveMaxWallTimeMs({ max_wall_time_ms: 0 }, {})).toBe(0);
    expect(resolveMaxWallTimeMs({}, { MIKI_AGENT_MAX_WALL_TIME_MS: "2500" })).toBe(0);
    expect(resolveMaxWallTimeMs({}, {})).toBe(DEFAULT_MAX_WALL_TIME_MS);
    expect(resolveMaxWallTimeMs({ max_wall_time_ms: -1 }, {})).toBe(DEFAULT_MAX_WALL_TIME_MS);
  });
  it("keeps foreground and background task lifetimes unlimited, ignoring legacy inactivity settings", () => {
    expect(resolveBackgroundTaskInactivityTimeoutMs({ background_task_inactivity_timeout_ms: 60_000, inactivity_timeout_ms: 90_000 }, {})).toBe(0);
    expect(resolveBackgroundTaskInactivityTimeoutMs({ inactivity_timeout_ms: 90_000 }, { MIKI_BACKGROUND_TASK_INACTIVITY_TIMEOUT_MS: "120000" })).toBe(0);
    expect(resolveBackgroundTaskInactivityTimeoutMs({}, {})).toBe(0);
    expect(resolveChatInactivityTimeoutMs({ inactivity_timeout_ms: 60_000 }, {})).toBe(0);
    expect(resolveChatInactivityTimeoutMs({}, { MIKI_CHAT_INACTIVITY_TIMEOUT_MS: "90_000" })).toBe(0);
    expect(resolveChatInactivityTimeoutMs({}, {})).toBe(DEFAULT_CHAT_INACTIVITY_TIMEOUT_MS);
  });

});


describe("runtime execution limits", () => {
  it("uses tool-specific timeouts and has no generic timeout fallback", () => {
    expect(resolveToolTimeoutMs({ tool_timeout_ms: 2500 }, {})).toBe(0)
    expect(resolveToolTimeoutMs({}, { MIKI_AGENT_TOOL_TIMEOUT_MS: "3500" })).toBe(0)
    expect(resolveToolTimeoutMs({}, {})).toBe(DEFAULT_TOOL_TIMEOUT_MS)
    expect(resolveToolTimeoutMs({ tool_timeout_ms: 0 }, {})).toBe(0)
  })

  it("waits indefinitely for a serialized conversation lane and ignores legacy wait caps", () => {
    expect(resolveChatQueueWaitMs({ chat_queue_wait_ms: 8000 }, 1000, {})).toBe(0)
    expect(resolveChatQueueWaitMs({}, 21600000, {})).toBe(0)
    expect(resolveChatQueueWaitMs({}, 0, {})).toBe(DEFAULT_CHAT_QUEUE_WAIT_MS)
    expect(resolveChatQueueWaitMs({}, 1000, { MIKI_CHAT_QUEUE_WAIT_MS: "9000" })).toBe(0)
  })

  it("never enables a task inactivity deadline through current or legacy settings", () => {
    expect(resolveChatInactivityTimeoutMs({ inactivity_timeout_ms: 60_000 }, {})).toBe(0)
    expect(resolveChatInactivityTimeoutMs({}, { MIKI_CHAT_INACTIVITY_TIMEOUT_MS: "90_000" })).toBe(0)
    expect(resolveChatInactivityTimeoutMs({}, {})).toBe(0)
    expect(resolveChatInactivityTimeoutMs({ inactivity_timeout_ms: 0 }, {})).toBe(0)
  })
})
