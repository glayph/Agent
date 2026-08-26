/**
 * CircuitBreaker: Prevent cascading failures
 * - Track service health
 * - Open circuit on repeated failures
 * - Half-open for recovery attempts
 */

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private state: CircuitState = "closed";
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: number | null = null;

  private readonly FAILURE_THRESHOLD: number;
  private readonly SUCCESS_THRESHOLD: number;
  private readonly TIMEOUT_MS: number;

  constructor(
    failureThreshold: number = 5,
    successThreshold: number = 2,
    timeoutMs: number = 60000,
  ) {
    this.FAILURE_THRESHOLD = failureThreshold;
    this.SUCCESS_THRESHOLD = successThreshold;
    this.TIMEOUT_MS = timeoutMs;
  }

  /**
   * Check if circuit is open
   */
  isOpen(): boolean {
    if (this.state === "closed") return false;

    // Try to transition to half-open if timeout elapsed
    if (
      this.state === "open" &&
      this.lastFailureTime &&
      Date.now() - this.lastFailureTime > this.TIMEOUT_MS
    ) {
      this.state = "half-open";
      this.successCount = 0;
      return false;
    }

    return this.state === "open";
  }

  /**
   * Record success
   */
  recordSuccess(): void {
    this.failureCount = 0;

    if (this.state === "half-open") {
      this.successCount++;
      if (this.successCount >= this.SUCCESS_THRESHOLD) {
        this.state = "closed";
        this.successCount = 0;
      }
    } else if (this.state === "closed") {
      // Continue normal operation
    }
  }

  /**
   * Record failure
   */
  recordFailure(): void {
    this.lastFailureTime = Date.now();

    if (this.state === "half-open") {
      // Failure in half-open, go back to open
      this.state = "open";
      this.failureCount = 0;
    } else {
      this.failureCount++;

      if (this.failureCount >= this.FAILURE_THRESHOLD) {
        this.state = "open";
      }
    }
  }

  /**
   * Get current state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get stats
   */
  getStats(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
  } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
    };
  }

  /**
   * Reset circuit
   */
  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
  }
}

/**
 * Advanced error handler with fallbacks
 */
export class AdvancedErrorHandler {
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();

  /**
   * Execute with automatic fallback
   */
  async executeWithFallback<T>(
    primary: () => Promise<T>,
    fallback: () => Promise<T>,
    serviceName: string,
  ): Promise<T> {
    const breaker = this.getBreaker(serviceName);

    // Use fallback if circuit open
    if (breaker.isOpen()) {
      console.warn(`Circuit breaker open for ${serviceName}, using fallback`);
      return await fallback();
    }

    try {
      const result = await primary();
      breaker.recordSuccess();
      return result;
    } catch {
      breaker.recordFailure();

      if (breaker.isOpen()) {
        console.error(`Circuit breaker opened for ${serviceName}`);
      }

      // Use fallback
      return await fallback();
    }
  }

  /**
   * Get or create breaker
   */
  private getBreaker(serviceName: string): CircuitBreaker {
    if (!this.circuitBreakers.has(serviceName)) {
      this.circuitBreakers.set(serviceName, new CircuitBreaker(5, 2, 60000));
    }
    return this.circuitBreakers.get(serviceName)!;
  }

  /**
   * Get breaker stats
   */
  getStats(serviceName: string): Record<string, unknown> | null {
    const breaker = this.circuitBreakers.get(serviceName);
    return breaker ? breaker.getStats() : null;
  }

  /**
   * Reset all breakers
   */
  resetAll(): void {
    for (const breaker of this.circuitBreakers.values()) {
      breaker.reset();
    }
  }
}

export const globalErrorHandler = new AdvancedErrorHandler();
