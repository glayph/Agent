/**
 * RequestDeduplicator: Detect and coalesce identical concurrent requests
 * - Hash incoming requests
 * - Reuse results if request already in-flight
 * - Reduce duplicate work
 */

import * as crypto from "crypto";

export interface RequestDeduplicationStats {
  totalRequests: number;
  deduplicatedRequests: number;
  savedExecutions: number;
}

export class RequestDeduplicator {
  private inFlight: Map<string, Promise<unknown>> = new Map();
  private stats: RequestDeduplicationStats = {
    totalRequests: 0,
    deduplicatedRequests: 0,
    savedExecutions: 0,
  };

  /**
   * Hash a request for deduplication
   */
  private hashRequest(request: unknown): string {
    const json = stableStringify(request);
    return crypto.createHash("sha256").update(json).digest("hex");
  }

  /**
   * Execute request with deduplication
   */
  async execute<T>(request: unknown, handler: () => Promise<T>): Promise<T> {
    const hash = this.hashRequest(request);
    this.stats.totalRequests++;

    // Check if already in-flight
    if (this.inFlight.has(hash)) {
      this.stats.deduplicatedRequests++;
      this.stats.savedExecutions++;
      return this.inFlight.get(hash) as Promise<T>;
    }

    // Start execution
    const promise = handler().finally(() => {
      // Remove from in-flight when done
      this.inFlight.delete(hash);
    });

    // Store promise
    this.inFlight.set(hash, promise);

    return promise;
  }

  /**
   * Get deduplication statistics
   */
  getStats(): RequestDeduplicationStats & { deduplicationRate: number } {
    const rate =
      this.stats.totalRequests > 0
        ? this.stats.deduplicatedRequests / this.stats.totalRequests
        : 0;

    return {
      ...this.stats,
      deduplicationRate: rate,
    };
  }

  /**
   * Get number of in-flight requests
   */
  getInFlightCount(): number {
    return this.inFlight.size;
  }

  /**
   * Clear statistics
   */
  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      deduplicatedRequests: 0,
      savedExecutions: 0,
    };
  }

  /**
   * Wait for all in-flight requests to complete
   */
  async drain(): Promise<void> {
    const promises = Array.from(this.inFlight.values());
    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }
}

// Global instance
export const globalRequestDeduplicator = new RequestDeduplicator();

function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();

  return JSON.stringify(value, (_key, current) => {
    if (typeof current === "bigint") {
      return current.toString();
    }
    if (
      typeof current === "object" &&
      current !== null &&
      !Array.isArray(current)
    ) {
      if (seen.has(current)) {
        return "[Circular]";
      }
      seen.add(current);
      return Object.keys(current as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          result[key] = (current as Record<string, unknown>)[key];
          return result;
        }, {});
    }
    return current;
  });
}
