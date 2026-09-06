import type * as http from "http";

/**
 * ResourcePool: Connection pooling and resource reuse
 * - Pool of reusable resources (browsers, connections, etc.)
 * - LRU eviction when pool full
 * - Automatic cleanup and reset
 * - Max concurrent resource enforcement
 */

export interface PooledResource {
  isAvailable: boolean;
  createdAt: number;
  lastUsedAt: number;
}

export class ResourcePool<T extends PooledResource> {
  private available: T[] = [];
  private inUse = new Set<T>();
  private factory: () => Promise<T>;
  private destroyer?: (resource: T) => Promise<void>;
  private maxSize: number;
  private stats = {
    created: 0,
    reused: 0,
    destroyed: 0,
  };

  constructor(
    factory: () => Promise<T>,
    maxSize: number = 5,
    destroyer?: (resource: T) => Promise<void>,
  ) {
    this.factory = factory;
    this.maxSize = maxSize;
    this.destroyer = destroyer;
  }

  /**
   * Acquire a resource from the pool
   */
  async acquire(): Promise<T> {
    // Try to get an available resource
    if (this.available.length > 0) {
      const resource = this.available.pop()!;
      resource.isAvailable = false;
      resource.lastUsedAt = Date.now();
      this.inUse.add(resource);
      this.stats.reused++;
      return resource;
    }

    // Create new if under limit
    if (this.inUse.size < this.maxSize) {
      const resource = await this.factory();
      this.inUse.add(resource);
      this.stats.created++;
      return resource;
    }

    // Wait for a resource to be released
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (this.available.length > 0) {
          clearInterval(checkInterval);
          this.acquire().then(resolve);
        }
      }, 100);

      // Timeout after 30 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        throw new Error("Resource acquisition timeout");
      }, 30000);
    });
  }

  /**
   * Release a resource back to the pool
   */
  release(resource: T): void {
    this.inUse.delete(resource);
    resource.isAvailable = true;
    resource.lastUsedAt = Date.now();
    this.available.push(resource);

    // Trim if too many available
    if (this.available.length > this.maxSize * 0.5) {
      this.trimAvailable();
    }
  }

  /**
   * Reset a resource to clean state
   */
  async reset(resource: T): Promise<void> {
    if (this.destroyer) {
      await this.destroyer(resource);
    }
    resource.isAvailable = true;
    this.release(resource);
  }

  /**
   * Trim available resources (remove oldest)
   */
  private trimAvailable(): void {
    const toKeep = Math.floor(this.maxSize * 0.3);
    while (this.available.length > toKeep) {
      const oldest = this.available.shift();
      if (oldest && this.destroyer) {
        this.destroyer(oldest).catch(console.error);
      }
      this.stats.destroyed++;
    }
  }

  /**
   * Drain the pool (cleanup all resources)
   */
  async drain(): Promise<void> {
    for (const resource of this.available) {
      if (this.destroyer) {
        await this.destroyer(resource);
      }
    }
    this.available = [];

    // Wait for in-use resources or force cleanup
    const timeout = 5000;
    const start = Date.now();
    while (this.inUse.size > 0 && Date.now() - start < timeout) {
      await new Promise((r) => setTimeout(r, 100));
    }

    if (this.inUse.size > 0) {
      console.warn(`Force draining ${this.inUse.size} in-use resources`);
      for (const resource of this.inUse) {
        if (this.destroyer) {
          await this.destroyer(resource).catch(console.error);
        }
      }
      this.inUse.clear();
    }
  }

  /**
   * Get pool statistics
   */
  getStats(): {
    available: number;
    inUse: number;
    totalCreated: number;
    totalReused: number;
    totalDestroyed: number;
    utilizationRate: number;
  } {
    const total = this.available.length + this.inUse.size;
    const utilization = total > 0 ? this.inUse.size / total : 0;

    return {
      available: this.available.length,
      inUse: this.inUse.size,
      totalCreated: this.stats.created,
      totalReused: this.stats.reused,
      totalDestroyed: this.stats.destroyed,
      utilizationRate: utilization,
    };
  }

  /**
   * Resize the pool
   */
  setMaxSize(newMax: number): void {
    this.maxSize = newMax;
    if (this.available.length > newMax) {
      this.trimAvailable();
    }
  }
}

/**
 * Simple HTTP connection pool using Node.js http.Agent
 */
export class HttpConnectionPool {
  private agent?: http.Agent;

  constructor(maxSockets: number = 50, maxFreeSockets: number = 10) {
    // Lazy load to avoid issues in non-Node environments
    if (typeof require !== "undefined") {
      try {
        const http = require("http");
        this.agent = new http.Agent({
          keepAlive: true,
          maxSockets,
          maxFreeSockets,
        });
      } catch {
        console.warn("HTTP Agent not available");
      }
    }
  }

  getAgent(): http.Agent | undefined {
    return this.agent;
  }

  async drain(): Promise<void> {
    if (this.agent && this.agent.destroy) {
      this.agent.destroy();
    }
  }
}

export const globalHttpPool = new HttpConnectionPool();
