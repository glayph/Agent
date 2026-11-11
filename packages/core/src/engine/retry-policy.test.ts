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

import { NEVER_STOP_RETRY_DELAY_MS, neverStopRetryOptions } from "./retry-policy.js";

describe("neverStopRetryOptions", () => {
  it("retries forever at one fixed 3 second delay with no jitter", () => {
    const options = neverStopRetryOptions();
    expect(NEVER_STOP_RETRY_DELAY_MS).toBe(3_000);
    expect(options).toMatchObject({ maxRetries: 0, jitter: false, retryPermanentFailures: true });
    const delays = new Set(Array.from({ length: 500 }, (_, index) => calculateTransientRetryDelayMs(index + 1, options)));
    expect([...delays]).toEqual([3_000]);
  });

  it("accepts an explicit delay and never goes below a safe floor", () => {
    expect(neverStopRetryOptions(7_000).continueRetryingEveryMs).toBe(7_000);
    expect(neverStopRetryOptions(1).continueRetryingEveryMs).toBe(250);
  });
});
