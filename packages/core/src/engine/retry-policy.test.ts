import { calculateTransientRetryDelayMs, TRANSIENT_RETRY_MAX_DELAY_MS, TRANSIENT_RETRY_MIN_DELAY_MS } from "./retry-policy.js";

describe("transient retry policy", () => {
  it("uses 3s, 6s, 10s exponential delays, then a fixed 5s continuation cadence", () => {
    const policy = { baseDelayMs: 3_000, maxDelayMs: 10_000, maxRetries: 3, continueRetryingEveryMs: 5_000, jitter: false };
    expect([1, 2, 3, 4, 5, 6].map((retry) => calculateTransientRetryDelayMs(retry, policy)))
      .toEqual([3_000, 6_000, 10_000, 5_000, 5_000, 5_000]);
  });

  it("never exceeds the configured cap after applying jitter", () => {
    expect(calculateTransientRetryDelayMs(9, { baseDelayMs: 3_000, maxDelayMs: 10_000 }, () => 1)).toBe(10_000);
  });

  it("caps the fixed continuation cadence at the configured maximum", () => {
    expect(calculateTransientRetryDelayMs(4, {
      baseDelayMs: 3_000, maxDelayMs: 10_000, maxRetries: 3, continueRetryingEveryMs: 20_000, jitter: false,
    })).toBe(10_000);
  });

  it("uses safe defaults for invalid timing values", () => {
    expect(calculateTransientRetryDelayMs(1, { baseDelayMs: Number.NaN, maxDelayMs: Number.POSITIVE_INFINITY }, () => 0))
      .toBe(Math.floor(TRANSIENT_RETRY_MIN_DELAY_MS * 0.8));
    expect(TRANSIENT_RETRY_MAX_DELAY_MS).toBe(12_000);
  });
});
