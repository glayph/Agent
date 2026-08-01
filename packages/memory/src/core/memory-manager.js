'use strict';

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const GraphStore = require('./graph-store');
const TemporalEngine = require('./temporal-engine');
const ChunkEngine = require('./chunk-engine');
const VectorIndex = require('./vector-index');
const Optimizer = require('./optimizer');

/**
 * MemoryManager - Unified orchestration layer for the GraphRAG memory system.
 * Handles episodic/semantic/procedural memory storage, retrieval, hybrid search, context assembly, and events.
 */
class MemoryManager {
  /**
   * @param {Object} config 
   */
  constructor(config = {}) {
    this.config = Object.assign({
      port: 3777,
      host: 'localhost',
      dataDir: './data',
      backupDir: './data/backups',
      autoSaveIntervalMs: 60000,
      maxBackups: 5,
      decayHalfLifeHours: 168,
      defaultValidityDays: 365,
      pruneAfterDays: 90,
      defaultChunkStrategy: 'semantic',
      maxChunkSize: 1024,
      chunkOverlap: 64,
      searchWeights: { vector: 0.4, bm25: 0.3, graph: 0.2, temporal: 0.1 },
      defaultTopK: 10,
      communityDetectionIterations: 10,
      maxTraversalDepth: 5,
      duplicateThreshold: 0.85,
      minAccessCountForRetention: 3,
      logLevel: 'info'
    }, config);

    this.graph = new GraphStore();
    this.temporal = new TemporalEngine();
    this.chunks = new ChunkEngine();
    this.vector = new VectorIndex();
    this.optimizer = new Optimizer(this.graph, this.temporal, this.chunks, this.vector);

    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
    this.autoSaveTimer = null;
    this.initialized = false;
    this.dataDir = null;
  }

  /**
   * Register event handler
   * @param {string} event 
   * @param {Function} handler 
   */
  on(event, handler) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(handler);
  }

  /**
   * Remove event handler
   * @param {string} event 
   * @param {Function} handler 
   */
  off(event, handler) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(handler);
    }
  }

  /**
   * Emit event to listeners
   * @param {string} event 
   * @param {Object} data 
   */
  emit(event, data) {
    const handlers = this.listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(data);
        } catch (err) {
          console.error(`[Event Error] Error in handler for event "${event}":`, err.message);
        }
      }
    }
  }

  /**
   * Initialize all stores and load from directory
   * @param {string} dataDir 
   */
  async initialize(dataDir) {
    if (this.initialized) return;
    this.dataDir = path.resolve(dataDir);
    await fs.mkdir(this.dataDir, { recursive: true });

    // Load persisted files
    await this.graph.load(path.join(this.dataDir, 'graph.json'));
    await this.temporal.load(path.join(this.dataDir, 'temporal.json'));
    await this.chunks.load(path.join(this.dataDir, 'chunks.json'));
    await this.vector.load(path.join(this.dataDir, 'vector-index.json'));

    // Start auto-save loop
    if (this.config.autoSaveIntervalMs > 0) {
      this.autoSaveTimer = setInterval(() => {
        this.save().catch(err => console.error('[AutoSave Error]', err.message));
      }, this.config.autoSaveIntervalMs);
    }

    this.initialized = true;
  }

  /**
   * Shutdown manager, saving state
   */
  async shutdown() {
    if (this.autoSaveTimer) {
      clearInterval(this.autoSaveTimer);
      this.autoSaveTimer = null;
    }
    await this.save();
    this.initialized = false;
  }

  /**
   * Add entity node manually to knowledge graph
   */
  async addEntity(name, type = 'entity', attributes = {}) {
    const id = name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
    this.graph.addNode(id, type, { label: name, ...attributes });
    this.vector.addDocument(id, `${name} ${type} ${JSON.stringify(attributes)}`, { type: 'entity' });
    return id;
  }

  /**
   * Add relationship edge
   */
  async addRelation(entityIdA, entityIdB, relationType, metadata = {}) {
    this.graph.addEdge(entityIdA, entityIdB, relationType, 1.0, metadata);
  }

  /**
   * Extract potential entity names from raw text
   * Simple heuristics looking for capitalized word phrases (excluding sentence starts)
   * @param {string} text 
   * @returns {Array<string>} list of entity names
   */
  extractEntities(text) {
    if (!text) return [];
    const entities = new Set();
    
    // Simple regex searching for capitalized words/phrases
    const matches = text.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
    if (matches) {
      for (const name of matches) {
        if (name.length > 3) {
          entities.add(name);
        }
      }
    }
    return Array.from(entities);
  }

  /**
   * Store a memory block, run chunking, create graph entities, build indexes
   * @param {string} content 
   * @param {Object} metadata 
   */
  async store(content, metadata = {}) {
    if (!this.initialized) throw new Error('MemoryManager not initialized');

    const memoryId = crypto.randomUUID();
    const cleanContent = this.optimizer.normalizeText(content);

    // 1. Setup metadata & options
    const category = metadata.category || 'general';
    const sourceId = metadata.source || 'agent';

    // 2. Run smart chunking
    const chunkList = this.chunks.chunk(cleanContent, {
      docId: memoryId,
      strategy: this.config.defaultChunkStrategy,
      maxChunkSize: this.config.maxChunkSize,
      overlap: this.config.chunkOverlap
    });

    // 3. Register chunks in engine and vector indexes
    const chunkIds = [];
    for (const ch of chunkList) {
      // Avoid exact duplicates
      if (this.chunks.isDuplicate(ch.text)) {
        const existingId = this.chunks.hashIndex.get(this.chunks.hash(ch.text));
        chunkIds.push(existingId);
        continue;
      }
      const chId = this.chunks.addChunk(ch);
      this.vector.addDocument(chId, ch.text, { type: 'chunk', memoryId });
      chunkIds.push(chId);
    }

    // 4. Create primary Memory Node in graph
    this.graph.addNode(memoryId, 'memory', {
      label: `Memory: ${category} (${new Date().toLocaleDateString()})`,
      content: cleanContent,
      category,
      sourceId,
      chunkIds,
      tags: metadata.tags || []
    });

    // 5. Build Temporal record
    const validUntil = new Date();
    validUntil.setDate(validUntil.getDate() + this.config.defaultValidityDays);
    this.temporal.records.set(memoryId, {
      validFrom: new Date().toISOString(),
      validUntil: validUntil.toISOString(),
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      accessCount: 1,
      supersededBy: null
    });

    // 6. Index full memory context
    this.vector.addDocument(memoryId, cleanContent, { type: 'memory', category, sourceId });

    // 7. GraphRAG Entity Extraction and association link
    const extracted = this.extractEntities(cleanContent);
    const entityIds = [];
    for (const entName of extracted) {
      const entId = await this.addEntity(entName, 'entity', { source: 'auto-extracted' });
      entityIds.push(entId);
      // Link Memory Node to extracted entities
      this.graph.addEdge(memoryId, entId, 'references', 1.0, { origin: 'extraction' });
    }

    // Link mutual connections between entities in the same text
    for (let i = 0; i < entityIds.length; i++) {
      for (let j = i + 1; j < entityIds.length; j++) {
        this.graph.addEdge(entityIds[i], entityIds[j], 'relates_to', 0.5, { cooccurrence: true });
      }
    }

    this.emit('memory:stored', { id: memoryId, content: cleanContent, category });
    return memoryId;
  }

  /**
   * Retrieve full memory item
   * @param {string} memoryId 
   */
  async retrieve(memoryId) {
    if (!this.initialized) throw new Error('MemoryManager not initialized');

    const node = this.graph.getNode(memoryId);
    if (!node) return null;

    // Log temporal interactions
    this.temporal.recordAccess(memoryId);
    node.accessCount = this.temporal.records.get(memoryId).accessCount;
    node.lastAccessed = this.temporal.records.get(memoryId).lastAccessed;

    const chunks = this.chunks.getChunksBySource(memoryId);
    const related = this.graph.getNeighbors(memoryId, 1);

    const fullObj = {
      ...node,
      temporal: this.temporal.records.get(memoryId),
      chunks: chunks.map(c => ({ id: c.id, text: c.text, position: c.position })),
      relatedEntities: related.filter(r => r.node.type === 'entity').map(r => r.node.data.label)
    };

    this.emit('memory:retrieved', fullObj);
    return fullObj;
  }

  /**
   * Update memory item contents
   */
  async update(memoryId, content, metadata = {}) {
    if (!this.initialized) throw new Error('MemoryManager not initialized');

    const node = this.graph.getNode(memoryId);
    if (!node) throw new Error('Memory not found');

    // 1. Remove old sub-chunks from index and registry
    const oldChunks = this.chunks.getChunksBySource(memoryId);
    for (const c of oldChunks) {
      this.chunks.removeChunk(c.id);
      this.vector.removeDocument(c.id);
    }

    // 2. Normalization & re-chunking
    const cleanContent = this.optimizer.normalizeText(content);
    const chunkList = this.chunks.chunk(cleanContent, {
      docId: memoryId,
      strategy: this.config.defaultChunkStrategy,
      maxChunkSize: this.config.maxChunkSize,
      overlap: this.config.chunkOverlap
    });

    const chunkIds = [];
    for (const ch of chunkList) {
      const chId = this.chunks.addChunk(ch);
      this.vector.addDocument(chId, ch.text, { type: 'chunk', memoryId });
      chunkIds.push(chId);
    }

    // 3. Update primary node
    node.data.content = cleanContent;
    node.data.chunkIds = chunkIds;
    node.data.category = metadata.category || node.data.category;
    node.data.tags = metadata.tags || node.data.tags;
    node.updatedAt = new Date().toISOString();

    // 4. Update core document search embedding text
    this.vector.addDocument(memoryId, cleanContent, { type: 'memory', category: node.data.category });

    // 5. Recalculate associations
    const extracted = this.extractEntities(cleanContent);
    for (const entName of extracted) {
      const entId = await this.addEntity(entName, 'entity', { source: 'auto-extracted' });
      this.graph.addEdge(memoryId, entId, 'references', 1.0, { origin: 'extraction' });
    }

    this.emit('memory:updated', { id: memoryId, content: cleanContent });
  }

  /**
   * Remove memory completely from all sub-engines
   * @param {string} memoryId 
   */
  async remove(memoryId) {
    if (!this.initialized) throw new Error('MemoryManager not initialized');

    const node = this.graph.getNode(memoryId);
    if (!node) return false;

    // Delete chunks
    const relatedChunks = this.chunks.getChunksBySource(memoryId);
    for (const c of relatedChunks) {
      this.chunks.removeChunk(c.id);
      this.vector.removeDocument(c.id);
    }

    // Clear vector document and graph node
    this.vector.removeDocument(memoryId);
    this.graph.removeNode(memoryId);
    this.temporal.records.delete(memoryId);

    this.emit('memory:removed', { id: memoryId });
    return true;
  }

  /**
   * Core GraphRAG retrieval search pipeline.
   * Hybrid retrieval combining TF-IDF + BM25, multi-hop graph expansion, and temporal decay scoring.
   * @param {string} query 
   * @param {Object} options 
   * @returns {Array<Object>} list of memory matches sorted by score
   */
  async search(query, options = {}) {
    if (!this.initialized) throw new Error('MemoryManager not initialized');

    const topK = options.topK || this.config.defaultTopK;
    const weights = options.weights || this.config.searchWeights;

    // 1. Core hybrid search over document chunks
    const candidates = this.vector.searchHybrid(query, { topK: topK * 2, weights });
    if (candidates.length === 0) return [];

    const scoredResults = new Map(); // id -> scoreDetails

    for (const cand of candidates) {
      // Chunks references resolve back to their parent Memory node
      let memoryId = cand.docId;
      let chunkText = cand.text;
      
      const docObj = this.vector.documents.get(cand.docId);
      if (docObj && docObj.metadata.type === 'chunk') {
        memoryId = docObj.metadata.memoryId;
      }

      const memNode = this.graph.getNode(memoryId);
      if (!memNode) continue;

      // 2. Fetch graph signals (multi-hop graph proximity)
      let graphScore = 0;
      const neighbors = this.graph.getNeighbors(memoryId, 1);
      
      // Boost relevance if neighboring nodes match search tokens
      const queryTokens = this.vector.tokenize(query);
      for (const neigh of neighbors) {
        const label = (neigh.node.data.label || '').toLowerCase();
        const matches = queryTokens.filter(tok => label.includes(tok)).length;
        if (matches > 0) {
          graphScore += (matches * 0.25) / neigh.depth;
        }
      }

      // 3. Fetch temporal relevance signal (time-decay * interaction count)
      const temporalScore = this.temporal.getRelevanceScore(memoryId);

      const vecWeight = cand.breakdown ? cand.breakdown.vectorScore : cand.score;
      const bm25Weight = cand.breakdown ? cand.breakdown.bm25Score : cand.score;

      // Weighted scoring formula
      const finalScore = 
        (vecWeight * weights.vector) +
        (bm25Weight * weights.bm25) +
        (Math.min(1.0, graphScore) * weights.graph) +
        (Math.min(1.0, temporalScore) * weights.temporal);

      const existing = scoredResults.get(memoryId);
      if (!existing || existing.score < finalScore) {
        scoredResults.set(memoryId, {
          id: memoryId,
          score: Math.round(finalScore * 1000) / 1000,
          text: memNode.data.content || chunkText,
          category: memNode.data.category,
          sourceId: memNode.data.sourceId,
          createdAt: memNode.createdAt,
          breakdown: {
            vector: Math.round(vecWeight * 100) / 100,
            bm25: Math.round(bm25Weight * 100) / 100,
            graph: Math.round(Math.min(1.0, graphScore) * 100) / 100,
            temporal: Math.round(Math.min(1.0, temporalScore) * 100) / 100
          }
        });
      }
    }

    const sorted = Array.from(scoredResults.values()).sort((a, b) => b.score - a.score).slice(0, topK);
    this.emit('search:completed', { query, results: sorted });
    return sorted;
  }

  /**
   * Get Minimum Viable Context string to supply directly to Agent LLM context windows
   * @param {string} query 
   * @param {number} maxTokens 
   * @returns {string} context block
   */
  async getContext(query, maxTokens = 2048) {
    const results = await this.search(query, { topK: 12 });
    if (results.length === 0) return 'No relevant memories found.';

    let context = '=== RELEVANT AGENT MEMORIES ===\n\n';
    let currentTokens = 0;
    
    // Rough character-based token estimator (4 chars per token)
    const tokenEst = (str) => Math.ceil(str.length / 4);

    for (const res of results) {
      const block = `[Time: ${new Date(res.createdAt).toLocaleString()}][Category: ${res.category}]\n${res.text}\n\n`;
      const est = tokenEst(block);
      if (currentTokens + est > maxTokens) {
        break;
      }
      context += block;
      currentTokens += est;
    }

    return context;
  }

  /**
   * Query graph relations
   */
  async getRelated(memoryId, depth = 2) {
    if (!this.initialized) throw new Error('MemoryManager not initialized');
    return this.graph.getSubgraph(memoryId, depth);
  }

  /**
   * Query full subgraph centered around node
   */
  async queryGraph(startEntityId, hops = 2) {
    if (!this.initialized) throw new Error('MemoryManager not initialized');
    return this.graph.getSubgraph(startEntityId, hops);
  }

  /**
   * Bulk import memories
   */
  async importData(data, format = 'json') {
    if (!this.initialized) throw new Error('MemoryManager not initialized');
    let imported = 0;
    let errors = 0;

    if (format === 'json') {
      const list = Array.isArray(data) ? data : [data];
      for (const item of list) {
        try {
          const content = item.content || item.text;
          if (content) {
            await this.store(content, item.metadata || item);
            imported++;
          }
        } catch (err) {
          errors++;
        }
      }
    }
    return { imported, errors };
  }

  /**
   * Bulk export all database structures
   */
  async exportData(format = 'json') {
    if (!this.initialized) throw new Error('MemoryManager not initialized');
    
    const exportObj = {
      nodes: this.graph.getAllNodes(),
      edges: this.graph.getAllEdges(),
      temporal: Array.from(this.temporal.records.entries()),
      chunks: Array.from(this.chunks.chunks.values())
    };

    if (format === 'json') {
      return exportObj;
    }
    
    // Markdown backup
    let md = '# GraphRAG Memory Export\n\n';
    md += `Exported: ${new Date().toISOString()}\n\n`;
    md += '## Memories\n\n';
    
    const memories = this.graph.getNodesByType('memory');
    memories.forEach(m => {
      md += `### Memory ID: ${m.id}\n`;
      md += `- Created: ${m.createdAt}\n`;
      md += `- Category: ${m.data.category || 'general'}\n\n`;
      md += `${m.data.content || ''}\n\n---\n\n`;
    });
    return md;
  }

  /**
   * Run Database Optimizations
   */
  async optimize(options = {}) {
    if (!this.initialized) throw new Error('MemoryManager not initialized');
    const report = await this.optimizer.runFullOptimization({
      duplicateThreshold: this.config.duplicateThreshold,
      maxAgeDays: this.config.pruneAfterDays,
      backupDir: this.config.backupDir,
      maxBackups: this.config.maxBackups,
      ...options
    });
    this.emit('optimize:completed', report);
    return report;
  }

  /**
   * System Statistics Summary
   */
  async getStats() {
    return {
      graph: this.graph.getStats(),
      temporal: this.temporal.getTemporalStats(),
      chunks: this.chunks.getStats(),
      vector: this.vector.getStats(),
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Save database files to disk
   */
  async save() {
    if (!this.initialized) return;
    await this.graph.save(path.join(this.dataDir, 'graph.json'));
    await this.temporal.save(path.join(this.dataDir, 'temporal.json'));
    await this.chunks.save(path.join(this.dataDir, 'chunks.json'));
    await this.vector.save(path.join(this.dataDir, 'vector-index.json'));
  }

  /**
   * Create database backup snapshot
   */
  async backup(backupDir) {
    if (!this.initialized) return;
    await this.optimizer.createBackup(backupDir);
  }
}

module.exports = MemoryManager;
