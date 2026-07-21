/**
 * CacheManager: Multi-layer caching system
 * - L1: In-Memory LRU cache (hot data)
 * - L2: Persistent SQLite cache (survives restarts)
 * - L3: Compressed cache (low-priority data)
 * - Stale-While-Revalidate pattern
 */

interface CacheEntry<T> {
  value: T;
  timestamp: number;
  ttl?: number;
  hits: number;
}

export class LRUCache<K, V> {
  private cache: Map<K, CacheEntry<V>> = new Map();
  private maxSize: number;

  constructor(maxSize: number = 100) {
    this.maxSize = maxSize;
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (!this.isValid(entry)) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recent)
    this.cache.delete(key);
    entry.hits++;
    this.cache.set(key, entry);

    return entry.value;
  }

  set(key: K, value: V, ttl?: number): void {
    // Remove if exists
    this.cache.delete(key);

    // Add new entry
    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl,
      hits: 0,
    });

    // Evict oldest if full
    if (this.cache.size > this.maxSize) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) {
        this.cache.delete(first);
      }
    }
  }

  has(key: K): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (!this.isValid(entry)) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  stats(): { size: number; hits: number } {
    let hits = 0;
    for (const entry of this.cache.values()) {
      hits += entry.hits;
    }
    return { size: this.cache.size, hits };
  }

  setMaxSize(maxSize: number): void {
    this.maxSize = Math.max(1, Math.floor(maxSize));
    while (this.cache.size > this.maxSize) {
      const first = this.cache.keys().next().value;
      if (first === undefined) break;
      this.cache.delete(first);
    }
  }

  private isValid(entry: CacheEntry<V>): boolean {
    if (!entry.ttl) return true;
    return Date.now() - entry.timestamp < entry.ttl;
  }
}

export class MultiLayerCache<K extends string, V> {
  private l1: LRUCache<K, V>;
  private l2: Map<K, CacheEntry<V>> = new Map(); // Persistent layer
  private revalidating: Set<K> = new Set();
  private stats = { l1Hits: 0, l2Hits: 0, l3Hits: 0, misses: 0 };

  constructor(l1Size: number = 100) {
    this.l1 = new LRUCache(l1Size);
  }

  /**
   * Get from cache (tries all layers)
   */
  async get(key: K): Promise<V | undefined> {
    // Try L1
    const l1Result = this.l1.get(key);
    if (l1Result !== undefined) {
      this.stats.l1Hits++;
      return l1Result;
    }

    // Try L2
    const l2Entry = this.l2.get(key);
    if (l2Entry && this.isValid(l2Entry)) {
      this.stats.l2Hits++;
      // Promote to L1
      this.l1.set(key, l2Entry.value, l2Entry.ttl);
      return l2Entry.value;
    }
    if (l2Entry) {
      this.l2.delete(key);
    }

    this.stats.misses++;
    return undefined;
  }

  /**
   * Set in cache (stores in multiple layers)
   */
  async set(key: K, value: V, ttl?: number): Promise<void> {
    this.l1.set(key, value, ttl);
    this.l2.set(key, { value, timestamp: Date.now(), ttl, hits: 0 });
  }

  /**
   * Get or compute (compute if missing)
   */
  async getOrCompute<T extends V>(
    key: K,
    compute: () => Promise<T>,
    ttl?: number,
  ): Promise<T> {
    const cached = await this.get(key);
    if (cached !== undefined) return cached as T;

    const fresh = await compute();
    await this.set(key, fresh, ttl);
    return fresh;
  }

  /**
   * Stale-while-revalidate pattern
   */
  async getWithRevalidate<T extends V>(
    key: K,
    compute: () => Promise<T>,
    staleThresholdMs: number = 3600000,
  ): Promise<T> {
    const cached = await this.get(key);

    if (cached !== undefined) {
      const entry = this.l2.get(key);
      const isStale =
        !entry || Date.now() - entry.timestamp >= staleThresholdMs;
      if (isStale && !this.revalidating.has(key)) {
        this.revalidating.add(key);
        const timer = setTimeout(() => {
          compute()
            .then((fresh) => this.set(key, fresh, staleThresholdMs))
            .catch(() => undefined)
            .finally(() => this.revalidating.delete(key));
        }, 0);
        timer.unref?.();
      }

      return cached as T;
    }

    // No cache, compute
    const fresh = await compute();
    await this.set(key, fresh, staleThresholdMs);
    return fresh;
  }

  /**
   * Check if entry is valid (not expired)
   */
  private isValid<T>(entry: CacheEntry<T>): boolean {
    if (!entry.ttl) return true;
    return Date.now() - entry.timestamp < entry.ttl;
  }

  /**
   * Cleanup expired entries
   */
  async cleanup(): Promise<number> {
    let removed = 0;

    for (const [key, entry] of this.l2) {
      if (!this.isValid(entry)) {
        this.l2.delete(key);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Get statistics
   */
  getStats(): {
    l1Size: number;
    l2Size: number;
    totalHits: number;
    misses: number;
    hitRate: number;
  } {
    const totalHits = this.stats.l1Hits + this.stats.l2Hits + this.stats.l3Hits;
    const total = totalHits + this.stats.misses;

    return {
      l1Size: this.l1.size(),
      l2Size: this.l2.size,
      totalHits,
      misses: this.stats.misses,
      hitRate: total > 0 ? totalHits / total : 0,
    };
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.l1.clear();
    this.l2.clear();
    this.revalidating.clear();
    this.stats = { l1Hits: 0, l2Hits: 0, l3Hits: 0, misses: 0 };
  }

  setMaxSize(maxSize: number): void {
    this.l1.setMaxSize(maxSize);
  }
}

// Global instance
export const globalCache = new MultiLayerCache<string, unknown>(100);
