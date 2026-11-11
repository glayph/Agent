import { classifyTaskError, TaskExecutionError } from "./task-errors.js";

describe("typed task error classification", () => {
  it("uses explicit task categories rather than error message matching", () => {
    expect(classifyTaskError(new TaskExecutionError("temporary", { category: "transient" }))).toMatchObject({ category: "transient" });
    expect(classifyTaskError(new TaskExecutionError("side effect uncertain", { category: "uncertain_side_effect" }))).toMatchObject({ category: "uncertain_side_effect" });
    expect(classifyTaskError(new Error("permanent validation failure"))).toMatchObject({ category: "unknown" });
  });

  it("honors Retry-After for transient server errors and recognizes request timeouts", () => {
    expect(classifyTaskError(Object.assign(new Error("upstream unavailable"), {
      status: 503, headers: { "Retry-After": "2" },
    }))).toMatchObject({ category: "transient", retryAfterMs: 2_000 });
    expect(classifyTaskError(Object.assign(new Error("request timeout"), { status: 408 })).category).toBe("transient");
  });

  it("recognizes stable transport, HTTP, stale-state and resource codes", () => {
    expect(classifyTaskError(Object.assign(new Error("network"), { code: "ECONNRESET" })).category).toBe("transient");
    expect(classifyTaskError(Object.assign(new Error("rate limited"), { status: 429, retryAfterMs: 1_500 }))).toMatchObject({ category: "rate_limit", retryAfterMs: 1_500 });
    expect(classifyTaskError(Object.assign(new Error("stale"), { code: "ERR_STALE_STATE" })).category).toBe("stale_state");
    expect(classifyTaskError(Object.assign(new Error("disk full"), { code: "ENOSPC" })).category).toBe("resource_exhaustion");
    expect(classifyTaskError(Object.assign(new Error("unauthorized"), { status: 401 })).category).toBe("auth_config");
  });
});
