export interface TimingEntry {
  name: string;
  startedAt: number;
  durationMs: number;
}

export interface PerformanceBudget {
  name: string;
  maxMs?: number;
  maxBytes?: number;
}

export interface PerformanceBudgetResult {
  name: string;
  value: number;
  limit: number;
  unit: "ms" | "bytes";
  passed: boolean;
}

export class StartupTimer {
  private readonly starts = new Map<string, number>();
  private readonly entries: TimingEntry[] = [];

  start(name: string): void {
    this.starts.set(name, Date.now());
  }

  end(name: string): TimingEntry {
    const startedAt = this.starts.get(name);
    if (startedAt === undefined) {
      throw new Error(`Startup timer was not started: ${name}`);
    }
    const entry = {
      name,
      startedAt,
      durationMs: Date.now() - startedAt,
    };
    this.starts.delete(name);
    this.entries.push(entry);
    return entry;
  }

  measure<T>(name: string, fn: () => T): T {
    this.start(name);
    try {
      return fn();
    } finally {
      this.end(name);
    }
  }

  async measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
    this.start(name);
    try {
      return await fn();
    } finally {
      this.end(name);
    }
  }

  report(): TimingEntry[] {
    return [...this.entries];
  }
}

export class PerformanceBudgetChecker {
  constructor(private readonly budgets: PerformanceBudget[]) {}

  checkTimings(entries: TimingEntry[]): PerformanceBudgetResult[] {
    return entries.flatMap((entry) => {
      const budget = this.budgets.find((item) => item.name === entry.name);
      if (!budget?.maxMs) return [];
      return [
        {
          name: entry.name,
          value: entry.durationMs,
          limit: budget.maxMs,
          unit: "ms" as const,
          passed: entry.durationMs <= budget.maxMs,
        },
      ];
    });
  }

  checkSizes(sizes: Record<string, number>): PerformanceBudgetResult[] {
    return Object.entries(sizes).flatMap(([name, value]) => {
      const budget = this.budgets.find((item) => item.name === name);
      if (!budget?.maxBytes) return [];
      return [
        {
          name,
          value,
          limit: budget.maxBytes,
          unit: "bytes" as const,
          passed: value <= budget.maxBytes,
        },
      ];
    });
  }

  assert(results: PerformanceBudgetResult[]): void {
    const failed = results.filter((item) => !item.passed);
    if (failed.length > 0) {
      throw new Error(
        `Performance budget exceeded: ${failed
          .map(
            (item) =>
              `${item.name}=${item.value}${item.unit} > ${item.limit}${item.unit}`,
          )
          .join(", ")}`,
      );
    }
  }
}

export const globalStartupTimer = new StartupTimer();
