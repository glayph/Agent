'use strict';

const fs = require('fs').promises;
const path = require('path');

/**
 * Optimizer class for data cleaning, consolidation, deduplication,
 * edge weight decay/reinforcement, community restructuring, and backups.
 */
class Optimizer {
  /**
   * @param {Object} graphStore 
   * @param {Object} temporalEngine 
   * @param {Object} chunkEngine 
   * @param {Object} vectorIndex 
   */
  constructor(graphStore, temporalEngine, chunkEngine, vectorIndex) {
    this.graph = graphStore;
    this.temporal = temporalEngine;
    this.chunks = chunkEngine;
    this.vector = vectorIndex;
    
    this.report = {
      nodesRemoved: 0,
      edgesUpdated: 0,
      duplicatesFound: 0,
      orphansCleaned: 0,
      stalePruned: 0,
      timestamp: null
    };
  }

  /**
   * Clean and normalize text encoding, whitespace, and dashes
   * @param {string} text 
   * @returns {string}
   */
  normalizeText(text) {
    if (!text) return '';
    return text
      .replace(/\s+/g, ' ')                                  // collapse whitespaces
      .trim()
      .replace(/[\u201C\u201D]/g, '"')                      // double curly quotes
      .replace(/[\u2018\u2019]/g, "'")                      // single curly quotes
      .replace(/[\u2013\u2014]/g, '-')                      // em/en dashes
      .replace(/\u2026/g, '...')                            // ellipsis
      .replace(/[\u200B-\u200D\uFEFF]/g, '');               // zero-width spaces
  }

  /**
   * Detect duplicate nodes using Jaccard similarity of tokenized labels/texts
   * @param {number} threshold similarity cut-off
   * @returns {Array<Array<any>>} array of [nodeIdA, nodeIdB, similarity]
   */
  detectDuplicateNodes(threshold = 0.85) {
    const nodes = this.graph.getAllNodes();
    const tokenizedNodes = nodes.map(n => {
      const text = this.normalizeText((n.data.label || n.data.content || n.id).toLowerCase());
      const tokens = new Set(text.split(/\s+/).filter(t => t.length > 2));
      return { id: n.id, tokens };
    });

    const jaccard = (setA, setB) => {
      if (setA.size === 0 || setB.size === 0) return 0;
      let intersection = 0;
      for (const val of setA) {
        if (setB.has(val)) intersection++;
      }
      return intersection / (setA.size + setB.size - intersection);
    };

    const duplicates = [];
    for (let i = 0; i < tokenizedNodes.length; i++) {
      for (let j = i + 1; j < tokenizedNodes.length; j++) {
        const nodeA = tokenizedNodes[i];
        const nodeB = tokenizedNodes[j];
        const sim = jaccard(nodeA.tokens, nodeB.tokens);
        if (sim >= threshold) {
          duplicates.push([nodeA.id, nodeB.id, sim]);
        }
      }
    }

    this.report.duplicatesFound = duplicates.length;
    return duplicates;
  }

  /**
   * Merge target node into keep node, updating edges
   * @param {string} keepId 
   * @param {string} removeId 
   */
  mergeNodes(keepId, removeId) {
    const keepNode = this.graph.getNode(keepId);
    const removeNode = this.graph.getNode(removeId);
    if (!keepNode || !removeNode) return;

    // Direct all outgoing edges from removeNode to keepNode
    const outEdges = this.graph.getEdgesFrom(removeId);
    for (const edge of outEdges) {
      if (edge.target !== keepId) {
        this.graph.addEdge(keepId, edge.target, edge.type, edge.weight, edge.metadata);
      }
    }

    // Direct all incoming edges to removeNode to keepNode
    const inEdges = this.graph.getEdgesTo(removeId);
    for (const edge of inEdges) {
      if (edge.source !== keepId) {
        this.graph.addEdge(edge.source, keepId, edge.type, edge.weight, edge.metadata);
      }
    }

    // Merge node data/metadata
    keepNode.data = Object.assign({}, removeNode.data, keepNode.data);
    keepNode.accessCount += removeNode.accessCount;
    if (new Date(removeNode.lastAccessed) > new Date(keepNode.lastAccessed)) {
      keepNode.lastAccessed = removeNode.lastAccessed;
    }

    // Delete duplicate node and invalidate in temporal index
    this.graph.removeNode(removeId);
    if (this.temporal.records.has(removeId)) {
      this.temporal.supersede(removeId, keepId);
    }
    this.vector.removeDocument(removeId);

    this.report.nodesRemoved++;
  }

  /**
   * Remove nodes with no connections
   * @returns {number} count removed
   */
  cleanOrphanNodes() {
    const nodes = this.graph.getAllNodes();
    let count = 0;
    for (const node of nodes) {
      const outEdges = this.graph.getEdgesFrom(node.id);
      const inEdges = this.graph.getEdgesTo(node.id);
      if (outEdges.length === 0 && inEdges.length === 0) {
        this.graph.removeNode(node.id);
        if (this.temporal.records.has(node.id)) {
          this.temporal.invalidate(node.id);
        }
        this.vector.removeDocument(node.id);
        count++;
        this.report.nodesRemoved++;
      }
    }
    this.report.orphansCleaned = count;
    return count;
  }

  /**
   * Prune memories that have aged past expiration, with low interaction frequency
   * @param {number} maxAgeDays 
   * @returns {number} count removed
   */
  pruneStaleMemories(maxAgeDays = 90) {
    const nodes = this.graph.getNodesByType('memory');
    const now = new Date();
    let count = 0;

    for (const node of nodes) {
      const tempRecord = this.temporal.records.get(node.id);
      if (tempRecord) {
        const lastAccess = new Date(tempRecord.lastAccessed || tempRecord.createdAt);
        const ageInDays = (now - lastAccess) / (1000 * 60 * 60 * 24);
        
        // Stale if aged out AND accessed less than 3 times
        if (ageInDays > maxAgeDays && tempRecord.accessCount < 3) {
          this.graph.removeNode(node.id);
          this.temporal.records.delete(node.id);
          this.vector.removeDocument(node.id);
          
          // Clean chunks related to this source
          const relatedChunks = this.chunks.getChunksBySource(node.id);
          for (const ch of relatedChunks) {
            this.chunks.removeChunk(ch.id);
            this.vector.removeDocument(ch.id);
          }
          
          count++;
          this.report.nodesRemoved++;
        }
      }
    }
    this.report.stalePruned = count;
    return count;
  }

  /**
   * Adjust edge weights dynamically using co-access logs and time decay
   */
  recalculateEdgeWeights() {
    const edges = this.graph.getAllEdges();
    const halfLifeHours = 168; // 1 week half life
    let updatedCount = 0;

    for (const edge of edges) {
      const sourceNode = this.graph.getNode(edge.source);
      const targetNode = this.graph.getNode(edge.target);
      if (!sourceNode || !targetNode) continue;

      // Higher co-access count boosts weight log-exponentially
      const coAccess = Math.min(sourceNode.accessCount || 0, targetNode.accessCount || 0);
      const coAccessMultiplier = 1 + Math.log10(1 + coAccess);

      // Decay edge relevance over age
      const edgeAgeMs = new Date() - new Date(edge.createdAt);
      const edgeAgeHours = edgeAgeMs / (1000 * 60 * 60);
      const decay = Math.pow(0.5, edgeAgeHours / halfLifeHours);

      const baseWeight = edge.weight || 1.0;
      const newWeight = Math.max(0.1, baseWeight * coAccessMultiplier * decay);
      
      edge.weight = Math.round(newWeight * 100) / 100;
      updatedCount++;
    }

    this.report.edgesUpdated = updatedCount;
  }

  /**
   * Re-cluster the graph topics/communities
   */
  rebuildCommunities() {
    this.graph.detectCommunities();
  }

  /**
   * Simplify graph paths, resolving double paths
   */
  compactGraph() {
    const nodes = this.graph.getAllNodes();
    for (const node of nodes) {
      const out = this.graph.getEdgesFrom(node.id);
      if (out.length < 2) continue;

      // Map targets to their edge weights for A -> Target
      const targetMap = new Map();
      out.forEach(e => targetMap.set(e.target, e));

      // Look for multi-hop paths A -> B -> C alongside shortcuts A -> C
      for (const edgeAB of out) {
        const b = edgeAB.target;
        const outB = this.graph.getEdgesFrom(b);
        
        for (const edgeBC of outB) {
          const c = edgeBC.target;
          const shortcutEdge = targetMap.get(c);
          
          if (shortcutEdge && shortcutEdge.type === edgeAB.type && shortcutEdge.type === edgeBC.type) {
            // Remove direct path if combined intermediate paths have higher weight
            const combinedWeight = (edgeAB.weight + edgeBC.weight) / 2;
            if (shortcutEdge.weight < combinedWeight) {
              this.graph.removeEdge(node.id, c);
              targetMap.delete(c);
            }
          }
        }
      }
    }
  }

  /**
   * Full data serialization compaction
   */
  async compactStorage() {
    // Re-indexing and defragmenting hash indexes
    this.chunks.deduplicate();
  }

  /**
   * Snapshot backup of current database JSON states
   * @param {string} backupDir 
   */
  async createBackup(backupDir) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const folder = path.join(backupDir, `backup_${timestamp}`);
    await fs.mkdir(folder, { recursive: true });

    const sourceDir = path.dirname(backupDir); // data directory
    const files = ['graph.json', 'temporal.json', 'chunks.json', 'vector-index.json'];

    for (const file of files) {
      const src = path.join(sourceDir, file);
      const dst = path.join(folder, file);
      try {
        await fs.copyFile(src, dst);
      } catch (err) {
        if (err.code !== 'ENOENT') console.error(`[Backup Error] Copy failed for ${file}:`, err.message);
      }
    }
  }

  /**
   * Keep only N most recent snapshot backups
   * @param {string} backupDir 
   * @param {number} maxBackups 
   */
  async rotateBackups(backupDir, maxBackups = 5) {
    try {
      const items = await fs.readdir(backupDir);
      const backups = items
        .filter(item => item.startsWith('backup_'))
        .map(name => ({ name, path: path.join(backupDir, name) }));

      if (backups.length <= maxBackups) return;

      // Sort oldest first
      backups.sort((a, b) => a.name.localeCompare(b.name));
      const toDelete = backups.slice(0, backups.length - maxBackups);

      for (const bk of toDelete) {
        await fs.rm(bk.path, { recursive: true, force: true });
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[Backup Rotation Error]', err.message);
    }
  }

  /**
   * Run entire optimization flow
   * @param {Object} options 
   */
  async runFullOptimization(options = {}) {
    const threshold = options.duplicateThreshold || 0.85;
    const maxAgeDays = options.maxAgeDays || 90;
    const backupDir = options.backupDir;

    this.report = {
      nodesRemoved: 0,
      edgesUpdated: 0,
      duplicatesFound: 0,
      orphansCleaned: 0,
      stalePruned: 0,
      timestamp: new Date().toISOString()
    };

    // 1. Text normalization across graph
    const nodes = this.graph.getAllNodes();
    for (const node of nodes) {
      if (node.data.label) node.data.label = this.normalizeText(node.data.label);
      if (node.data.content) node.data.content = this.normalizeText(node.data.content);
    }

    // 2. Duplicate detection and merging
    const duplicates = this.detectDuplicateNodes(threshold);
    for (const [keepId, removeId] of duplicates) {
      this.mergeNodes(keepId, removeId);
    }

    // 3. Clear dead ends / orphans
    this.cleanOrphanNodes();

    // 4. Age-based memory pruning
    this.pruneStaleMemories(maxAgeDays);

    // 5. Weight recalculation and clustering
    this.recalculateEdgeWeights();
    this.rebuildCommunities();
    this.compactGraph();

    // 6. Compact serialized indexes
    await this.compactStorage();

    // 7. Backup if requested
    if (backupDir) {
      await this.createBackup(backupDir);
      await this.rotateBackups(backupDir, options.maxBackups || 5);
    }

    return this.getOptimizationReport();
  }

  /**
   * Fetch latest audit details
   */
  getOptimizationReport() {
    return { ...this.report };
  }
}

module.exports = Optimizer;
