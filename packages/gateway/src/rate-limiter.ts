/**
 * rate-limiter.ts — Sliding window rate limiter for gateway incoming requests/messages.
 */

export interface RateLimiterOptions {
  /** Time window in milliseconds. Default: 60,000ms (1 minute). */
  windowMs?: number;
  /** Max allowed requests per key within windowMs. Default: 30. */
  maxRequests?: number;
}

export class SlidingWindowRateLimiter {
  private readonly windowMs: number;
  private readonly maxRequests: number;
  private readonly hits = new Map<string, number[]>();

  constructor(options: RateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 30;
  }

  /**
   * Check if a request for `key` should be allowed.
   * If allowed, records the timestamp and returns true.
   * If limit exceeded, returns false.
   */
  isAllowed(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.hits.get(key) || [];
    // Filter out old timestamps outside the window
    timestamps = timestamps.filter((t) => t > cutoff);

    if (timestamps.length >= this.maxRequests) {
      this.hits.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.hits.set(key, timestamps);
    return true;
  }

  /**
   * Remove stale entries from memory.
   */
  cleanup(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [key, timestamps] of this.hits.entries()) {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) {
        this.hits.delete(key);
      } else {
        this.hits.set(key, valid);
      }
    }
  }
}
