import * as crypto from "crypto";

/**
 * SemanticResponseCache: Multi-layer caching system to reduce LLM calls
 * - Layer 1: Exact match cache (hash-based)
 * - Layer 2: Semantic similarity cache (embedding-based, cosine similarity)
 * - Layer 3: Partial response cache (common sub-responses)
 */

export interface CacheEntry {
  response: string;
  timestamp: number;
  tokens?: number;
  cost?: number;
}

export interface CacheStats {
  exactHits: number;
  semanticHits: number;
  misses: number;
  totalSavings: number;
  hitRate: number;
  averageResponseTime: number;
}

export class SemanticResponseCache {
  private exactCache: Map<string, CacheEntry> = new Map();
  private semanticIndex: {
    embedding: number[];
    response: string;
    query: string;
    tokens: number;
    cost: number;
  }[] = [];
  private partialCache: Map<string, string> = new Map();

  private stats = {
    exactHits: 0,
    semanticHits: 0,
    misses: 0,
    totalSavings: 0,
    responseTimes: [] as number[],
  };

  private readonly SIMILARITY_THRESHOLD = 0.92;
  private readonly MAX_CACHE_SIZE = 1000;
  private readonly MAX_SEMANTIC_INDEX_SIZE = 500;

  /**
   * Hash a query string for exact matching
   */
  private hashQuery(query: string): string {
    return crypto.createHash("sha256").update(query).digest("hex");
  }

  /**
   * Generate embedding for a query (simple string-based similarity for now)
   * In production, use a proper embedding model (OpenAI embeddings, Sentence-BERT, etc.)
   */
  private async embed(text: string): Promise<number[]> {
    // Simple embedding: hash-based feature extraction
    const tokens = text.toLowerCase().split(/\s+/);
    const embedding: number[] = [];

    for (let i = 0; i < 768; i++) {
      let hash = 0;
      for (const token of tokens) {
        hash = (hash << 5) - hash + token.charCodeAt(i % token.length);
        hash = hash & hash;
      }
      embedding.push((hash & 0xff) / 255.0);
    }

    return embedding;
  }

  /**
   * Compute cosine similarity between two embeddings
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * Find semantically similar cached queries
   */
  private findSimilar(
    embedding: number[],
    threshold: number,
  ): { response: string; query: string; similarity: number } | null {
    let best: {
      response: string;
      query: string;
      similarity: number;
    } | null = null;

    for (const entry of this.semanticIndex) {
      const similarity = this.cosineSimilarity(embedding, entry.embedding);
      if (similarity > threshold) {
        if (!best || similarity > best.similarity) {
          best = { response: entry.response, query: entry.query, similarity };
        }
      }
    }

    return best;
  }

  /**
   * Retrieve cached response or null if not found
   */
  async get(query: string): Promise<{
    response: string;
    source: "exact" | "semantic" | "miss";
  } | null> {
    const start = Date.now();

    // Try exact match first
    const hash = this.hashQuery(query);
    if (this.exactCache.has(hash)) {
      const entry = this.exactCache.get(hash)!;
      this.stats.exactHits++;
      this.stats.responseTimes.push(Date.now() - start);
      return { response: entry.response, source: "exact" };
    }

    // Try semantic match
    const queryEmbed = await this.embed(query);
    const similar = this.findSimilar(queryEmbed, this.SIMILARITY_THRESHOLD);
    if (similar) {
      this.stats.semanticHits++;
      this.stats.totalSavings += similar.similarity * 100; // Rough estimate
      this.stats.responseTimes.push(Date.now() - start);
      return { response: similar.response, source: "semantic" };
    }

    this.stats.misses++;
    this.stats.responseTimes.push(Date.now() - start);
    return null;
  }

  /**
   * Store response in cache
   */
  async set(
    query: string,
    response: string,
    metadata: { tokens?: number; cost?: number } = {},
  ): Promise<void> {
    const hash = this.hashQuery(query);

    // Store in exact cache
    this.exactCache.set(hash, {
      response,
      timestamp: Date.now(),
      tokens: metadata.tokens,
      cost: metadata.cost,
    });

    // Store in semantic index (limited size)
    if (this.semanticIndex.length < this.MAX_SEMANTIC_INDEX_SIZE) {
      const embedding = await this.embed(query);
      this.semanticIndex.push({
        embedding,
        response,
        query,
        tokens: metadata.tokens || 0,
        cost: metadata.cost || 0,
      });
    }

    // Trim if cache too large
    if (this.exactCache.size > this.MAX_CACHE_SIZE) {
      this.pruneOldest();
    }
  }

  /**
   * Cache partial responses (common sub-responses)
   */
  cachePartial(key: string, value: string): void {
    this.partialCache.set(key, value);
  }

  /**
   * Retrieve partial response
   */
  getPartial(key: string): string | null {
    return this.partialCache.get(key) || null;
  }

  /**
   * Remove oldest entries when cache is full
   */
  private pruneOldest(): void {
    const entries = Array.from(this.exactCache.entries())
      .map(([hash, entry]) => ({ hash, entry }))
      .sort((a, b) => a.entry.timestamp - b.entry.timestamp);

    // Remove oldest 10%
    const toRemove = Math.ceil(entries.length * 0.1);
    for (let i = 0; i < toRemove; i++) {
      this.exactCache.delete(entries[i].hash);
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    const total =
      this.stats.exactHits + this.stats.semanticHits + this.stats.misses;
    const hitRate =
      total > 0 ? (this.stats.exactHits + this.stats.semanticHits) / total : 0;
    const avgTime =
      this.stats.responseTimes.length > 0
        ? this.stats.responseTimes.reduce((a, b) => a + b, 0) /
          this.stats.responseTimes.length
        : 0;

    return {
      exactHits: this.stats.exactHits,
      semanticHits: this.stats.semanticHits,
      misses: this.stats.misses,
      totalSavings: this.stats.totalSavings,
      hitRate,
      averageResponseTime: avgTime,
    };
  }

  /**
   * Clear all caches
   */
  clear(): void {
    this.exactCache.clear();
    this.semanticIndex = [];
    this.partialCache.clear();
    this.stats = {
      exactHits: 0,
      semanticHits: 0,
      misses: 0,
      totalSavings: 0,
      responseTimes: [],
    };
  }

  /**
   * Export cache statistics and diagnostics
   */
  exportStats() {
    return {
      cacheSize: this.exactCache.size,
      semanticIndexSize: this.semanticIndex.length,
      partialCacheSize: this.partialCache.size,
      stats: this.getStats(),
    };
  }
}

// Global cache instance
export const globalResponseCache = new SemanticResponseCache();
