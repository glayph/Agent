/**
 * ToolWarmer: Preemptive tool warm-up for reduced latency
 * - Predict likely next tools based on task and skill profiles
 * - Pre-load tool modules and initialize resources
 * - Preemptively fetch data if safe
 */

export interface ToolWarmupConfig {
  enabled: boolean;
  lookAheadTools: number; // Number of tools to warm up
  prefetchData: boolean;
  timeout: number; // ms to wait for warmup
}

export interface WarmupResult {
  tool: string;
  preloaded: boolean;
  dataFetched?: boolean;
  error?: string;
}

export class ToolWarmer {
  private warmedTools: Set<string> = new Set();
  private toolInitializers: Map<string, () => Promise<void>> = new Map();
  private toolDataFetchers: Map<string, (query?: string) => Promise<unknown>> =
    new Map();
  private config: ToolWarmupConfig;

  constructor(config: Partial<ToolWarmupConfig> = {}) {
    this.config = {
      enabled: config.enabled !== false,
      lookAheadTools: config.lookAheadTools || 3,
      prefetchData: config.prefetchData !== false,
      timeout: config.timeout || 5000,
    };
  }

  /**
   * Register a tool initializer
   */
  registerInitializer(
    toolName: string,
    initializer: () => Promise<void>,
  ): void {
    this.toolInitializers.set(toolName, initializer);
  }

  /**
   * Register a data fetcher for a tool
   */
  registerDataFetcher(
    toolName: string,
    fetcher: (query?: string) => Promise<unknown>,
  ): void {
    this.toolDataFetchers.set(toolName, fetcher);
  }

  /**
   * Warm up tools based on current context
   */
  async warmUp(
    likelyTools: string[],
    context?: { query?: string; taskType?: string },
  ): Promise<WarmupResult[]> {
    if (!this.config.enabled) {
      return [];
    }

    const results: WarmupResult[] = [];
    const toolsToWarmup = likelyTools.slice(0, this.config.lookAheadTools);

    for (const toolName of toolsToWarmup) {
      // Skip if already warmed
      if (this.warmedTools.has(toolName)) {
        results.push({ tool: toolName, preloaded: false });
        continue;
      }

      try {
        // Initialize tool with timeout
        const initializer = this.toolInitializers.get(toolName);
        if (initializer) {
          await this.executeWithTimeout(initializer(), this.config.timeout);
          this.warmedTools.add(toolName);
        }

        // Optionally prefetch data
        let dataFetched = false;
        if (this.config.prefetchData && context?.query) {
          const fetcher = this.toolDataFetchers.get(toolName);
          if (fetcher) {
            try {
              await this.executeWithTimeout(
                fetcher(context.query),
                this.config.timeout / 2,
              );
              dataFetched = true;
            } catch {
              // Silently fail; data fetch is optional
            }
          }
        }

        results.push({ tool: toolName, preloaded: true, dataFetched });
      } catch (error) {
        // Warmup failed but don't block execution
        results.push({
          tool: toolName,
          preloaded: false,
          error: String(error),
        });
      }
    }

    return results;
  }

  /**
   * Prefetch relevant pages/data for a query
   */
  async prefetchRelevantData(
    keywords: string[],
    toolName: string,
    maxItems: number = 3,
  ): Promise<unknown[]> {
    const fetcher = this.toolDataFetchers.get(toolName);
    if (!fetcher) return [];

    const results: unknown[] = [];

    for (let i = 0; i < Math.min(keywords.length, maxItems); i++) {
      try {
        const data = await this.executeWithTimeout(fetcher(keywords[i]), 2000);
        if (data) results.push(data);
      } catch {
        // Continue with next keyword
      }
    }

    return results;
  }

  /**
   * Execute with timeout helper
   */
  private executeWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Warmup timeout")),
        timeoutMs,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /**
   * Clear warmed tools (e.g., for new session)
   */
  clearWarmed(): void {
    this.warmedTools.clear();
  }

  /**
   * Get warmed tools
   */
  getWarmedTools(): string[] {
    return Array.from(this.warmedTools);
  }

  /**
   * Check if tool is warmed
   */
  isWarmed(toolName: string): boolean {
    return this.warmedTools.has(toolName);
  }

  /**
   * Get warmer config
   */
  getConfig(): ToolWarmupConfig {
    return { ...this.config };
  }

  /**
   * Update config
   */
  updateConfig(config: Partial<ToolWarmupConfig>): void {
    this.config = { ...this.config, ...config };
  }
}

export const globalToolWarmer = new ToolWarmer({
  enabled: true,
  lookAheadTools: 3,
  prefetchData: true,
  timeout: 5000,
});
