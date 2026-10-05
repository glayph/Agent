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
 * Optional local ONNX embedding provider. The model is intentionally loaded
 * only when MIKI_EMBEDDING_PROVIDER=onnx and MIKI_ONNX_EMBEDDING_MODEL is set.
 *
 * Contract for the lightweight local router/index model:
 *  - input tensor: `input` or `features`, shape [1, dimensions], float32
 *  - output tensor: first output, flattened into a vector
 * The text is converted to a deterministic normalized feature vector before
 * inference. This keeps the provider dependency-optional and offline. A
 * semantic/text encoder with its own tokenizer can be wrapped with the same
 * interface later without changing callers.
 */
class OnnxEmbeddingProvider {
  /**
   * @param {{ modelPath?: string, dimensions?: number } | null} [options]
   */
  constructor(options = null) {
    const opts = options || {};
    this.modelPath = String(opts.modelPath || process.env.MIKI_ONNX_EMBEDDING_MODEL || '').trim();
    this.dimensions = Number(opts.dimensions || process.env.MIKI_EMBEDDING_DIMS || 384);
    this.name = 'onnx-local';
    this._sessionPromise = null;
  }

  _features(text) {
    const crypto = require('crypto');
    const input = String(text || '').normalize('NFKC').toLowerCase();
    const vec = new Float32Array(this.dimensions);
    const tokens = input.split(/\s+/).filter(Boolean);
    const grams = [];
    for (const token of tokens) {
      grams.push(token);
      for (let i = 0; i + 2 < token.length; i++) grams.push(token.slice(i, i + 3));
    }
    for (const gram of grams.length ? grams : ['']) {
      const digest = crypto.createHash('sha256').update(gram).digest();
      for (let offset = 0; offset < digest.length; offset += 4) {
        const bucket = digest.readUInt32BE(offset) % this.dimensions;
        const sign = (digest[offset] & 1) ? 1 : -1;
        vec[bucket] += sign;
      }
    }
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

  async _session() {
    if (!this.modelPath) throw new Error('MIKI_ONNX_EMBEDDING_MODEL is not configured.');
    if (this._sessionPromise) return this._sessionPromise;
    this._sessionPromise = (async () => {
      let ort;
      try {
        const load = Function('specifier', 'return import(specifier)');
        ort = await load('onnxruntime-node');
      } catch (error) {
        this._sessionPromise = null;
        throw new Error(`onnxruntime-node is not installed: ${error && error.message ? error.message : String(error)}`);
      }
      return ort.InferenceSession.create(this.modelPath, { executionProviders: ['cpu'] });
    })();
    return this._sessionPromise;
  }

  async embed(text) {
    const session = await this._session();
    const load = Function('specifier', 'return import(specifier)');
    const ort = await load('onnxruntime-node');
    const input = this._features(text);
    const name = session.inputNames.includes('input') ? 'input' : session.inputNames.includes('features') ? 'features' : session.inputNames[0];
    if (!name) throw new Error('ONNX embedding model exposes no input tensor.');
    const tensor = new ort.Tensor('float32', input, [1, this.dimensions]);
    const output = await session.run({ [name]: tensor });
    const first = output[session.outputNames[0]];
    const data = first?.data;
    if (!data || typeof data.length !== 'number') throw new Error('ONNX embedding model returned no vector.');
    const vec = Float32Array.from(data);
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return vec;
  }

  async embedBatch(texts) {
    const out = [];
    for (const text of texts || []) out.push(await this.embed(text));
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
 * @returns {HashEmbeddingProvider|NoopEmbeddingProvider|OnnxEmbeddingProvider}
 */
function createEmbeddingProvider(options = null) {
  const opts = options || {};
  const name = (opts.provider || process.env.MIKI_EMBEDDING_PROVIDER || 'hash').toLowerCase();
  const dimensions = opts.dimensions || Number(process.env.MIKI_EMBEDDING_DIMS) || 384;
  if (name === 'noop' || name === 'none' || name === 'off') {
    return new NoopEmbeddingProvider(dimensions);
  }
  if (name === 'onnx' || name === 'onnx-local') {
    return new OnnxEmbeddingProvider({
      modelPath: opts.modelPath || process.env.MIKI_ONNX_EMBEDDING_MODEL,
      dimensions,
    });
  }
  // Default offline foundation. Real semantic models plug in here later.
  return new HashEmbeddingProvider(dimensions);
}

module.exports = {
  HashEmbeddingProvider,
  NoopEmbeddingProvider,
  OnnxEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
};
