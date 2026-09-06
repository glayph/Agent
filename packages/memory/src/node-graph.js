'use strict';

const crypto = require('crypto');

/**
 * Backend-only context graph.
 *
 * TemporalKnowledgeGraph remains the durable event/history store. NodeGraph is
 * the compact retrieval layer on top of the same SQLite connection: every
 * node keeps a JSON context object, every edge keeps usage statistics, and
 * retrieval proximity is influenced by activation, recency, and repeated use.
 * No UI/API representation is required for this class.
 */
class NodeGraph {
  constructor(db) {
    if (!db) throw new Error('NodeGraph requires an initialized SQLite database');
    this.db = db;
  }

  initializeSync() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS node_graph_nodes (
        id TEXT PRIMARY KEY,
        node_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'memory',
        label TEXT,
        context TEXT NOT NULL DEFAULT '{}',
        access_count INTEGER NOT NULL DEFAULT 0,
        activation REAL NOT NULL DEFAULT 0.0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_node_graph_nodes_kind ON node_graph_nodes(kind);
      CREATE INDEX IF NOT EXISTS idx_node_graph_nodes_activation ON node_graph_nodes(activation DESC);
      CREATE INDEX IF NOT EXISTS idx_node_graph_nodes_usage ON node_graph_nodes(access_count DESC);

      CREATE TABLE IF NOT EXISTS node_graph_edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'related',
        weight REAL NOT NULL DEFAULT 0.1,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_id, target_id, relation),
        FOREIGN KEY (source_id) REFERENCES node_graph_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES node_graph_nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_node_graph_edges_source ON node_graph_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_node_graph_edges_target ON node_graph_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_node_graph_edges_usage ON node_graph_edges(usage_count DESC);
    `);
    return this;
  }

  _now() {
    return new Date().toISOString();
  }

  _idFromKey(key) {
    const digest = crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 24);
    return `node-${digest}`;
  }

  _parse(value, fallback = {}) {
    if (!value) return fallback;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  _mergeContext(previous, next) {
    const oldContext = this._parse(previous, {});
    const newContext = next && typeof next === 'object' ? next : {};
    return JSON.stringify({ ...oldContext, ...newContext });
  }

  _resolveId(idOrKey) {
    if (!idOrKey) return null;
    const direct = this.db.prepare('SELECT id FROM node_graph_nodes WHERE id = ?').get(String(idOrKey));
    if (direct) return direct.id;
    const byKey = this.db.prepare('SELECT id FROM node_graph_nodes WHERE node_key = ?').get(String(idOrKey));
    return byKey ? byKey.id : null;
  }

  upsertNode({ id, key, nodeKey, kind = 'memory', label = '', context = {} } = {}) {
    const resolvedKey = String(nodeKey || key || id || '').trim();
    if (!resolvedKey) throw new Error('NodeGraph node requires a key or id');
    const nodeId = String(id || this._idFromKey(resolvedKey));
    const now = this._now();
    const byId = this.db.prepare('SELECT * FROM node_graph_nodes WHERE id = ?').get(nodeId);
    const byKey = this.db.prepare('SELECT * FROM node_graph_nodes WHERE node_key = ?').get(resolvedKey);
    if (byId && byKey && byId.id !== byKey.id) {
      throw new Error(`NodeGraph id/key conflict: id "${nodeId}" and key "${resolvedKey}" refer to different nodes`);
    }
    const existing = byId || byKey;
    if (existing) {
      const mergedContext = this._mergeContext(existing.context, context);
      this.db.prepare(`
        UPDATE node_graph_nodes
        SET node_key = ?, kind = ?, label = ?, context = ?, updated_at = ?
        WHERE id = ?
      `).run(resolvedKey, kind, String(label || ''), mergedContext, now, existing.id);
      return existing.id;
    }
    this.db.prepare(`
      INSERT INTO node_graph_nodes
        (id, node_key, kind, label, context, access_count, activation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 0.0, ?, ?)
    `).run(nodeId, resolvedKey, kind, String(label || ''), JSON.stringify(context || {}), now, now);
    return nodeId;
  }

  updateContext(idOrKey, contextPatch = {}) {
    const id = this._resolveId(idOrKey);
    if (!id) return null;
    const existing = this.db.prepare('SELECT context FROM node_graph_nodes WHERE id = ?').get(id);
    const now = this._now();
    this.db.prepare('UPDATE node_graph_nodes SET context = ?, updated_at = ? WHERE id = ?')
      .run(this._mergeContext(existing?.context, contextPatch), now, id);
    return id;
  }

  recordUsage(idOrKey, amount = 1) {
    const id = this._resolveId(idOrKey);
    if (!id) return null;
    const count = Math.max(1, Number.isFinite(Number(amount)) ? Math.floor(Number(amount)) : 1);
    const now = this._now();
    this.db.prepare(`
      UPDATE node_graph_nodes
      SET access_count = access_count + ?,
          activation = MIN(1.0, COALESCE(activation, 0.0) * 0.92 + MIN(0.24, 0.08 * ?)),
          last_used_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(count, count, now, now, id);
    this.db.prepare(`
      UPDATE node_graph_edges
      SET usage_count = usage_count + 1,
          weight = MIN(1.0, weight + 0.02),
          last_used_at = ?,
          updated_at = ?
      WHERE source_id = ? OR target_id = ?
    `).run(now, now, id, id);
    return id;
  }

  connect(sourceIdOrKey, targetIdOrKey, relation = 'related', metadata = {}, weight = 0.2) {
    const sourceId = this._resolveId(sourceIdOrKey);
    const targetId = this._resolveId(targetIdOrKey);
    if (!sourceId || !targetId || sourceId === targetId) return null;
    const now = this._now();
    const existing = this.db.prepare(`
      SELECT id FROM node_graph_edges
      WHERE source_id = ? AND target_id = ? AND relation = ?
    `).get(sourceId, targetId, relation);
    if (existing) {
      this.db.prepare(`
        UPDATE node_graph_edges
        SET weight = MIN(1.0, weight + 0.04),
            usage_count = usage_count + 1,
            last_used_at = ?, updated_at = ?, metadata = ?
        WHERE id = ?
      `).run(now, now, JSON.stringify(metadata || {}), existing.id);
      return existing.id;
    }
    const edgeId = `edge-${crypto.randomUUID()}`;
    this.db.prepare(`
      INSERT INTO node_graph_edges
        (id, source_id, target_id, relation, weight, usage_count, last_used_at, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(edgeId, sourceId, targetId, relation, Math.max(0, Math.min(1, Number(weight) || 0.2)), now, JSON.stringify(metadata || {}), now, now);
    return edgeId;
  }

  _tokens(text) {
    return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 1).slice(0, 32);
  }

  _recency(lastUsedAt) {
    if (!lastUsedAt) return 0.35;
    const ageDays = Math.max(0, (Date.now() - Date.parse(lastUsedAt)) / 86400000);
    return Math.exp(-ageDays / 30);
  }

  _score(node, tokens) {
    const contextText = JSON.stringify(this._parse(node.context, {})).toLowerCase();
    const haystack = `${node.node_key} ${node.kind} ${node.label || ''} ${contextText}`.toLowerCase();
    const matches = tokens.length === 0 ? 0 : tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    const lexical = tokens.length === 0 ? 0 : matches / tokens.length;
    const usage = Math.log1p(Math.max(0, node.access_count || 0)) / 6;
    const recency = this._recency(node.last_used_at);
    return lexical * 0.58 + Math.min(1, node.activation || 0) * 0.24 + Math.min(1, usage) * 0.12 + recency * 0.06;
  }

  retrieve(query = '', limit = 8) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 8));
    const tokens = this._tokens(query);
    const allNodes = this.db.prepare('SELECT * FROM node_graph_nodes ORDER BY activation DESC, access_count DESC LIMIT 500').all();
    const scored = allNodes.map(node => ({ node, score: this._score(node, tokens) }))
      .filter(item => tokens.length === 0 || item.score > 0.05)
      .sort((a, b) => b.score - a.score || String(b.node.updated_at).localeCompare(String(a.node.updated_at)))
      .slice(0, safeLimit);

    const selected = [];
    const selectedIds = new Set();
    for (const item of scored) {
      if (!selectedIds.has(item.node.id)) {
        selected.push(item);
        selectedIds.add(item.node.id);
      }
      const neighbours = this.db.prepare(`
        SELECT n.*, e.weight AS edge_weight, e.relation, e.usage_count AS edge_usage
        FROM node_graph_edges e
        JOIN node_graph_nodes n ON n.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END
        WHERE e.source_id = ? OR e.target_id = ?
        ORDER BY e.weight DESC, e.usage_count DESC LIMIT 4
      `).all(item.node.id, item.node.id, item.node.id);
      for (const neighbour of neighbours) {
        if (selected.length >= safeLimit) break;
        if (!selectedIds.has(neighbour.id)) {
          selected.push({ node: neighbour, score: this._score(neighbour, tokens) * 0.82 + (neighbour.edge_weight || 0) * 0.18 });
          selectedIds.add(neighbour.id);
        }
      }
      if (selected.length >= safeLimit) break;
    }

    for (const item of selected) this.recordUsage(item.node.id);
    return selected.map(({ node, score }) => ({
      id: node.id,
      key: node.node_key,
      kind: node.kind,
      label: node.label,
      context: this._parse(node.context, {}),
      accessCount: node.access_count,
      activation: node.activation,
      lastUsedAt: node.last_used_at,
      score: Number(score.toFixed(6)),
    }));
  }

  getContext(query = '', limit = 8) {
    return this.retrieve(query, limit).map(node => ({
      ...node,
      text: node.context.text || node.context.summary || node.label || node.key,
    }));
  }

  snapshot(limit = 100) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const nodes = this.db.prepare(`
      SELECT id, node_key AS key, kind, label, context, access_count AS accessCount,
             activation, last_used_at AS lastUsedAt, created_at AS createdAt, updated_at AS updatedAt
      FROM node_graph_nodes
      ORDER BY activation DESC, access_count DESC LIMIT ?
    `).all(safeLimit).map(node => ({ ...node, context: this._parse(node.context, {}) }));
    const edges = this.db.prepare(`
      SELECT id, source_id AS sourceId, target_id AS targetId, relation, weight,
             usage_count AS usageCount, last_used_at AS lastUsedAt, metadata
      FROM node_graph_edges ORDER BY weight DESC, usage_count DESC LIMIT ?
    `).all(safeLimit).map(edge => ({ ...edge, metadata: this._parse(edge.metadata, {}) }));
    return { nodes, edges };
  }

  getStats() {
    const nodes = this.db.prepare('SELECT COUNT(*) AS count FROM node_graph_nodes').get().count;
    const edges = this.db.prepare('SELECT COUNT(*) AS count FROM node_graph_edges').get().count;
    const active = this.db.prepare('SELECT COUNT(*) AS count FROM node_graph_nodes WHERE activation >= 0.25').get().count;
    return { nodes, edges, activeNodes: active };
  }
}

module.exports = NodeGraph;
module.exports.NodeGraph = NodeGraph;
