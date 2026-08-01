'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

/**
 * Intelligent text chunking engine for GraphRAG memory system.
 * Handles multiple chunking strategies, deduplication, hierarchies, and relationship maintenance.
 */
class ChunkEngine {
  constructor() {
    /** @type {Map<string, Object>} chunkId -> chunkObj */
    this.chunks = new Map();
    /** @type {Map<string, string>} hash -> chunkId */
    this.hashIndex = new Map();
    /** @type {Map<string, Set<string>>} sourceId -> Set(chunkIds) */
    this.sourceIndex = new Map();
    /** @type {Map<string, Set<string>>} parentId -> Set(chunkIds) */
    this.parentIndex = new Map();
  }

  /**
   * Compute SHA-256 hash of text
   * @param {string} text 
   * @returns {string} hex digest
   */
  hash(text) {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  /**
   * Check if text duplicate exists
   * @param {string} text 
   * @returns {boolean}
   */
  isDuplicate(text) {
    return this.hashIndex.has(this.hash(text));
  }

  /**
   * Add chunk to engine
   * @param {Object} chunk 
   */
  addChunk(chunk) {
    const chunkId = chunk.id || crypto.randomUUID();
    const cleanChunk = {
      id: chunkId,
      text: chunk.text,
      sourceId: chunk.sourceId || null,
      parentId: chunk.parentId || null,
      childIds: chunk.childIds || [],
      siblingIds: chunk.siblingIds || [],
      position: chunk.position || 0,
      hash: chunk.hash || this.hash(chunk.text),
      size: chunk.text.length,
      createdAt: chunk.createdAt || new Date().toISOString(),
      metadata: chunk.metadata || {}
    };

    this.chunks.set(chunkId, cleanChunk);
    this.hashIndex.set(cleanChunk.hash, chunkId);

    if (cleanChunk.sourceId) {
      if (!this.sourceIndex.has(cleanChunk.sourceId)) {
        this.sourceIndex.set(cleanChunk.sourceId, new Set());
      }
      this.sourceIndex.get(cleanChunk.sourceId).add(chunkId);
    }

    if (cleanChunk.parentId) {
      if (!this.parentIndex.has(cleanChunk.parentId)) {
        this.parentIndex.set(cleanChunk.parentId, new Set());
      }
      this.parentIndex.get(cleanChunk.parentId).add(chunkId);
    }

    return chunkId;
  }

  /**
   * Retrieve chunk by ID
   * @param {string} chunkId 
   * @returns {Object|null}
   */
  getChunk(chunkId) {
    return this.chunks.get(chunkId) || null;
  }

  /**
   * Get chunks by source
   * @param {string} sourceId 
   * @returns {Array<Object>}
   */
  getChunksBySource(sourceId) {
    const ids = this.sourceIndex.get(sourceId);
    if (!ids) return [];
    return Array.from(ids).map(id => this.chunks.get(id)).filter(Boolean);
  }

  /**
   * Get chunks by parent
   * @param {string} parentId 
   * @returns {Array<Object>}
   */
  getChunksByParent(parentId) {
    const ids = this.parentIndex.get(parentId);
    if (!ids) return [];
    return Array.from(ids).map(id => this.chunks.get(id)).filter(Boolean);
  }

  /**
   * Get sibling chunks
   * @param {string} chunkId 
   * @returns {Array<Object>}
   */
  getSiblings(chunkId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk || !chunk.parentId) return [];
    return this.getChunksByParent(chunk.parentId).filter(c => c.id !== chunkId);
  }

  /**
   * Remove chunk
   * @param {string} chunkId 
   */
  removeChunk(chunkId) {
    const chunk = this.chunks.get(chunkId);
    if (!chunk) return false;

    this.hashIndex.delete(chunk.hash);
    
    if (chunk.sourceId) {
      const sourceSet = this.sourceIndex.get(chunk.sourceId);
      if (sourceSet) {
        sourceSet.delete(chunkId);
        if (sourceSet.size === 0) this.sourceIndex.delete(chunk.sourceId);
      }
    }

    if (chunk.parentId) {
      const parentSet = this.parentIndex.get(chunk.parentId);
      if (parentSet) {
        parentSet.delete(chunkId);
        if (parentSet.size === 0) this.parentIndex.delete(chunk.parentId);
      }
    }

    this.chunks.delete(chunkId);
    return true;
  }

  /**
   * Fixed size character chunking with overlap
   * @param {string} text 
   * @param {number} size character size
   * @param {number} overlap character overlap
   * @returns {Array<string>}
   */
  chunkFixed(text, size = 512, overlap = 64) {
    if (!text) return [];
    if (text.length <= size) return [text];

    const result = [];
    let start = 0;
    while (start < text.length) {
      const chunk = text.slice(start, start + size);
      result.push(chunk);
      start += (size - overlap);
    }
    return result;
  }

  /**
   * Sentence boundary aware chunking
   * @param {string} text 
   * @param {number} maxSentences 
   * @returns {Array<string>}
   */
  chunkSentence(text, maxSentences = 5) {
    if (!text) return [];
    
    // Split sentences while avoiding common abbreviations
    const abbrevs = /\b(Mr|Mrs|Ms|Dr|Sr|Jr|St|Co|Inc|Ltd|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec|vs|etc|eg|ie|a\.m|p\.m)\.$/i;
    const rawSentences = text.split(/(?<=[.!?])\s+(?=[A-Z])/);
    
    const sentences = [];
    let buffer = '';
    
    for (const sent of rawSentences) {
      buffer += (buffer ? ' ' : '') + sent;
      const lastWord = sent.trim().split(/\s+/).pop();
      
      // If ends with abbreviation period, don't split yet
      if (lastWord && abbrevs.test(lastWord)) {
        continue;
      }
      
      sentences.push(buffer);
      buffer = '';
    }
    if (buffer) {
      sentences.push(buffer);
    }

    const chunks = [];
    for (let i = 0; i < sentences.length; i += maxSentences) {
      chunks.push(sentences.slice(i, i + maxSentences).join(' '));
    }
    return chunks;
  }

  /**
   * Paragraph boundary chunking
   * @param {string} text 
   * @returns {Array<string>}
   */
  chunkParagraph(text) {
    if (!text) return [];
    return text.split(/\n\s*\n+/).map(p => p.trim()).filter(p => p.length > 0);
  }

  /**
   * Hierarchical chunking based on document structures
   * @param {string} text 
   * @param {string} docId 
   * @returns {Array<Object>} list of chunk objects with hierarchy
   */
  chunkHierarchical(text, docId) {
    if (!text) return [];
    
    const lines = text.split('\n');
    const result = [];
    let currentSectionId = null;
    let sectionText = '';
    let sectionTitle = 'Root';
    let pos = 0;

    const saveCurrentSection = () => {
      if (sectionText.trim()) {
        const sectId = crypto.randomUUID();
        const sentences = this.chunkSentence(sectionText, 3);
        const childIds = [];

        sentences.forEach((sentText, idx) => {
          const childId = crypto.randomUUID();
          childIds.push(childId);
          result.push({
            id: childId,
            text: sentText,
            sourceId: docId,
            parentId: sectId,
            position: idx,
            metadata: { type: 'sentence', sectionTitle }
          });
        });

        result.push({
          id: sectId,
          text: sectionText.trim(),
          sourceId: docId,
          parentId: null,
          childIds: childIds,
          position: pos++,
          metadata: { type: 'section', title: sectionTitle }
        });
      }
    };

    for (const line of lines) {
      const isHeader = /^#{1,6}\s+(.+)$/.exec(line) || /^[A-Z][A-Z\s]{3,}$/.exec(line);
      if (isHeader) {
        saveCurrentSection();
        sectionTitle = isHeader[1] ? isHeader[1].trim() : line.trim();
        sectionText = '';
      } else {
        sectionText += line + '\n';
      }
    }
    saveCurrentSection();

    // Link sibling chunks
    const sections = result.filter(c => c.metadata.type === 'section');
    sections.forEach((sect, idx) => {
      sect.siblingIds = sections.filter((_, sidx) => sidx !== idx).map(s => s.id);
    });

    return result;
  }

  /**
   * Semantic topic shift aware chunking via Jaccard keyword density shifts
   * @param {string} text 
   * @param {number} maxChunkSize 
   * @returns {Array<string>}
   */
  chunkSemantic(text, maxChunkSize = 1024) {
    const paragraphs = this.chunkParagraph(text);
    if (paragraphs.length <= 1) return paragraphs;

    const getKeywords = (txt) => {
      return new Set(txt.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 4));
    };

    const jaccard = (setA, setB) => {
      if (setA.size === 0 || setB.size === 0) return 0;
      let intersection = 0;
      for (const val of setA) {
        if (setB.has(val)) intersection++;
      }
      return intersection / (setA.size + setB.size - intersection);
    };

    const chunks = [];
    let currentChunk = paragraphs[0];

    for (let i = 1; i < paragraphs.length; i++) {
      const nextPara = paragraphs[i];
      const keywordsA = getKeywords(currentChunk);
      const keywordsB = getKeywords(nextPara);
      const sim = jaccard(keywordsA, keywordsB);

      // If low semantic similarity or too large, split
      if (sim < 0.3 || (currentChunk.length + nextPara.length > maxChunkSize)) {
        chunks.push(currentChunk);
        currentChunk = nextPara;
      } else {
        currentChunk += '\n\n' + nextPara;
      }
    }
    chunks.push(currentChunk);
    return chunks;
  }

  /**
   * Smart auto-select chunking strategy
   * @param {string} text 
   * @param {Object} options 
   */
  chunk(text, options = {}) {
    const strategy = options.strategy || 'auto';
    const docId = options.docId || crypto.randomUUID();

    if (strategy === 'fixed') {
      return this.chunkFixed(text, options.size, options.overlap).map((t, idx) => ({
        id: crypto.randomUUID(),
        text: t,
        sourceId: docId,
        position: idx,
        metadata: { strategy: 'fixed' }
      }));
    }
    
    if (strategy === 'sentence') {
      return this.chunkSentence(text, options.maxSentences).map((t, idx) => ({
        id: crypto.randomUUID(),
        text: t,
        sourceId: docId,
        position: idx,
        metadata: { strategy: 'sentence' }
      }));
    }

    if (strategy === 'paragraph') {
      return this.chunkParagraph(text).map((t, idx) => ({
        id: crypto.randomUUID(),
        text: t,
        sourceId: docId,
        position: idx,
        metadata: { strategy: 'paragraph' }
      }));
    }

    if (strategy === 'hierarchical') {
      return this.chunkHierarchical(text, docId);
    }

    if (strategy === 'semantic') {
      return this.chunkSemantic(text, options.maxChunkSize).map((t, idx) => ({
        id: crypto.randomUUID(),
        text: t,
        sourceId: docId,
        position: idx,
        metadata: { strategy: 'semantic' }
      }));
    }

    // Auto strategy selector
    if (text.length < 300) {
      return [{
        id: crypto.randomUUID(),
        text: text,
        sourceId: docId,
        position: 0,
        metadata: { strategy: 'single' }
      }];
    }

    // Has markdown header structure
    if (/^#{1,6}\s+/m.test(text)) {
      return this.chunkHierarchical(text, docId);
    }

    // Default to semantic
    return this.chunkSemantic(text, options.maxChunkSize || 1024).map((t, idx) => ({
      id: crypto.randomUUID(),
      text: t,
      sourceId: docId,
      position: idx,
      metadata: { strategy: 'auto-semantic' }
    }));
  }

  /**
   * Remove duplicates and return count removed
   */
  deduplicate() {
    let removed = 0;
    const hashes = new Map(); // hash -> chunkId
    
    for (const [id, chunk] of this.chunks.entries()) {
      if (hashes.has(chunk.hash)) {
        this.removeChunk(id);
        removed++;
      } else {
        hashes.set(chunk.hash, id);
      }
    }
    return removed;
  }

  /**
   * Link child nodes to parent
   * @param {string} parentId 
   * @param {Array<string>} childIds 
   */
  linkChunks(parentId, childIds) {
    const parent = this.chunks.get(parentId);
    if (!parent) return;

    parent.childIds = Array.from(new Set([...parent.childIds, ...childIds]));
    
    childIds.forEach(childId => {
      const child = this.chunks.get(childId);
      if (child) {
        child.parentId = parentId;
        if (!this.parentIndex.has(parentId)) {
          this.parentIndex.set(parentId, new Set());
        }
        this.parentIndex.get(parentId).add(childId);
      }
    });
  }

  /**
   * Get hierarchy tree under rootId
   * @param {string} rootId 
   * @returns {Object}
   */
  getHierarchy(rootId) {
    const root = this.chunks.get(rootId);
    if (!root) return null;

    const buildTree = (node) => {
      return {
        id: node.id,
        text: node.text,
        metadata: node.metadata,
        children: node.childIds.map(cid => this.chunks.get(cid)).filter(Boolean).map(buildTree)
      };
    };

    return buildTree(root);
  }

  /**
   * Save chunks data to file
   * @param {string} filePath 
   */
  async save(filePath) {
    const data = Array.from(this.chunks.values());
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  /**
   * Load chunks data from file
   * @param {string} filePath 
   */
  async load(filePath) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      const list = JSON.parse(content);
      
      this.chunks.clear();
      this.hashIndex.clear();
      this.sourceIndex.clear();
      this.parentIndex.clear();

      for (const item of list) {
        this.addChunk(item);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  /**
   * Get engine stats
   */
  getStats() {
    const total = this.chunks.size;
    let totalLen = 0;
    let minSize = total ? Infinity : 0;
    let maxSize = 0;

    for (const chunk of this.chunks.values()) {
      const len = chunk.size;
      totalLen += len;
      if (len < minSize) minSize = len;
      if (len > maxSize) maxSize = len;
    }

    return {
      totalChunks: total,
      avgSize: total ? Math.round(totalLen / total) : 0,
      minSize: minSize === Infinity ? 0 : minSize,
      maxSize: maxSize,
      duplicateRate: 0, // recalculated during optimization
      sourceCount: this.sourceIndex.size
    };
  }
}

module.exports = ChunkEngine;
