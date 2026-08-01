'use strict';

const fs = require('fs').promises;
const path = require('path');

/**
 * Pure JavaScript TF-IDF and BM25 hybrid search engine.
 * Requires no external dependencies. Includes custom tokenization, stop word filtering, and simple stemming.
 */
class VectorIndex {
  constructor() {
    /** @type {Map<string, Object>} docId -> docObj */
    this.documents = new Map();
    /** @type {Map<string, Map<string, number>>} term -> docId -> frequency */
    this.invertedIndex = new Map();
    /** @type {Map<string, number>} term -> docCount */
    this.documentFrequency = new Map();
    /** @type {Set<string>} */
    this.vocabulary = new Set();
    /** @type {number} */
    this.avgDocLength = 0;

    // Comprehensive list of common English stop words
    this.stopwords = new Set([
      'a', 'about', 'above', 'after', 'again', 'against', 'all', 'am', 'an', 'and', 'any', 'are', 'arent', 'as', 'at',
      'be', 'because', 'been', 'before', 'being', 'below', 'between', 'both', 'but', 'by', 'cant', 'cannot', 'could',
      'couldnt', 'did', 'didnt', 'do', 'does', 'doesnt', 'doing', 'dont', 'down', 'during', 'each', 'few', 'for', 'from',
      'further', 'had', 'hadnt', 'has', 'hasnt', 'have', 'havent', 'having', 'he', 'hed', 'hell', 'hes', 'her', 'here',
      'heres', 'hers', 'herself', 'him', 'himself', 'his', 'how', 'hows', 'i', 'id', 'ill', 'im', 'ive', 'if', 'in',
      'into', 'is', 'isnt', 'it', 'its', 'itself', 'lets', 'me', 'more', 'most', 'mustnt', 'my', 'myself', 'no', 'nor',
      'not', 'of', 'off', 'on', 'once', 'only', 'or', 'other', 'ought', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
      'same', 'shant', 'she', 'shed', 'shell', 'shes', 'should', 'shouldnt', 'so', 'some', 'such', 'than', 'that',
      'thats', 'the', 'their', 'theirs', 'them', 'themselves', 'then', 'there', 'theres', 'these', 'they', 'theyd',
      'theyll', 'theyre', 'theyve', 'this', 'those', 'through', 'to', 'too', 'under', 'until', 'up', 'very', 'was',
      'wasnt', 'we', 'wed', 'well', 'were', 'weve', 'werent', 'what', 'whats', 'when', 'whens', 'where', 'wheres',
      'which', 'while', 'who', 'whos', 'whom', 'why', 'whys', 'with', 'wont', 'would', 'wouldnt', 'you', 'youd',
      'youll', 'youre', 'youve', 'your', 'yours', 'yourself', 'yourselves'
    ]);
  }

  /**
   * Approximate Porter stemmer for word normalization
   * @param {string} word 
   * @returns {string}
   */
  stem(word) {
    let w = word.toLowerCase().trim();
    if (w.length < 3) return w;

    // Plural forms
    if (w.endsWith('sses')) w = w.slice(0, -2);
    else if (w.endsWith('ies')) w = w.slice(0, -3) + 'y';
    else if (w.endsWith('ss')) {} // do nothing
    else if (w.endsWith('s') && !w.endsWith('us') && !w.endsWith('as') && !w.endsWith('is')) w = w.slice(0, -1);

    // Common suffixes
    if (w.endsWith('eed')) {
      if (w.length > 5) w = w.slice(0, -1); // agreed -> agree
    } else if (w.endsWith('ing')) {
      w = w.slice(0, -3);
      if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) {
        w += 'e';
      } else if (/(.)\1$/.test(w) && !/[lsz]/.test(w[w.length - 1])) {
        w = w.slice(0, -1);
      }
    } else if (w.endsWith('ed')) {
      w = w.slice(0, -2);
      if (w.endsWith('at') || w.endsWith('bl') || w.endsWith('iz')) {
        w += 'e';
      } else if (/(.)\1$/.test(w) && !/[lsz]/.test(w[w.length - 1])) {
        w = w.slice(0, -1);
      }
    }

    // Y replacement
    if (w.endsWith('y') && w.length > 3) {
      const vowels = /[aeiou]/;
      if (vowels.test(w.slice(0, -1))) {
        // keep y if it follows vowel, otherwise replacement can occur
      }
    }

    // Suffix stripping
    if (w.endsWith('ization')) w = w.slice(0, -7);
    else if (w.endsWith('tional')) w = w.slice(0, -6) + 'tion';
    else if (w.endsWith('biliti')) w = w.slice(0, -5) + 'ble';
    else if (w.endsWith('alli')) w = w.slice(0, -2);
    else if (w.endsWith('entli')) w = w.slice(0, -2);
    else if (w.endsWith('eli')) w = w.slice(0, -2);
    else if (w.endsWith('ousli')) w = w.slice(0, -2);
    else if (w.endsWith('alism')) w = w.slice(0, -3);
    else if (w.endsWith('ation')) w = w.slice(0, -5) + 'ate';
    else if (w.endsWith('aliti')) w = w.slice(0, -3);
    else if (w.endsWith('iviti')) w = w.slice(0, -5) + 'ive';
    else if (w.endsWith('fulness')) w = w.slice(0, -4);
    else if (w.endsWith('ousness')) w = w.slice(0, -4);
    else if (w.endsWith('ment')) w = w.slice(0, -4);
    else if (w.endsWith('ness')) w = w.slice(0, -4);

    return w;
  }

  /**
   * Tokenize text: lowercase, remove punctuation, split, remove stopwords, stem
   * @param {string} text 
   * @returns {Array<string>} list of stemmed tokens
   */
  tokenize(text) {
    if (!text) return [];
    const rawTokens = text.toLowerCase()
      .replace(/[^\w\s-]/g, ' ') // replace punctuation with spaces
      .split(/[\s_]+/)
      .filter(t => t.length > 0);

    const filtered = rawTokens.filter(t => !this.stopwords.has(t));
    return filtered.map(t => this.stem(t)).filter(t => t.length > 0);
  }

  /**
   * Add doc to index
   * @param {string} docId 
   * @param {string} text 
   * @param {Object} metadata 
   */
  addDocument(docId, text, metadata = {}) {
    if (!text) return;
    
    // Remove if already exists
    if (this.documents.has(docId)) {
      this.removeDocument(docId);
    }

    const tokens = this.tokenize(text);
    const docLen = tokens.length;

    const termFreq = new Map();
    for (const t of tokens) {
      termFreq.set(t, (termFreq.get(t) || 0) + 1);
      this.vocabulary.add(t);
    }

    // Update inverted index and document frequencies
    for (const [term, freq] of termFreq.entries()) {
      if (!this.invertedIndex.has(term)) {
        this.invertedIndex.set(term, new Map());
      }
      this.invertedIndex.get(term).set(docId, freq);
      this.documentFrequency.set(term, (this.documentFrequency.get(term) || 0) + 1);
    }

    this.documents.set(docId, {
      id: docId,
      text,
      tokens,
      termFreq,
      length: docLen,
      metadata,
      vector: null // built lazily on search
    });

    this.recalculateAverageDocLength();
  }

  /**
   * Remove document from index
   * @param {string} docId 
   */
  removeDocument(docId) {
    const doc = this.documents.get(docId);
    if (!doc) return;

    for (const term of doc.termFreq.keys()) {
      const termMap = this.invertedIndex.get(term);
      if (termMap) {
        termMap.delete(docId);
        if (termMap.size === 0) {
          this.invertedIndex.delete(term);
          this.vocabulary.delete(term);
        }
      }
      
      const df = this.documentFrequency.get(term);
      if (df !== undefined) {
        if (df <= 1) {
          this.documentFrequency.delete(term);
        } else {
          this.documentFrequency.set(term, df - 1);
        }
      }
    }

    this.documents.delete(docId);
    this.recalculateAverageDocLength();
  }

  /**
   * Update document
   * @param {string} docId 
   * @param {string} text 
   * @param {Object} metadata 
   */
  updateDocument(docId, text, metadata = {}) {
    this.addDocument(docId, text, metadata);
  }

  /**
   * Recalculate average document length in the corpus
   */
  recalculateAverageDocLength() {
    const N = this.documents.size;
    if (N === 0) {
      this.avgDocLength = 0;
      return;
    }
    let totalLen = 0;
    for (const doc of this.documents.values()) {
      totalLen += doc.length;
    }
    this.avgDocLength = totalLen / N;
  }

  /**
   * Get term frequency for a document
   * @param {string} term 
   * @param {string} docId 
   */
  getTermFrequency(term, docId) {
    const doc = this.documents.get(docId);
    if (!doc) return 0;
    return doc.termFreq.get(term) || 0;
  }

  /**
   * Calculate inverse document frequency for term
   * @param {string} term 
   * @returns {number}
   */
  getInverseDocumentFrequency(term) {
    const N = this.documents.size;
    const df = this.documentFrequency.get(term) || 0;
    // Smoothed IDF
    return Math.log((N - df + 0.5) / (df + 0.5) + 1);
  }

  /**
   * Compute TF-IDF sparse vector for a document
   * @param {string} docId 
   * @returns {Map<string, number>}
   */
  computeTFIDF(docId) {
    const doc = this.documents.get(docId);
    if (!doc) return new Map();
    if (doc.vector) return doc.vector;

    const vec = new Map();
    for (const [term, freq] of doc.termFreq.entries()) {
      const tf = freq / doc.length;
      const idf = this.getInverseDocumentFrequency(term);
      vec.set(term, tf * idf);
    }
    doc.vector = vec;
    return vec;
  }

  /**
   * Compute cosine similarity between two sparse vectors
   * @param {Map<string, number>} vecA 
   * @param {Map<string, number>} vecB 
   * @returns {number} similarity score [0, 1]
   */
  cosineSimilarity(vecA, vecB) {
    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (const [term, val] of vecA.entries()) {
      magA += val * val;
      if (vecB.has(term)) {
        dot += val * vecB.get(term);
      }
    }

    for (const val of vecB.values()) {
      magB += val * val;
    }

    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  /**
   * Perform TF-IDF Cosine similarity search
   * @param {string} query 
   * @param {number} topK 
   */
  searchSimilar(query, topK = 10) {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0 || this.documents.size === 0) return [];

    // Build query vector
    const queryFreq = new Map();
    for (const t of queryTokens) {
      queryFreq.set(t, (queryFreq.get(t) || 0) + 1);
    }
    
    const queryVec = new Map();
    for (const [term, freq] of queryFreq.entries()) {
      const tf = freq / queryTokens.length;
      const idf = this.getInverseDocumentFrequency(term);
      queryVec.set(term, tf * idf);
    }

    const results = [];
    for (const [docId, doc] of this.documents.entries()) {
      const docVec = this.computeTFIDF(docId);
      const score = this.cosineSimilarity(queryVec, docVec);
      if (score > 0) {
        results.push({ docId, score, text: doc.text, metadata: doc.metadata });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * Perform BM25 ranking search
   * @param {string} query 
   * @param {number} topK 
   * @returns {Array<Object>}
   */
  searchBM25(query, topK = 10) {
    const queryTokens = this.tokenize(query);
    if (queryTokens.length === 0 || this.documents.size === 0) return [];

    const k1 = 1.5;
    const b = 0.75;
    const scores = new Map(); // docId -> score

    for (const term of queryTokens) {
      const idf = this.getInverseDocumentFrequency(term);
      const postMap = this.invertedIndex.get(term);
      if (!postMap) continue;

      for (const [docId, freq] of postMap.entries()) {
        const doc = this.documents.get(docId);
        const dl = doc.length;
        const score = idf * (freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (dl / (this.avgDocLength || 1))));
        scores.set(docId, (scores.get(docId) || 0) + score);
      }
    }

    const results = [];
    for (const [docId, score] of scores.entries()) {
      const doc = this.documents.get(docId);
      results.push({ docId, score, text: doc.text, metadata: doc.metadata });
    }

    // Min-Max normalize BM25 scores to [0,1] range for integration
    if (results.length > 0) {
      const maxScore = Math.max(...results.map(r => r.score));
      if (maxScore > 0) {
        results.forEach(r => r.score = r.score / maxScore);
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * Combined Hybrid Search (Vector + BM25)
   * @param {string} query 
   * @param {Object} options 
   */
  searchHybrid(query, options = {}) {
    const topK = options.topK || 10;
    const weights = options.weights || { vector: 0.5, bm25: 0.5 };
    
    const vecResults = this.searchSimilar(query, this.documents.size);
    const bm25Results = this.searchBM25(query, this.documents.size);

    const scores = new Map(); // docId -> { vectorScore, bm25Score }

    vecResults.forEach(r => {
      scores.set(r.docId, { docId: r.docId, text: r.text, metadata: r.metadata, vectorScore: r.score, bm25Score: 0 });
    });

    bm25Results.forEach(r => {
      const existing = scores.get(r.docId);
      if (existing) {
        existing.bm25Score = r.score;
      } else {
        scores.set(r.docId, { docId: r.docId, text: r.text, metadata: r.metadata, vectorScore: 0, bm25Score: r.score });
      }
    });

    const hybridResults = [];
    for (const entry of scores.values()) {
      const finalScore = (entry.vectorScore * weights.vector) + (entry.bm25Score * weights.bm25);
      if (finalScore > 0) {
        hybridResults.push({
          docId: entry.docId,
          score: finalScore,
          text: entry.text,
          metadata: entry.metadata,
          breakdown: {
            vectorScore: entry.vectorScore,
            bm25Score: entry.bm25Score
          }
        });
      }
    }

    return hybridResults.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * Save index data to file
   * @param {string} filePath 
   */
  async save(filePath) {
    const docs = Array.from(this.documents.values()).map(doc => ({
      id: doc.id,
      text: doc.text,
      metadata: doc.metadata
    }));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(docs, null, 2), 'utf8');
  }

  /**
   * Load index data from file
   * @param {string} filePath 
   */
  async load(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const docs = JSON.parse(content);
      
      this.documents.clear();
      this.invertedIndex.clear();
      this.documentFrequency.clear();
      this.vocabulary.clear();
      this.avgDocLength = 0;

      for (const doc of docs) {
        this.addDocument(doc.id, doc.text, doc.metadata);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /**
   * Get index stats
   */
  getStats() {
    let totalLen = 0;
    for (const doc of this.documents.values()) {
      totalLen += doc.length;
    }

    return {
      documentCount: this.documents.size,
      vocabularySize: this.vocabulary.size,
      avgDocLength: this.documents.size ? Math.round(this.avgDocLength * 10) / 10 : 0,
      totalTokens: totalLen
    };
  }
}

module.exports = VectorIndex;
