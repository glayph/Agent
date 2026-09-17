/**
 * MetricsCollector: Performance metrics and bottleneck detection
 * - Track metrics per component
 * - Store time-series data
 * - Detect anomalies
 * - Alert on threshold violations
 */

export interface Metric {
  name: string;
  value: number;
  timestamp: number;
  tags?: Record<string, string>;
}

export interface MetricStats {
  count: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
}

export class MetricsCollector {
  private counters: Map<string, number> = new Map();
  private gauges: Map<string, number> = new Map();
  private histograms: Map<string, number[]> = new Map();
  private timeseries: Metric[] = [];

  private readonly MAX_SAMPLES = 10000;
  private readonly ANOMALY_MULTIPLIER = 2;

  private assertMetricName(name: string): void {
    if (!name || typeof name !== "string" || !name.trim()) {
      throw new Error("Metric name must be a non-empty string");
    }
  }

  private assertFiniteValue(value: number, label: string): void {
    if (!Number.isFinite(value)) {
      throw new Error(`${label} must be a finite number`);
    }
  }

  /**
   * Increment a counter
   */
  incrementCounter(
    name: string,
    value: number = 1,
    tags?: Record<string, string>,
  ): void {
    this.assertMetricName(name);
    this.assertFiniteValue(value, "Counter increment");
    const key = this.getKey(name, tags);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  /**
   * Set a gauge (absolute value)
   */
  setGauge(name: string, value: number, tags?: Record<string, string>): void {
    this.assertMetricName(name);
    this.assertFiniteValue(value, "Gauge value");
    const key = this.getKey(name, tags);
    this.gauges.set(key, value);
  }

  /**
   * Record latency (milliseconds)
   */
  recordLatency(
    operation: string,
    ms: number,
    tags?: Record<string, string>,
  ): void {
    this.assertMetricName(operation);
    this.assertFiniteValue(ms, "Latency");
    if (ms < 0) {
      throw new Error("Latency must not be negative");
    }
    const key = `latency_${operation}`;
    this.incrementCounter(`total_${operation}`, 1, tags);

    if (!this.histograms.has(key)) {
      this.histograms.set(key, []);
    }

    const values = this.histograms.get(key)!;
    values.push(ms);

    // Keep only recent samples
    if (values.length > 1000) {
      values.splice(0, values.length - 1000);
    }

    // Detect anomaly
    if (values.length > 10) {
      const recent = values.slice(-100);
      const p95 = this.percentile(recent, 0.95);

      if (ms > p95 * this.ANOMALY_MULTIPLIER) {
        this.recordAnomaly(operation, ms, p95);
      }
    }

    // Record in timeseries
    this.addTimeseries({
      name: key,
      value: ms,
      timestamp: Date.now(),
      tags,
    });
  }

  /**
   * Record error
   */
  recordError(operation: string, tags?: Record<string, string>): void {
    this.assertMetricName(operation);
    const key = `errors_${operation}`;
    this.incrementCounter(key, 1, tags);

    // Check error rate
    const totalKey = `total_${operation}`;
    const total = this.counters.get(this.getKey(totalKey, tags)) || 1;
    const errors = this.counters.get(this.getKey(key, tags)) || 0;
    const errorRate = errors / total;

    if (errorRate > 0.1) {
      console.warn(
        `High error rate for ${operation}: ${(errorRate * 100).toFixed(1)}% (${errors}/${total})`,
      );
    }
  }

  /**
   * Record anomaly
   */
  private recordAnomaly(
    operation: string,
    value: number,
    baseline: number,
  ): void {
    console.warn(
      `ANOMALY: ${operation} = ${value}ms (baseline p95=${baseline.toFixed(0)}ms, ${((value / baseline - 1) * 100).toFixed(0)}% above)`,
    );
  }

  /**
   * Get percentile from sorted array
   */
  private percentile(arr: number[], p: number): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * p) - 1;
    return sorted[Math.max(0, idx)];
  }

  /**
   * Get statistics for a metric
   */
  getStats(name: string): MetricStats | null {
    const values = this.histograms.get(name);
    if (!values || values.length === 0) {
      return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);

    return {
      count: sorted.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      mean: sum / sorted.length,
      p50: this.percentile(sorted, 0.5),
      p95: this.percentile(sorted, 0.95),
      p99: this.percentile(sorted, 0.99),
    };
  }

  /**
   * Get counter value
   */
  getCounter(name: string, tags?: Record<string, string>): number {
    return this.counters.get(this.getKey(name, tags)) || 0;
  }

  /**
   * Get gauge value
   */
  getGauge(name: string, tags?: Record<string, string>): number {
    return this.gauges.get(this.getKey(name, tags)) || 0;
  }

  /**
   * Generate metrics report
   */
  getReport(): {
    counters: Record<string, number>;
    gauges: Record<string, number>;
    histograms: Record<string, MetricStats>;
  } {
    const counters: Record<string, number> = {};
    for (const [key, value] of this.counters) {
      counters[key] = value;
    }

    const gauges: Record<string, number> = {};
    for (const [key, value] of this.gauges) {
      gauges[key] = value;
    }

    const histograms: Record<string, MetricStats> = {};
    for (const key of this.histograms.keys()) {
      const stats = this.getStats(key);
      if (stats) histograms[key] = stats;
    }

    return { counters, gauges, histograms };
  }

  /**
   * Add to timeseries data
   */
  private addTimeseries(metric: Metric): void {
    this.timeseries.push({
      ...metric,
      tags: metric.tags ? { ...metric.tags } : undefined,
    });

    // Keep only recent
    if (this.timeseries.length > this.MAX_SAMPLES) {
      this.timeseries = this.timeseries.slice(-this.MAX_SAMPLES);
    }
  }

  /**
   * Get timeseries data
   */
  getTimeseries(name?: string): Metric[] {
    if (!name) {
      return this.timeseries.map((metric) => ({
        ...metric,
        tags: metric.tags ? { ...metric.tags } : undefined,
      }));
    }
    return this.timeseries
      .filter((m) => m.name === name)
      .map((metric) => ({
        ...metric,
        tags: metric.tags ? { ...metric.tags } : undefined,
      }));
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.counters.clear();
    this.gauges.clear();
    this.histograms.clear();
    this.timeseries = [];
  }

  /**
   * Get key with tags
   */
  private getKey(name: string, tags?: Record<string, string>): string {
    this.assertMetricName(name);
    if (!tags || Object.keys(tags).length === 0) {
      return name;
    }

    const tagStr = Object.entries(tags)
      .filter(
        ([key, value]) =>
          typeof key === "string" &&
          key.trim().length > 0 &&
          typeof value === "string" &&
          value.trim().length > 0,
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k.trim()}=${v.trim().slice(0, 256)}`)
      .join(",");

    if (!tagStr) return name;
    return `${name}{${tagStr}}`;
  }
}

// Global instance
export const globalMetricsCollector = new MetricsCollector();
