import { describe, expect, it } from "vitest";
import { isRetryableProviderError, ModelCircuitBreaker, modelRetryDelayMs, retryModelCall, sleepUnlessAborted } from "./model-retry.js";

describe("model retry delays", () => {
  it("uses a fixed three-second delay for every retry index", () => {
    const delays = Array.from({ length: 12 }, (_, index) => modelRetryDelayMs(index));
    expect(delays).toEqual(Array.from({ length: 12 }, () => 3_000));
  });

  it("treats an invalid index as the same fixed retry delay", () => {
    expect(modelRetryDelayMs(-3)).toBe(3_000);
    expect(modelRetryDelayMs(Number.NaN)).toBe(3_000);
  });

  it("treats HTTP 503 as transient even when its diagnostic text contains billing", async () => {
    const circuit = new ModelCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5_000 });
    await expect(circuit.execute(async () => { throw Object.assign(new Error("billing diagnostics endpoint temporarily unavailable"), { status: 503 }); })).rejects.toThrow(/billing diagnostics/);
    expect(circuit.snapshot().open).toBe(true);
  });


  it("does not classify natural-language error prose as a retry instruction", () => {
    expect(isRetryableProviderError(new Error("temporarily unavailable; retry later"))).toBe(false);
    expect(isRetryableProviderError(Object.assign(new Error("network failure"), { cause: Object.assign(new Error("socket"), { code: "ECONNRESET" }) }))).toBe(true);
  });

  it("does not retry or open the circuit for a structured entitlement block on HTTP 429", async () => {
    const circuit = new ModelCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 5_000 });
    const entitlement = Object.assign(new Error("Provider requires an active payment method."), {
      name: "ProviderRequestError", category: "provider_entitlement", status: 429, retryable: false,
    });
    await expect(circuit.execute(async () => { throw entitlement; })).rejects.toThrow(/payment method/);
    expect(circuit.snapshot()).toMatchObject({ failures: 0, open: false });
  });
});

describe("retryModelCall", () => {
  it("returns the first success without waiting", async () => {
    const waits: number[] = [];
    const outcome = await retryModelCall({
      attempt: async () => "ok",
      shouldRetry: () => false,
      signal: new AbortController().signal,
      sleep: async (ms) => { waits.push(ms) },
    });
    expect(outcome).toEqual({ result: "ok", stopped: false });
    expect(waits).toEqual([]);
  });

  it("stops after the configured retry budget", async () => {
    let calls = 0;
    const waits: number[] = [];
    const outcome = await retryModelCall({
      attempt: async () => { calls += 1; return "fail" },
      shouldRetry: (result) => result === "fail",
      maxRetries: 5,
      delayMs: () => 0,
      signal: new AbortController().signal,
      sleep: async (ms) => { waits.push(ms) },
    });
    expect(outcome).toEqual({ result: "fail", stopped: false });
    expect(calls).toBe(6);
    expect(waits).toEqual([0, 0, 0, 0, 0]);
  });

  it("continues past the old five-retry default until the provider recovers", async () => {
    let calls = 0
    const waits: number[] = []
    const outcome = await retryModelCall({
      attempt: async () => { calls += 1; return calls < 8 ? "fail" : "ok" },
      shouldRetry: (result) => result === "fail",
      signal: new AbortController().signal,
      delayMs: () => 0,
      sleep: async (ms) => { waits.push(ms) },
    })
    expect(outcome).toEqual({ result: "ok", stopped: false })
    expect(calls).toBe(8)
    expect(waits).toHaveLength(7)
  })

  it("supports disabling retries explicitly", async () => {
    let calls = 0;
    const outcome = await retryModelCall({
      attempt: async () => { calls += 1; return "fail" },
      shouldRetry: () => true,
      maxRetries: 0,
      signal: new AbortController().signal,
      sleep: async () => {},
    });
    expect(calls).toBe(1);
    expect(outcome).toEqual({ result: "fail", stopped: false });
  });

  it("does not retry a failure that retrying cannot fix", async () => {
    let calls = 0;
    const outcome = await retryModelCall({
      attempt: async () => { calls += 1; return "invalid api key" },
      shouldRetry: () => false,
      signal: new AbortController().signal,
      sleep: async () => {},
    });
    expect(calls).toBe(1);
    expect(outcome).toEqual({ result: "invalid api key", stopped: false });
  });

  it("reports each retry with its number and delay, and resumes after each wait", async () => {
    const events: string[] = [];
    let calls = 0;
    await retryModelCall({
      attempt: async () => { calls += 1; events.push(`attempt${calls}`); return calls < 3 ? "fail" : "ok" },
      shouldRetry: (result) => result === "fail",
      delayMs: () => 100,
      onRetry: ({ retry, delayMs }) => events.push(`retry${retry}:${delayMs}`),
      onResumed: () => events.push("resumed"),
      signal: new AbortController().signal,
      sleep: async () => {},
    });
    expect(events).toEqual(["attempt1", "retry1:100", "resumed", "attempt2", "retry2:100", "resumed", "attempt3"]);
  });

  it("uses Retry-After as a minimum without adding jitter", async () => {
    const waits: number[] = [];
    let calls = 0;
    await retryModelCall({
      attempt: async () => { calls += 1; return calls === 1 ? Object.assign(new Error("rate limited"), { retryAfterMs: 5_000 }) : "ok"; },
      shouldRetry: (result) => typeof result === "object",
      signal: new AbortController().signal,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual([5_000]);
  });

  it("honors HTTP-date Retry-After headers", async () => {
    const waits: number[] = [];
    let calls = 0;
    const now = Date.now();
    await retryModelCall({
      attempt: async () => { calls += 1; return calls === 1 ? Object.assign(new Error("busy"), { headers: { "Retry-After": new Date(now + 4_000).toUTCString() } }) : "ok"; },
      shouldRetry: (result) => typeof result === "object",
      signal: new AbortController().signal,
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(waits[0]).toBeGreaterThanOrEqual(3_000);
    expect(waits[0]).toBeLessThanOrEqual(4_000);
  });

  it("stops at once when the turn is stopped during a wait", async () => {
    const controller = new AbortController();
    let calls = 0;
    const outcome = await retryModelCall({
      attempt: async () => { calls += 1; return "fail" },
      shouldRetry: (result) => result === "fail",
      signal: controller.signal,
      sleep: async () => { controller.abort() },
    });
    expect(calls).toBe(1);
    expect(outcome).toEqual({ result: "fail", stopped: true });
  });

  it("does not start another attempt when stopped during the attempt that failed", async () => {
    const controller = new AbortController();
    let calls = 0;
    const outcome = await retryModelCall({
      attempt: async () => { calls += 1; controller.abort(); return "fail" },
      shouldRetry: (result) => result === "fail",
      signal: controller.signal,
      sleep: async () => { throw new Error("must not wait after a stop") },
    });
    expect(calls).toBe(1);
    expect(outcome).toEqual({ result: "fail", stopped: true });
  });

  it("uses the delay function it is given", async () => {
    const waits: number[] = [];
    let calls = 0;
    await retryModelCall({
      attempt: async () => { calls += 1; return calls < 3 ? "fail" : "ok" },
      shouldRetry: (result) => result === "fail",
      signal: new AbortController().signal,
      delayMs: () => 0,
      sleep: async (ms) => { waits.push(ms) },
    });
    expect(waits).toEqual([0, 0]);
  });
});

describe("sleepUnlessAborted", () => {
  it("resolves after the delay when nothing aborts it", async () => {
    const started = Date.now();
    await sleepUnlessAborted(20, new AbortController().signal);
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  it("resolves at once when aborted during the wait", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = sleepUnlessAborted(10_000, controller.signal);
    controller.abort();
    await pending;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("resolves at once when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const started = Date.now();
    await sleepUnlessAborted(10_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});


describe("ModelCircuitBreaker", () => {
  it("marks a repeatedly failing route as degraded without blocking a fresh attempt", async () => {
    let now = 1_000
    let calls = 0
    const breaker = new ModelCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 5_000, now: () => now })
    const fail = async () => { calls += 1; throw Object.assign(new Error("provider unavailable"), { status: 503 }) }
    await expect(breaker.execute(fail)).rejects.toMatchObject({ status: 503 })
    await expect(breaker.execute(fail)).rejects.toMatchObject({ status: 503 })
    expect(breaker.snapshot()).toMatchObject({ failures: 2, open: true, retryAfterMs: 5_000 })
    await expect(breaker.execute(async () => { calls += 1; return "recovered" })).resolves.toBe("recovered")
    expect(calls).toBe(3)
    expect(breaker.snapshot()).toMatchObject({ failures: 0, open: false, retryAfterMs: 0 })
  })

  it("allows concurrent recovery attempts while the route is marked degraded", async () => {
    let now = 0
    const breaker = new ModelCircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: () => now })
    await expect(breaker.execute(async () => { throw Object.assign(new Error("down"), { status: 503 }) })).rejects.toThrow("down")
    now = 10
    const results = await Promise.all([
      breaker.execute(async () => "first"),
      breaker.execute(async () => "parallel"),
    ])
    expect(results).toEqual(["first", "parallel"])
    expect(breaker.snapshot()).toMatchObject({ failures: 0, open: false, retryAfterMs: 0 })
  })

  it("does not mark permanent authentication errors as transient failures", async () => {
    const breaker = new ModelCircuitBreaker({ failureThreshold: 1 })
    await expect(breaker.execute(async () => { throw Object.assign(new Error("Invalid API key"), { status: 401 }) })).rejects.toMatchObject({ status: 401 })
    expect(breaker.snapshot()).toMatchObject({ failures: 0, open: false })
  })
})
