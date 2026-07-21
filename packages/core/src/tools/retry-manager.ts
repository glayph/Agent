/**
 * RetryManager: Intelligent retry strategy with exponential backoff and jitter
 * - Classify errors: transient vs. permanent
 * - Exponential backoff with jitter to avoid thundering herd
 * - Track retry metrics and statistics
 */

export interface RetryConfig {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitterFactor: number; // 0-1
}

export interface RetryStats {
  totalAttempts: number;
  successfulRetries: number;
  failedRetries: number;
  averageRetriesPerSuccess: number;
}

interface RetriableErrorShape {
  status?: number;
  code?: string;
}

export class RetryManager {
  private config: RetryConfig;
  private stats: RetryStats = {
    totalAttempts: 0,
    successfulRetries: 0,
    failedRetries: 0,
    averageRetriesPerSuccess: 0,
  };

  private readonly TRANSIENT_ERROR_CODES = [408, 429, 500, 502, 503, 504];
  private readonly TRANSIENT_MESSAGES = [
    "timeout",
    "connection reset",
    "econnreset",
    "etimedout",
    "temporarily unavailable",
    "temporarily_unavailable",
    "rate limit",
  ];

  constructor(config: Partial<RetryConfig> = {}) {
    this.config = {
      maxAttempts: config.maxAttempts || 3,
      initialDelayMs: config.initialDelayMs || 500, // Reduced from 1000ms
      maxDelayMs: config.maxDelayMs || 10000, // Reduced from 30000ms
      backoffMultiplier: config.backoffMultiplier || 2,
      jitterFactor: config.jitterFactor || 0.1,
    };
  }

  /**
   * Determine if error is transient (retriable)
   */
  private isTransient(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();

      // Check for transient messages
      for (const msg of this.TRANSIENT_MESSAGES) {
        if (message.includes(msg)) {
          return true;
        }
      }

      // Check for HTTP status codes
      if ("status" in error) {
        const status = (error as RetriableErrorShape).status;
        if (
          typeof status === "number" &&
          this.TRANSIENT_ERROR_CODES.includes(status)
        ) {
          return true;
        }
      }
    }

    if (typeof error === "object" && error !== null) {
      const retryError = error as RetriableErrorShape;
      if (typeof retryError.status === "number") {
        if (this.TRANSIENT_ERROR_CODES.includes(retryError.status)) {
          return true;
        }
      }
      if (typeof retryError.code === "string") {
        if (retryError.code.toUpperCase().includes("TIMEOUT")) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Calculate delay with exponential backoff and jitter
   */
  private calculateDelay(attempt: number): number {
    const exponentialDelay =
      Math.pow(this.config.backoffMultiplier, attempt) *
      this.config.initialDelayMs;
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
    const jitter = cappedDelay * this.config.jitterFactor * Math.random();
    return cappedDelay + jitter;
  }

  /**
   * Execute function with retry logic
   */
  async retry<T>(
    fn: () => Promise<T>,
    onRetry?: (attempt: number, error: Error) => void,
  ): Promise<T> {
    let lastError: Error | null = null;
    let attempts = 0;

    for (attempts = 0; attempts < this.config.maxAttempts; attempts++) {
      try {
        this.stats.totalAttempts++;
        const result = await fn();

        if (attempts > 0) {
          this.stats.successfulRetries++;
        }

        return result;
      } catch (error) {
        lastError = error as Error;

        // Fail fast for permanent errors
        if (!this.isTransient(error)) {
          this.stats.failedRetries++;
          throw lastError;
        }

        // If this is the last attempt, fail
        if (attempts === this.config.maxAttempts - 1) {
          this.stats.failedRetries++;
          throw lastError;
        }

        // Calculate backoff delay
        const delay = this.calculateDelay(attempts);

        if (onRetry) {
          onRetry(attempts + 1, lastError);
        }

        // Wait before retrying
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError || new Error("Retry exhausted");
  }

  /**
   * Execute with timeout
   */
  async executeWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number = 30000,
  ): Promise<T> {
    return Promise.race([
      fn(),
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Operation timeout after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ]);
  }

  /**
   * Execute with retry and timeout
   */
  async retryWithTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number = 30000,
  ): Promise<T> {
    return this.retry(() => this.executeWithTimeout(fn, timeoutMs));
  }

  /**
   * Get retry statistics
   */
  getStats(): RetryStats & { configuration: RetryConfig } {
    return {
      ...this.stats,
      averageRetriesPerSuccess:
        this.stats.successfulRetries > 0
          ? this.stats.totalAttempts / (this.stats.successfulRetries + 1)
          : 0,
      configuration: this.config,
    };
  }

  /**
   * Reset statistics
   */
  resetStats(): void {
    this.stats = {
      totalAttempts: 0,
      successfulRetries: 0,
      failedRetries: 0,
      averageRetriesPerSuccess: 0,
    };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

// Global instance with default config
export const globalRetryManager = new RetryManager({
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
});
