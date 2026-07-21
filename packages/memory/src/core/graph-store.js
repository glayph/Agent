'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * In-memory graph database with JSON file persistence.
 * Core storage engine for the GraphRAG memory system.
 *
 * Uses adjacency lists (outEdges, inEdges) for efficient traversal
 * and supports community detection via simplified Louvain modularity optimization.
 */
class GraphStore {
  /**
   * Valid node types in the graph.
   * @type {Set<string>}
   */
  static NODE_TYPES = new Set(['entity', 'concept', 'memory', 'event']);

  /**
   * Valid edge types in the graph.
   * @type {Set<string>}
   */
  static EDGE_TYPES = new Set([
    'relates_to', 'part_of', 'caused_by',
    'references', 'similar_to', 'precedes', 'follows'
  ]);

  constructor() {
    /** @type {Map<string, object>} nodeId -> nodeObj */
    this.nodes = new Map();

    /** @type {Map<string, Map<string, object>>} nodeId -> Map(targetId -> edgeObj) */
    this.outEdges = new Map();

    /** @type {Map<string, Map<string, object>>} nodeId -> Map(sourceId -> edgeObj) */
    this.inEdges = new Map();
  }

  // ─────────────────────────────────────────────
  //  Node Management
  // ─────────────────────────────────────────────

  /**
   * Add a new node to the graph.
   * @param {string} id - Unique node identifier.
   * @param {string} type - Node type: 'entity' | 'concept' | 'memory' | 'event'.
   * @param {object} [data={}] - Arbitrary data payload.
   * @returns {object} The created node object.
   * @throws {Error} If the node already exists or the type is invalid.
   */
  addNode(id, type, data = {}) {
    if (this.nodes.has(id)) {
      throw new Error(`Node "${id}" already exists`);
    }
    if (!GraphStore.NODE_TYPES.has(type)) {
      throw new Error(`Invalid node type "${type}". Must be one of: ${[...GraphStore.NODE_TYPES].join(', ')}`);
    }

    const now = new Date().toISOString();
    const node = {
      id,
      type,
      data: { ...data },
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessed: now,
      communityId: null
    };

    this.nodes.set(id, node);
    this.outEdges.set(id, new Map());
    this.inEdges.set(id, new Map());

    return node;
  }

  /**
   * Retrieve a node by its ID. Increments access counters.
   * @param {string} id - The node identifier.
   * @returns {object|null} The node object, or null if not found.
   */
  getNode(id) {
    const node = this.nodes.get(id) || null;
    if (node) {
      node.accessCount++;
      node.lastAccessed = new Date().toISOString();
    }
    return node;
  }

  /**
   * Merge new data into an existing node.
   * @param {string} id - The node identifier.
   * @param {object} data - Data fields to merge.
   * @returns {object} The updated node object.
   * @throws {Error} If the node does not exist.
   */
  updateNode(id, data) {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node "${id}" not found`);
    }

    Object.assign(node.data, data);
    node.updatedAt = new Date().toISOString();
    return node;
  }

  /**
   * Remove a node and all its associated edges from the graph.
   * @param {string} id - The node identifier.
   * @returns {boolean} True if the node was removed, false if it didn't exist.
   */
  removeNode(id) {
    if (!this.nodes.has(id)) {
      return false;
    }

    // Remove all outgoing edges
    const outgoing = this.outEdges.get(id);
    if (outgoing) {
      for (const targetId of outgoing.keys()) {
        const targetIn = this.inEdges.get(targetId);
        if (targetIn) {
          targetIn.delete(id);
        }
      }
    }

    // Remove all incoming edges
    const incoming = this.inEdges.get(id);
    if (incoming) {
      for (const sourceId of incoming.keys()) {
        const sourceOut = this.outEdges.get(sourceId);
        if (sourceOut) {
          sourceOut.delete(id);
        }
      }
    }

    this.outEdges.delete(id);
    this.inEdges.delete(id);
    this.nodes.delete(id);

    return true;
  }

  /**
   * Get all nodes of a specific type.
   * @param {string} type - The node type to filter by.
   * @returns {object[]} Array of matching node objects.
   */
  getNodesByType(type) {
    const results = [];
    for (const node of this.nodes.values()) {
      if (node.type === type) {
        results.push(node);
      }
    }
    return results;
  }

  /**
   * Get all nodes in the graph.
   * @returns {object[]} Array of all node objects.
   */
  getAllNodes() {
    return [...this.nodes.values()];
  }

  // ─────────────────────────────────────────────
  //  Edge Management
  // ─────────────────────────────────────────────

  /**
   * Add a directed edge between two nodes.
   * @param {string} sourceId - Source node identifier.
   * @param {string} targetId - Target node identifier.
   * @param {string} type - Edge type: 'relates_to' | 'part_of' | 'caused_by' | 'references' | 'similar_to' | 'precedes' | 'follows'.
   * @param {number} [weight=1.0] - Edge weight for scoring.
   * @param {object} [metadata={}] - Arbitrary edge metadata.
   * @returns {object} The created edge object.
   * @throws {Error} If source/target nodes don't exist, edge type is invalid, or edge already exists.
   */
  addEdge(sourceId, targetId, type, weight = 1.0, metadata = {}) {
    if (!this.nodes.has(sourceId)) {
      throw new Error(`Source node "${sourceId}" not found`);
    }
    if (!this.nodes.has(targetId)) {
      throw new Error(`Target node "${targetId}" not found`);
    }
    if (!GraphStore.EDGE_TYPES.has(type)) {
      throw new Error(`Invalid edge type "${type}". Must be one of: ${[...GraphStore.EDGE_TYPES].join(', ')}`);
    }

    const outMap = this.outEdges.get(sourceId);
    if (outMap.has(targetId)) {
      throw new Error(`Edge from "${sourceId}" to "${targetId}" already exists`);
    }

    const edge = {
      source: sourceId,
      target: targetId,
      type,
      weight,
      metadata: { ...metadata },
      createdAt: new Date().toISOString()
    };

    outMap.set(targetId, edge);
    this.inEdges.get(targetId).set(sourceId, edge);

    return edge;
  }

  /**
   * Retrieve an edge between two nodes.
   * @param {string} sourceId - Source node identifier.
   * @param {string} targetId - Target node identifier.
   * @returns {object|null} The edge object, or null if not found.
   */
  getEdge(sourceId, targetId) {
    const outMap = this.outEdges.get(sourceId);
    if (!outMap) return null;
    return outMap.get(targetId) || null;
  }

  /**
   * Remove an edge between two nodes.
   * @param {string} sourceId - Source node identifier.
   * @param {string} targetId - Target node identifier.
   * @returns {boolean} True if the edge was removed, false if it didn't exist.
   */
  removeEdge(sourceId, targetId) {
    const outMap = this.outEdges.get(sourceId);
    if (!outMap || !outMap.has(targetId)) {
      return false;
    }

    outMap.delete(targetId);
    const inMap = this.inEdges.get(targetId);
    if (inMap) {
      inMap.delete(sourceId);
    }

    return true;
  }

  /**
   * Get all outgoing edges from a node.
   * @param {string} nodeId - The node identifier.
   * @returns {object[]} Array of edge objects originating from the node.
   */
  getEdgesFrom(nodeId) {
    const outMap = this.outEdges.get(nodeId);
    if (!outMap) return [];
    return [...outMap.values()];
  }

  /**
   * Get all incoming edges to a node.
   * @param {string} nodeId - The node identifier.
   * @returns {object[]} Array of edge objects targeting the node.
   */
  getEdgesTo(nodeId) {
    const inMap = this.inEdges.get(nodeId);
    if (!inMap) return [];
    return [...inMap.values()];
  }

  /**
   * Get all edges in the graph.
   * @returns {object[]} Array of all edge objects.
   */
  getAllEdges() {
    const edges = [];
    for (const outMap of this.outEdges.values()) {
      for (const edge of outMap.values()) {
        edges.push(edge);
      }
    }
    return edges;
  }

  // ─────────────────────────────────────────────
  //  Graph Traversal (GraphRAG)
  // ─────────────────────────────────────────────

  /**
   * Multi-hop BFS traversal to find neighbors within a given depth.
   * @param {string} nodeId - Starting node identifier.
   * @param {number} [depth=1] - Maximum traversal depth.
   * @returns {Array<{node: object, depth: number, path: string[]}>} Array of neighbor results.
   * @throws {Error} If the starting node does not exist.
   */
  getNeighbors(nodeId, depth = 1) {
    if (!this.nodes.has(nodeId)) {
      throw new Error(`Node "${nodeId}" not found`);
    }

    const results = [];
    const visited = new Set([nodeId]);
    // BFS queue: [currentNodeId, currentDepth, pathSoFar]
    const queue = [[nodeId, 0, [nodeId]]];

    while (queue.length > 0) {
      const [currentId, currentDepth, currentPath] = queue.shift();

      if (currentDepth >= depth) continue;

      // Traverse outgoing edges
      const outMap = this.outEdges.get(currentId);
      if (outMap) {
        for (const targetId of outMap.keys()) {
          if (!visited.has(targetId)) {
            visited.add(targetId);
            const newPath = [...currentPath, targetId];
            results.push({
              node: this.nodes.get(targetId),
              depth: currentDepth + 1,
              path: newPath
            });
            queue.push([targetId, currentDepth + 1, newPath]);
          }
        }
      }

      // Traverse incoming edges (treat graph as undirected for neighbor discovery)
      const inMap = this.inEdges.get(currentId);
      if (inMap) {
        for (const sourceId of inMap.keys()) {
          if (!visited.has(sourceId)) {
            visited.add(sourceId);
            const newPath = [...currentPath, sourceId];
            results.push({
              node: this.nodes.get(sourceId),
              depth: currentDepth + 1,
              path: newPath
            });
            queue.push([sourceId, currentDepth + 1, newPath]);
          }
        }
      }
    }

    return results;
  }

  /**
   * Find the shortest path between two nodes using BFS.
   * Treats the graph as undirected for path finding.
   * @param {string} startId - Starting node identifier.
   * @param {string} endId - Target node identifier.
   * @returns {string[]|null} Array of node IDs forming the path, or null if no path exists.
   * @throws {Error} If either node does not exist.
   */
  findPath(startId, endId) {
    if (!this.nodes.has(startId)) {
      throw new Error(`Start node "${startId}" not found`);
    }
    if (!this.nodes.has(endId)) {
      throw new Error(`End node "${endId}" not found`);
    }

    if (startId === endId) return [startId];

    const visited = new Set([startId]);
    const queue = [[startId, [startId]]];

    while (queue.length > 0) {
      const [currentId, currentPath] = queue.shift();

      // Collect all undirected neighbors
      const neighborIds = new Set();
      const outMap = this.outEdges.get(currentId);
      if (outMap) {
        for (const targetId of outMap.keys()) neighborIds.add(targetId);
      }
      const inMap = this.inEdges.get(currentId);
      if (inMap) {
        for (const sourceId of inMap.keys()) neighborIds.add(sourceId);
      }

      for (const neighborId of neighborIds) {
        if (visited.has(neighborId)) continue;
        const newPath = [...currentPath, neighborId];
        if (neighborId === endId) return newPath;
        visited.add(neighborId);
        queue.push([neighborId, newPath]);
      }
    }

    return null; // No path found
  }

  /**
   * Extract a local subgraph centered on a node within a given radius.
   * @param {string} nodeId - Center node identifier.
   * @param {number} [radius=2] - Radius of the subgraph.
   * @returns {{nodes: object[], edges: object[]}} The extracted subgraph.
   * @throws {Error} If the center node does not exist.
   */
  getSubgraph(nodeId, radius = 2) {
    if (!this.nodes.has(nodeId)) {
      throw new Error(`Node "${nodeId}" not found`);
    }

    const neighbors = this.getNeighbors(nodeId, radius);
    const nodeIds = new Set([nodeId, ...neighbors.map(n => n.node.id)]);

    const subNodes = [];
    for (const nid of nodeIds) {
      subNodes.push(this.nodes.get(nid));
    }

    const subEdges = [];
    for (const nid of nodeIds) {
      const outMap = this.outEdges.get(nid);
      if (outMap) {
        for (const [targetId, edge] of outMap.entries()) {
          if (nodeIds.has(targetId)) {
            subEdges.push(edge);
          }
        }
      }
    }

    return { nodes: subNodes, edges: subEdges };
  }

  // ─────────────────────────────────────────────
  //  Community Detection (Simplified Louvain)
  // ─────────────────────────────────────────────

  /**
   * Detect communities using simplified Louvain modularity optimization.
   * Assigns a communityId to each node and returns the community mapping.
   *
   * Algorithm:
   * 1. Assign each node to its own community.
   * 2. Iteratively move nodes to neighboring communities that maximize modularity gain.
   * 3. Repeat until no improvement is found.
   *
   * @returns {Map<string, string[]>} Map of communityId to array of node IDs.
   */
  detectCommunities() {
    const nodeIds = [...this.nodes.keys()];
    if (nodeIds.length === 0) return new Map();

    // Build an undirected weighted adjacency structure for modularity calculation
    // adjWeights: nodeId -> Map(neighborId -> totalWeight)
    const adjWeights = new Map();
    for (const nid of nodeIds) {
      adjWeights.set(nid, new Map());
    }

    let totalWeight = 0;

    for (const outMap of this.outEdges.values()) {
      for (const edge of outMap.values()) {
        const w = edge.weight || 1.0;
        totalWeight += w;

        // Add undirected weight
        const srcAdj = adjWeights.get(edge.source);
        const tgtAdj = adjWeights.get(edge.target);

        srcAdj.set(edge.target, (srcAdj.get(edge.target) || 0) + w);
        tgtAdj.set(edge.source, (tgtAdj.get(edge.source) || 0) + w);
      }
    }

    // If no edges, each node is its own community
    if (totalWeight === 0) {
      const communities = new Map();
      for (const nid of nodeIds) {
        this.nodes.get(nid).communityId = nid;
        communities.set(nid, [nid]);
      }
      return communities;
    }

    const m = totalWeight; // total edge weight (each edge counted once in outEdges)

    // Assign each node to its own community
    const nodeCommunity = new Map(); // nodeId -> communityId
    for (const nid of nodeIds) {
      nodeCommunity.set(nid, nid);
    }

    // Precompute node degrees (sum of weights of all edges incident to node)
    const nodeDegree = new Map();
    for (const nid of nodeIds) {
      let deg = 0;
      const neighbors = adjWeights.get(nid);
      for (const w of neighbors.values()) {
        deg += w;
      }
      nodeDegree.set(nid, deg);
    }

    /**
     * Calculate the sum of weights inside a community.
     * @param {string} communityId
     * @returns {number}
     */
    const getCommunityMembers = (communityId) => {
      const members = [];
      for (const [nid, cid] of nodeCommunity.entries()) {
        if (cid === communityId) members.push(nid);
      }
      return members;
    };

    /**
     * Calculate modularity gain of moving nodeId to targetCommunity.
     * ΔQ = [sum_in + k_i_in] / (2m) - [(sum_tot + k_i) / (2m)]^2
     *     - [sum_in / (2m) - [sum_tot / (2m)]^2 - [k_i / (2m)]^2]
     *
     * Simplified: ΔQ = (k_i_in / m) - (k_i * sum_tot) / (2 * m^2)
     *
     * @param {string} nodeId
     * @param {string} targetCommunity
     * @returns {number}
     */
    const modularityGain = (nodeId, targetCommunity) => {
      const ki = nodeDegree.get(nodeId);
      const neighbors = adjWeights.get(nodeId);

      // k_i_in: sum of weights from nodeId to nodes in targetCommunity
      let kiIn = 0;
      for (const [neighborId, w] of neighbors.entries()) {
        if (nodeCommunity.get(neighborId) === targetCommunity) {
          kiIn += w;
        }
      }

      // sum_tot: sum of degrees of nodes in targetCommunity
      let sumTot = 0;
      for (const [nid, cid] of nodeCommunity.entries()) {
        if (cid === targetCommunity && nid !== nodeId) {
          sumTot += nodeDegree.get(nid);
        }
      }

      return (kiIn / m) - (ki * sumTot) / (2 * m * m);
    };

    // Iterative optimization
    let improved = true;
    let maxIterations = 50;

    while (improved && maxIterations-- > 0) {
      improved = false;

      for (const nodeId of nodeIds) {
        const currentCommunity = nodeCommunity.get(nodeId);
        const neighbors = adjWeights.get(nodeId);

        // Collect neighboring community IDs
        const neighborCommunities = new Set();
        for (const neighborId of neighbors.keys()) {
          const nc = nodeCommunity.get(neighborId);
          if (nc !== currentCommunity) {
            neighborCommunities.add(nc);
          }
        }

        let bestCommunity = currentCommunity;
        let bestGain = 0;

        for (const candidateCommunity of neighborCommunities) {
          // Calculate gain of removing from current and adding to candidate
          const gainRemove = -modularityGain(nodeId, currentCommunity);
          const gainAdd = modularityGain(nodeId, candidateCommunity);
          const totalGain = gainRemove + gainAdd;

          if (totalGain > bestGain) {
            bestGain = totalGain;
            bestCommunity = candidateCommunity;
          }
        }

        if (bestCommunity !== currentCommunity && bestGain > 1e-10) {
          nodeCommunity.set(nodeId, bestCommunity);
          improved = true;
        }
      }
    }

    // Build final community map and assign communityId to nodes
    const communities = new Map();
    for (const [nodeId, communityId] of nodeCommunity.entries()) {
      this.nodes.get(nodeId).communityId = communityId;
      if (!communities.has(communityId)) {
        communities.set(communityId, []);
      }
      communities.get(communityId).push(nodeId);
    }

    return communities;
  }

  // ─────────────────────────────────────────────
  //  Persistence
  // ─────────────────────────────────────────────

  /**
   * Save the entire graph to a JSON file.
   * @param {string} filePath - Absolute or relative path to the output file.
   * @returns {Promise<void>}
   */
  async save(filePath) {
    const data = {
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: [...this.nodes.values()],
      edges: this.getAllEdges()
    };

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load a graph from a JSON file, replacing all current data.
   * @param {string} filePath - Absolute or relative path to the input file.
   * @returns {Promise<void>}
   * @throws {Error} If the file cannot be read or parsed.
   */
  async load(filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);

      // Clear current state
      this.nodes.clear();
      this.outEdges.clear();
      this.inEdges.clear();

      // Restore nodes
      for (const nodeData of data.nodes) {
        this.nodes.set(nodeData.id, nodeData);
        this.outEdges.set(nodeData.id, new Map());
        this.inEdges.set(nodeData.id, new Map());
      }

      // Restore edges
      for (const edgeData of data.edges) {
        const outMap = this.outEdges.get(edgeData.source);
        if (outMap) {
          outMap.set(edgeData.target, edgeData);
        }
        const inMap = this.inEdges.get(edgeData.target);
        if (inMap) {
          inMap.set(edgeData.source, edgeData);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  // ─────────────────────────────────────────────
  //  Stats
  // ─────────────────────────────────────────────

  /**
   * Calculate and return graph statistics.
   * @returns {{nodeCount: number, edgeCount: number, density: number, avgDegree: number, communities: number}}
   */
  getStats() {
    const nodeCount = this.nodes.size;
    const edgeCount = this.getAllEdges().length;

    // Density: |E| / (|V| * (|V| - 1)) for directed graph
    const maxEdges = nodeCount * (nodeCount - 1);
    const density = maxEdges > 0 ? edgeCount / maxEdges : 0;

    // Average degree (out-degree + in-degree per node)
    const avgDegree = nodeCount > 0 ? (2 * edgeCount) / nodeCount : 0;

    // Count distinct communities
    const communityIds = new Set();
    for (const node of this.nodes.values()) {
      if (node.communityId !== null) {
        communityIds.add(node.communityId);
      }
    }

    return {
      nodeCount,
      edgeCount,
      density: Math.round(density * 10000) / 10000,
      avgDegree: Math.round(avgDegree * 100) / 100,
      communities: communityIds.size
    };
  }
}

module.exports = GraphStore;
