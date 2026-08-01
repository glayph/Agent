/**
 * HealthChecker: Comprehensive system health monitoring
 * - Check component health
 * - Aggregate into system-wide score
 * - Expose detailed status
 */

export type HealthStatus = "healthy" | "degraded" | "unhealthy";

export interface ComponentHealth {
  status: HealthStatus;
  lastCheck: number;
  details?: Record<string, unknown>;
}

export interface SystemHealth {
  status: HealthStatus;
  timestamp: number;
  components: Record<string, ComponentHealth>;
  overallScore: number; // 0-1
}

export class HealthChecker {
  private componentHealth: Map<string, ComponentHealth> = new Map();
  private checkIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor() {
    this.initializeDefaultChecks();
  }

  /**
   * Initialize default health checks
   */
  private initializeDefaultChecks(): void {
    // Memory check every 10 seconds
    this.registerCheck("memory", () => this.checkMemory(), 10000);

    // Database check every 30 seconds
    this.registerCheck("database", () => this.checkDatabase(), 30000);
  }

  /**
   * Register a custom health check
   */
  registerCheck(
    name: string,
    checker: () => Promise<ComponentHealth>,
    intervalMs: number = 30000,
  ): void {
    // Clear existing interval if any
    if (this.checkIntervals.has(name)) {
      clearInterval(this.checkIntervals.get(name)!);
    }

    // Run initial check
    checker().then((health) => {
      this.componentHealth.set(name, health);
    });

    // Schedule periodic checks
    const interval = setInterval(() => {
      checker().then((health) => {
        this.componentHealth.set(name, health);
      });
    }, intervalMs);

    this.checkIntervals.set(name, interval);
  }

  /**
   * Get system health
   */
  async getHealth(): Promise<SystemHealth> {
    const components: Record<string, ComponentHealth> = {};
    let healthyCount = 0;
    let degradedCount = 0;
    let unhealthyCount = 0;

    for (const [name, health] of this.componentHealth) {
      components[name] = health;

      if (health.status === "healthy") healthyCount++;
      else if (health.status === "degraded") degradedCount++;
      else unhealthyCount++;
    }

    // Determine overall status
    let overallStatus: HealthStatus = "healthy";
    if (unhealthyCount > 0) {
      overallStatus = "unhealthy";
    } else if (degradedCount > 0) {
      overallStatus = "degraded";
    }

    const total = healthyCount + degradedCount + unhealthyCount;
    const overallScore = total > 0 ? healthyCount / total : 1;

    return {
      status: overallStatus,
      timestamp: Date.now(),
      components,
      overallScore,
    };
  }

  /**
   * Check memory health
   */
  private async checkMemory(): Promise<ComponentHealth> {
    const used = process.memoryUsage().heapUsed;
    const total = process.memoryUsage().heapTotal;
    const available = total - used;
    const percentUsed = (used / total) * 100;

    let status: HealthStatus = "healthy";
    if (percentUsed > 90) {
      status = "unhealthy";
    } else if (percentUsed > 75) {
      status = "degraded";
    }

    return {
      status,
      lastCheck: Date.now(),
      details: {
        used,
        total,
        available,
        percentUsed: percentUsed.toFixed(1),
      },
    };
  }

  /**
   * Check database health
   */
  private async checkDatabase(): Promise<ComponentHealth> {
    try {
      const start = Date.now();
      // Simulate database check
      await new Promise((r) => setTimeout(r, 10));
      const latency = Date.now() - start;

      let status: HealthStatus = "healthy";
      if (latency > 1000) {
        status = "degraded";
      } else if (latency > 5000) {
        status = "unhealthy";
      }

      return {
        status,
        lastCheck: Date.now(),
        details: { latency },
      };
    } catch (e) {
      return {
        status: "unhealthy",
        lastCheck: Date.now(),
        details: { error: String(e) },
      };
    }
  }

  /**
   * Get specific component health
   */
  getComponentHealth(name: string): ComponentHealth | null {
    return this.componentHealth.get(name) || null;
  }

  /**
   * Cleanup
   */
  shutdown(): void {
    for (const interval of this.checkIntervals.values()) {
      clearInterval(interval);
    }
    this.checkIntervals.clear();
  }
}

export const globalHealthChecker = new HealthChecker();
