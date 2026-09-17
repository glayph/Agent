'use strict';

/**
 * Pluggable embedding provider foundation for @miki/memory.
 *
 * Offline-first by design: the default HashEmbeddingProvider needs no
 * network, no model download, and no native deps beyond Node crypto.
 * A future Xenova / local ONNX provider can implement the same surface
 * without changing callers.
 *
 * Interface (duck-typed):
 *   async embed(text: string): Promise<Float32Array | number[]>
 *   async embedBatch(texts: string[]): Promise<Array<Float32Array | number[]>>
 *   readonly dimensions: number
 *   readonly name: string
 */

/**
 * Deterministic, offline hash embedding. Not semantic — only useful as a
 * stable vector shape for plumbing tests and as a drop-in until a real
 * local model is configured. Same text → same vector.
 */
class HashEmbeddingProvider {
  /**
   * @param {number} [dimensions=384]
   */
  constructor(dimensions = 384) {
    this.dimensions = dimensions;
    this.name = 'hash-offline';
  }

  /**
   * @param {string} text
   * @returns {Promise<Float32Array>}
   */
  async embed(text) {
    const crypto = require('crypto');
    const input = String(text || '');
    const vec = new Float32Array(this.dimensions);
    // Mix multiple digests so we fill the full dimension vector.
    let seed = input;
    let offset = 0;
    while (offset < this.dimensions) {
      const digest = crypto.createHash('sha256').update(seed).digest();
      for (let i = 0; i < digest.length && offset < this.dimensions; i += 4) {
        // Map 4 bytes to a float in [-1, 1]
        const u = digest.readUInt32BE(i);
        vec[offset++] = (u / 0xffffffff) * 2 - 1;
      }
      seed = digest.toString('hex') + seed;
    }
    // L2 normalize for cosine-friendly comparisons.
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

  /**
   * @param {string[]} texts
   * @returns {Promise<Float32Array[]>}
   */
  async embedBatch(texts) {
    const out = [];
    for (const t of texts || []) {
      out.push(await this.embed(t));
    }
    return out;
  }
}

/**
 * Explicit no-op provider. embed() returns a zero vector of the configured
 * dimension. Useful when embeddings are intentionally disabled.
 */
class NoopEmbeddingProvider {
  constructor(dimensions = 384) {
    this.dimensions = dimensions;
    this.name = 'noop';
  }

  async embed(_text) {
    return new Float32Array(this.dimensions);
  }

  async embedBatch(texts) {
    return (texts || []).map(() => new Float32Array(this.dimensions));
  }
}

/**
 * Cosine similarity between two equal-length vectors.
 * @param {ArrayLike<number>} a
 * @param {ArrayLike<number>} b
 * @returns {number}
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Resolve provider from options or env.
 * MIKI_EMBEDDING_PROVIDER=hash|noop (default hash).
 * Future: xenova / openai-compatible local servers.
 *
 * @param {{ provider?: string, dimensions?: number } | null} [options]
 * @returns {HashEmbeddingProvider|NoopEmbeddingProvider}
 */
function createEmbeddingProvider(options = null) {
  const opts = options || {};
  const name = (opts.provider || process.env.MIKI_EMBEDDING_PROVIDER || 'hash').toLowerCase();
  const dimensions = opts.dimensions || Number(process.env.MIKI_EMBEDDING_DIMS) || 384;
  if (name === 'noop' || name === 'none' || name === 'off') {
    return new NoopEmbeddingProvider(dimensions);
  }
  // Default offline foundation. Real model providers plug in here later.
  return new HashEmbeddingProvider(dimensions);
}

module.exports = {
  HashEmbeddingProvider,
  NoopEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
};
