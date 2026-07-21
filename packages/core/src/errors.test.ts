import {
  AgentError,
  errorToHttpStatus,
  normalizeAgentError,
} from "./errors.js";

describe("agent error taxonomy", () => {
  it("normalizes known agent errors with stable codes and retryability", () => {
    const normalized = normalizeAgentError(
      new AgentError("rate_limit", "Provider returned 429"),
      { requestId: "req-1" },
    );

    expect(normalized).toMatchObject({
      code: "rate_limit",
      message: "Provider returned 429",
      requestId: "req-1",
      retryable: true,
    });
    expect(errorToHttpStatus(normalized.code)).toBe(429);
  });

  it("classifies generic timeout errors as retryable", () => {
    const normalized = normalizeAgentError(new Error("request timed out"));

    expect(normalized.code).toBe("timeout");
    expect(normalized.retryable).toBe(true);
  });
});
