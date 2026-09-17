'use strict';

const { REGIONS, ALL_REGIONS } = require('./regions');

/**
 * MultiHopRetriever – supports the diagram's iterative loop:
 *   call → analysis → call → analysis → Answer
 *
 * Starting from a seed query (or seed entity ids) it walks the graph
 * controlled by maxHops and a token/score budget, strengthening edges
 * it traverses (usage-based proximity).
 */
class MultiHopRetriever {
  /**
   * @param {import('./temporal-knowledge-graph')} tkg
   */
  constructor(tkg) {
    this.tkg = tkg;
  }

  /**
   * Perform an iterative multi-hop retrieval.
   *
   * @param {object} opts
   * @param {string}  [opts.query]          Free-text seed
   * @param {string[]} [opts.seedEntityIds] Pre-known entity ids
   * @param {string[]} [opts.regions]       Restrict to these regions (default: all durable)
   * @param {number}  [opts.maxHops=2]      How many call→analysis rounds
   * @param {number}  [opts.maxNodes=30]    Hard cap on returned nodes
   * @param {number}  [opts.minWeight=0.15] Ignore weak edges
   * @returns {{
   *   hops: Array<{hop: number, nodes: any[], edges: any[]}>,
   *   nodes: any[],
   *   edges: any[],
   *   analysis: string
   * }}
   */
  retrieve(opts = {}) {
    const requestedHops = Number(opts.maxHops);
    const maxHops = Number.isFinite(requestedHops)
      ? Math.max(0, Math.min(Math.floor(requestedHops), 5))
      : 2;
    const requestedNodes = Number(opts.maxNodes);
    const maxNodes = Number.isFinite(requestedNodes)
      ? Math.max(1, Math.min(Math.floor(requestedNodes), 100))
      : 30;
    const requestedWeight = Number(opts.minWeight);
    const minWeight = Number.isFinite(requestedWeight)
      ? Math.max(0, Math.min(requestedWeight, 2))
      : 0.15;
    const allowedRegions = new Set(
      (opts.regions && opts.regions.length > 0)
        ? opts.regions
        : ALL_REGIONS.filter(r => r !== REGIONS.TEMPORARY)
    );

    const visitedNodes = new Set();
    const visitedEdges = new Set();
    const hopResults = [];
    let frontier = [];

    // ---- Hop 0: seed ----
    if (opts.seedEntityIds && opts.seedEntityIds.length > 0) {
      for (const id of opts.seedEntityIds) {
        const ent = this.tkg.db.prepare(
          `SELECT * FROM entities WHERE id = ? AND is_active = 1`
        ).get(id);
        if (ent && allowedRegions.has(ent.memory_category || REGIONS.LONG_TERM)) {
          frontier.push(ent);
          visitedNodes.add(ent.id);
        }
      }
    }

    if (frontier.length === 0 && opts.query) {
      // Use existing FTS / search path if available
      const hits = typeof this.tkg.searchEntities === 'function'
        ? this.tkg.searchEntities(opts.query, { limit: 12 })
        : this._fallbackEntitySearch(opts.query, 12);

      for (const h of hits) {
        if (allowedRegions.has(h.memory_category || REGIONS.LONG_TERM) && !visitedNodes.has(h.id)) {
          frontier.push(h);
          visitedNodes.add(h.id);
        }
      }
    }

    hopResults.push({ hop: 0, nodes: [...frontier], edges: [] });

    // ---- Subsequent hops ----
    for (let hop = 1; hop <= maxHops; hop++) {
      if (frontier.length === 0 || visitedNodes.size >= maxNodes) break;

      const nextFrontier = [];
      const hopEdges = [];

      for (const node of frontier) {
        const edges = this.tkg.db.prepare(`
          SELECT e.*, 
                 CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END AS other_id
          FROM entity_edges e
          WHERE (e.source_id = ? OR e.target_id = ?)
            AND e.weight >= ?
            AND (e.valid_until IS NULL OR datetime(e.valid_until) > datetime('now'))
          ORDER BY e.weight DESC
          LIMIT 8
        `).all(node.id, node.id, node.id, minWeight);

        for (const edge of edges) {
          if (visitedEdges.has(edge.id)) continue;
          visitedEdges.add(edge.id);

          const other = this.tkg.db.prepare(
            `SELECT * FROM entities WHERE id = ? AND is_active = 1`
          ).get(edge.other_id);

          if (!other) continue;
          if (!allowedRegions.has(other.memory_category || REGIONS.LONG_TERM)) continue;

          hopEdges.push(edge);

          // Strengthen edge – usage-based proximity
          this._recordUsage(edge.id);

          if (!visitedNodes.has(other.id) && visitedNodes.size < maxNodes) {
            visitedNodes.add(other.id);
            nextFrontier.push(other);
          }
        }
      }

      hopResults.push({ hop, nodes: [...nextFrontier], edges: hopEdges });
      frontier = nextFrontier;
    }

    // Collect final unique sets
    const allNodes = [];
    const allEdges = [];
    const seenN = new Set();
    const seenE = new Set();
    for (const h of hopResults) {
      for (const n of h.nodes) {
        if (!seenN.has(n.id)) { seenN.add(n.id); allNodes.push(n); }
      }
      for (const e of h.edges) {
        if (!seenE.has(e.id)) { seenE.add(e.id); allEdges.push(e); }
      }
    }

    const analysis = this._buildAnalysis(hopResults, opts.query);

    return {
      hops: hopResults,
      nodes: allNodes,
      edges: allEdges,
      analysis,
    };
  }

  /**
   * Record that an edge was traversed → increase usage_count & weight slightly.
   */
  _recordUsage(edgeId) {
    try {
      this.tkg.db.prepare(`
        UPDATE entity_edges
        SET usage_count = COALESCE(usage_count, 0) + 1,
            last_used_at = datetime('now'),
            weight = MIN(2.0, weight + 0.05),
            updated_at = datetime('now')
        WHERE id = ?
      `).run(edgeId);
    } catch (_) {
      // Column may not exist yet on very old DBs; migration will add it.
    }
  }

  _fallbackEntitySearch(query, limit) {
    const q = `%${(query || '').slice(0, 80)}%`;
    return this.tkg.db.prepare(`
      SELECT * FROM entities
      WHERE is_active = 1 AND (name LIKE ? OR attributes LIKE ?)
      ORDER BY access_count DESC
      LIMIT ?
    `).all(q, q, limit);
  }

  _buildAnalysis(hopResults, query) {
    const lines = [`Multi-hop retrieval for: "${query || '(seed entities)'}"`];
    for (const h of hopResults) {
      lines.push(`  Hop ${h.hop}: ${h.nodes.length} nodes, ${h.edges.length} edges`);
    }
    const totalNodes = hopResults.reduce((s, h) => s + h.nodes.length, 0);
    lines.push(`Total unique nodes collected: ${totalNodes}`);
    return lines.join('\n');
  }
}

module.exports = MultiHopRetriever;
