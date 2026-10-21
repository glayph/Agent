import { describe, expect, it } from "vitest";
import { modelRetryDelayMs, retryModelCall, sleepUnlessAborted } from "./model-retry.js";

const CYCLE = [1000, 2000, 4000, 8000, 16000];

describe("model retry delays", () => {
  it("waits 1s, 2s, 4s, 8s, 16s and then starts the cycle again at 1s", () => {
    const delays = Array.from({ length: 12 }, (_, index) => modelRetryDelayMs(index));
    expect(delays).toEqual([...CYCLE, ...CYCLE, 1000, 2000]);
  });

  it("treats an invalid index as the first retry", () => {
    expect(modelRetryDelayMs(-3)).toBe(1000);
    expect(modelRetryDelayMs(Number.NaN)).toBe(1000);
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
      signal: new AbortController().signal,
      sleep: async (ms) => { waits.push(ms) },
    });
    expect(outcome).toEqual({ result: "fail", stopped: false });
    expect(calls).toBe(6);
    expect(waits).toEqual(CYCLE);
  });

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
      onRetry: ({ retry, delayMs }) => events.push(`retry${retry}:${delayMs}`),
      onResumed: () => events.push("resumed"),
      signal: new AbortController().signal,
      sleep: async () => {},
    });
    expect(events).toEqual(["attempt1", "retry1:1000", "resumed", "attempt2", "retry2:2000", "resumed", "attempt3"]);
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
