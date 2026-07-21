'use strict';

/**
 * GraphRAG Memory System - API Routes (v1 + v2 TKG)
 * 
 * Includes classic MemoryManager routes + new Temporal Knowledge Graph endpoints
 * 
 * @param {import('express').Application} app - Express application
 * @param {import('../core/memory-manager')} memoryManager - Memory manager instance
 * @param {Object} [tkgService] - TemporalKnowledgeGraph instance (v2)
 */
function setupRoutes(app, memoryManager, tkgService) {

  // ════════════════════════════════════════════
  // MEMORY CRUD
  // ════════════════════════════════════════════

  /**
   * POST /api/memory
   * Store a new memory
   * Body: { content: string, metadata?: object }
   */
  app.post('/api/memory', async (req, res) => {
    try {
      const { content, metadata } = req.body;
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content (string) is required' });
      }
      const memoryId = await memoryManager.store(content, metadata || {});
      res.status(201).json({ id: memoryId, message: 'Memory stored successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/memory/:id
   * Retrieve a memory by ID
   */
  app.get('/api/memory/:id', async (req, res) => {
    try {
      const memory = await memoryManager.retrieve(req.params.id);
      if (!memory) {
        return res.status(404).json({ error: 'Memory not found' });
      }
      res.json(memory);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/memory/:id
   * Update a memory
   * Body: { content: string, metadata?: object }
   */
  app.put('/api/memory/:id', async (req, res) => {
    try {
      const { content, metadata } = req.body;
      if (!content || typeof content !== 'string') {
        return res.status(400).json({ error: 'content (string) is required' });
      }
      await memoryManager.update(req.params.id, content, metadata || {});
      res.json({ id: req.params.id, message: 'Memory updated successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/memory/:id
   * Delete a memory
   */
  app.delete('/api/memory/:id', async (req, res) => {
    try {
      await memoryManager.remove(req.params.id);
      res.json({ id: req.params.id, message: 'Memory removed successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/memories
   * List all memories with optional filtering
   * Query: ?type=memory&limit=50&offset=0
   */
  app.get('/api/memories', async (req, res) => {
    try {
      const { type, limit = 50, offset = 0 } = req.query;
      const stats = await memoryManager.getStats();
      let nodes = [];
      
      if (memoryManager.graph) {
        nodes = type
          ? memoryManager.graph.getNodesByType(type)
          : memoryManager.graph.getAllNodes();
      }

      // Sort by most recently updated
      nodes.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

      const paginated = nodes.slice(Number(offset), Number(offset) + Number(limit));
      
      res.json({
        total: nodes.length,
        offset: Number(offset),
        limit: Number(limit),
        memories: paginated
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════
  // SEARCH
  // ════════════════════════════════════════════

  /**
   * POST /api/search
   * Hybrid search (vector + BM25 + graph + temporal)
   * Body: { query: string, topK?: number, weights?: object }
   */
  app.post('/api/search', async (req, res) => {
    try {
      const { query, topK, weights } = req.body;
      if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'query (string) is required' });
      }
      const options = {};
      if (topK) options.topK = topK;
      if (weights) options.weights = weights;

      const results = await memoryManager.search(query, options);
      res.json({ query, resultCount: results.length, results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/context
   * Get assembled context for an agent query
   * Body: { query: string, maxTokens?: number }
   */
  app.post('/api/context', async (req, res) => {
    try {
      const { query, maxTokens } = req.body;
      if (!query || typeof query !== 'string') {
        return res.status(400).json({ error: 'query (string) is required' });
      }
      const context = await memoryManager.getContext(query, maxTokens || 2048);
      res.json({ query, context, tokenEstimate: Math.ceil(context.length / 4) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════
  // GRAPH
  // ════════════════════════════════════════════

  /**
   * GET /api/graph
   * Get full graph data for visualization
   * Query: ?limit=500
   */
  app.get('/api/graph', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 500;
      if (!memoryManager.graph) {
        return res.json({ nodes: [], edges: [] });
      }

      let nodes = memoryManager.graph.getAllNodes();
      const edges = memoryManager.graph.getAllEdges();

      // Limit nodes for performance
      if (nodes.length > limit) {
        nodes.sort((a, b) => (b.accessCount || 0) - (a.accessCount || 0));
        nodes = nodes.slice(0, limit);
        const nodeIds = new Set(nodes.map(n => n.id));
        // Only include edges between visible nodes
        const filteredEdges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));
        return res.json({ nodes, edges: filteredEdges, total: memoryManager.graph.getAllNodes().length, limited: true });
      }

      res.json({ nodes, edges, total: nodes.length, limited: false });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/neighbors/:id
   * Get node neighbors (multi-hop)
   * Query: ?depth=2
   */
  app.get('/api/graph/neighbors/:id', async (req, res) => {
    try {
      const depth = parseInt(req.query.depth) || 2;
      if (!memoryManager.graph) {
        return res.status(404).json({ error: 'Graph not initialized' });
      }
      const neighbors = memoryManager.graph.getNeighbors(req.params.id, depth);
      const subgraph = memoryManager.graph.getSubgraph(req.params.id, depth);
      res.json({ nodeId: req.params.id, depth, neighbors, subgraph });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/path/:startId/:endId
   * Find shortest path between two nodes
   */
  app.get('/api/graph/path/:startId/:endId', async (req, res) => {
    try {
      if (!memoryManager.graph) {
        return res.status(404).json({ error: 'Graph not initialized' });
      }
      const path = memoryManager.graph.findPath(req.params.startId, req.params.endId);
      res.json({ start: req.params.startId, end: req.params.endId, path, length: path ? path.length : -1 });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/graph/entity
   * Add an entity to the graph
   * Body: { name: string, type?: string, attributes?: object }
   */
  app.post('/api/graph/entity', async (req, res) => {
    try {
      const { name, type, attributes } = req.body;
      if (!name) {
        return res.status(400).json({ error: 'name is required' });
      }
      const entityId = await memoryManager.addEntity(name, type || 'entity', attributes || {});
      res.status(201).json({ id: entityId, message: 'Entity added' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/graph/relation
   * Add a relation between entities
   * Body: { sourceId: string, targetId: string, type?: string, metadata?: object }
   */
  app.post('/api/graph/relation', async (req, res) => {
    try {
      const { sourceId, targetId, type, metadata } = req.body;
      if (!sourceId || !targetId) {
        return res.status(400).json({ error: 'sourceId and targetId are required' });
      }
      await memoryManager.addRelation(sourceId, targetId, type || 'relates_to', metadata || {});
      res.status(201).json({ message: 'Relation added', sourceId, targetId, type: type || 'relates_to' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/communities
   * Get community structure
   */
  app.get('/api/graph/communities', async (req, res) => {
    try {
      if (!memoryManager.graph) {
        return res.json({ communities: {} });
      }
      const communities = memoryManager.graph.detectCommunities();
      const result = {};
      communities.forEach((nodeIds, communityId) => {
        result[communityId] = nodeIds;
      });
      res.json({ communityCount: communities.size, communities: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════
  // TIMELINE
  // ════════════════════════════════════════════

  /**
   * GET /api/timeline
   * Get temporal timeline data
   * Query: ?granularity=day&start=ISO&end=ISO
   */
  app.get('/api/timeline', async (req, res) => {
    try {
      const { granularity = 'day', start, end } = req.query;
      if (!memoryManager.temporal) {
        return res.json({ timeline: [], clusters: [] });
      }

      const timeline = memoryManager.temporal.getTimeline(granularity);

      let filtered = timeline;
      if (start || end) {
        const startDate = start ? new Date(start) : new Date(0);
        const endDate = end ? new Date(end) : new Date();
        const memoryIds = memoryManager.temporal.getTimeRange(startDate.toISOString(), endDate.toISOString());
        filtered = timeline.filter(t => {
          return t.memoryIds.some(id => memoryIds.includes(id));
        });
      }

      const clusters = memoryManager.temporal.getTemporalClusters();

      res.json({ granularity, timeline: filtered, clusterCount: clusters.length, clusters });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/timeline/range
   * Get memories in a time range
   * Query: ?start=ISO&end=ISO
   */
  app.get('/api/timeline/range', async (req, res) => {
    try {
      const { start, end } = req.query;
      if (!start || !end) {
        return res.status(400).json({ error: 'start and end query parameters are required (ISO 8601)' });
      }
      if (!memoryManager.temporal) {
        return res.json({ memoryIds: [] });
      }
      const memoryIds = memoryManager.temporal.getTimeRange(start, end);
      res.json({ start, end, count: memoryIds.length, memoryIds });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════
  // OPTIMIZATION
  // ════════════════════════════════════════════

  /**
   * POST /api/optimize
   * Run optimization pipeline
   * Body: { options?: object }
   */
  app.post('/api/optimize', async (req, res) => {
    try {
      const options = req.body.options || {};
      const report = await memoryManager.optimize(options);
      res.json({ message: 'Optimization complete', report });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════
  // STATS
  // ════════════════════════════════════════════

  /**
   * GET /api/stats
   * Get comprehensive system statistics
   */
  app.get('/api/stats', async (req, res) => {
    try {
      const stats = await memoryManager.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════
  // IMPORT / EXPORT
  // ════════════════════════════════════════════

  /**
   * POST /api/import
   * Import data
   * Body: { data: array|object, format?: 'json'|'markdown'|'csv' }
   */
  app.post('/api/import', async (req, res) => {
    try {
      const { data, format = 'json' } = req.body;
      if (!data) {
        return res.status(400).json({ error: 'data is required' });
      }
      const result = await memoryManager.importData(data, format);
      res.json({ message: 'Import complete', ...result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/export
   * Export all data
   * Query: ?format=json
   */
  app.get('/api/export', async (req, res) => {
    try {
      const format = req.query.format || 'json';
      const data = await memoryManager.exportData(format);
      
      if (format === 'json') {
        res.setHeader('Content-Disposition', 'attachment; filename=graphrag-memory-export.json');
        res.json(data);
      } else {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename=graphrag-memory-export.${format}`);
        res.send(data);
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/backup
   * Create a backup
   */
  app.post('/api/backup', async (req, res) => {
    try {
      await memoryManager.backup(memoryManager.config.backupDir);
      res.json({ message: 'Backup created successfully' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ════════════════════════════════════════════
  // V2 TEMPORAL KNOWLEDGE GRAPH API
  // Only mounted if tkgService is provided
  // ════════════════════════════════════════════

  if (!tkgService) return;

  /**
   * POST /api/v2/event
   * Write an event to the current hourly chunk
   */
  app.post('/api/v2/event', async (req, res) => {
    try {
      const result = tkgService.writeEvent(req.body);
      res.status(201).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/v2/anchor
   * Get the current working memory anchor
   */
  app.get('/api/v2/anchor', async (req, res) => {
    try {
      const anchor = tkgService.getWorkingAnchor();
      res.json(anchor);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/v2/anchor
   * Update the working memory anchor
   */
  app.put('/api/v2/anchor', async (req, res) => {
    try {
      const anchor = tkgService.getOrSetWorkingAnchor(req.body);
      res.json(anchor);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/v2/chunks
   * Get hourly chunks in a range
   * Query: ?start=2026-07-21T00&end=2026-07-21T23
   */
  app.get('/api/v2/chunks', async (req, res) => {
    try {
      const { start, end } = req.query;
      if (start && end) {
        const chunks = tkgService.getHoursInRange(start, end);
        return res.json({ chunks, count: chunks.length });
      }
      const chunk = tkgService.getOrCreateCurrentChunk();
      res.json({ chunk });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/v2/chunks/missing
   * Find and fill missing empty chunks
   * Query: ?start=2026-07-21T00&end=2026-07-21T23
   */
  app.post('/api/v2/chunks/fill-empty', async (req, res) => {
    try {
      const { start, end } = req.body;
      const created = tkgService.fillMissingEmptyChunks(start, end);
      res.json({ filled: created.length, chunks: created });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/v2/chunks/:id/events
   * Get all events in a chunk
   */
  app.get('/api/v2/chunks/:id/events', async (req, res) => {
    try {
      const events = tkgService.getEventsInChunk(req.params.id);
      res.json({ chunkId: req.params.id, count: events.length, events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/v2/events/recent
   * Get recent events
   * Query: ?hours=24
   */
  app.get('/api/v2/events/recent', async (req, res) => {
    try {
      const hours = parseInt(req.query.hours) || 24;
      const events = tkgService.getRecentEvents(hours);
      res.json({ hours, count: events.length, events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/v2/special-events
   * Get special highlighted events
   * Query: ?unresolved=true&limit=20
   */
  app.get('/api/v2/special-events', async (req, res) => {
    try {
      const limit = parseInt(req.query.limit) || 20;
      const unresolvedOnly = req.query.unresolved === 'true';
      const events = tkgService.getSpecialEvents(limit, unresolvedOnly);
      res.json({ count: events.length, events });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/v2/special-events/:id/resolve
   * Mark a special event as resolved
   */
  app.post('/api/v2/special-events/:id/resolve', async (req, res) => {
    try {
      tkgService.resolveSpecialEvent(req.params.id);
      res.json({ message: 'Event resolved' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/v2/entities
   * Add or ensure an entity exists
   */
  app.post('/api/v2/entities', async (req, res) => {
    try {
      const { name, type, attributes } = req.body;
      if (!name) return res.status(400).json({ error: 'name is required' });
      const id = tkgService._ensureEntity({ name, type, attributes });
      res.status(201).json({ id, message: 'Entity created/updated' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/v2/relations
   * Add an entity relationship
   */
  app.post('/api/v2/relations', async (req, res) => {
    try {
      const { sourceId, targetId, relationType, metadata } = req.body;
      if (!sourceId || !targetId || !relationType) {
        return res.status(400).json({ error: 'sourceId, targetId, and relationType are required' });
      }
      const id = tkgService.addEntityRelation(sourceId, targetId, relationType, metadata || {});
      res.status(201).json({ id, message: 'Relation added' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/v2/query
   * Query the temporal knowledge graph
   */
  app.post('/api/v2/query', async (req, res) => {
    try {
      const { query, timeRange } = req.body;
      if (!query) return res.status(400).json({ error: 'query is required' });
      const results = tkgService.queryTemporalGraph(query, timeRange);
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/v2/context
   * Get assembled context window for agent
   * Query: ?query=text&maxEvents=20
   */
  app.get('/api/v2/context', async (req, res) => {
    try {
      const query = req.query.query || '';
      const maxEvents = parseInt(req.query.maxEvents) || 20;
      const context = tkgService.getContextWindow(query, maxEvents);
      res.json({ context, tokenEstimate: Math.ceil(context.length / 4) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/v2/consolidate
   * Run memory consolidation
   */
  app.post('/api/v2/consolidate', async (req, res) => {
    try {
      const report = tkgService.runConsolidation();
      res.json({ message: 'Consolidation complete', report });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/v2/stats
   * Get TKG statistics
   */
  app.get('/api/v2/stats', async (req, res) => {
    try {
      const stats = tkgService.getStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = setupRoutes;
