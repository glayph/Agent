'use strict';

const crypto = require('crypto');

/** Scope-isolated backend retrieval graph sharing the TKG SQLite connection. */
class NodeGraph {
  constructor(db, options = {}) {
    if (!db) throw new Error('NodeGraph requires an initialized SQLite database');
    this.db = db;
    this.defaultScope = this.normalizeScope(options.scope || {
      agentId: process.env.MIKI_AGENT_ID || 'miki',
      ownerId: process.env.MIKI_OWNER_ID || 'default-owner',
      workspaceId: process.env.MIKI_WORKSPACE_ID || 'default-workspace',
    });
  }

  normalizeScope(scope = {}) {
    const input = { ...this.defaultScope, ...(scope || {}) };
    const agentId = String(input.agentId || input.agent_id || '').trim() || 'miki';
    const ownerId = String(input.ownerId || input.owner_id || '').trim() || 'default-owner';
    const workspaceId = String(input.workspaceId || input.workspace_id || '').trim() || 'default-workspace';
    return {
      agentId,
      ownerId,
      workspaceId,
      scopeKey: [agentId, ownerId, workspaceId].map(encodeURIComponent).join(':'),
    };
  }

  initializeSync() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS node_graph_nodes (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL DEFAULT 'miki:default-owner:default-workspace',
        agent_id TEXT NOT NULL DEFAULT 'miki',
        owner_id TEXT NOT NULL DEFAULT 'default-owner',
        workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
        node_key TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'memory',
        label TEXT,
        context TEXT NOT NULL DEFAULT '{}',
        access_count INTEGER NOT NULL DEFAULT 0,
        activation REAL NOT NULL DEFAULT 0.0,
        last_used_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_key, node_key)
      );
      CREATE INDEX IF NOT EXISTS idx_node_graph_nodes_scope_kind ON node_graph_nodes(scope_key, kind);
      CREATE INDEX IF NOT EXISTS idx_node_graph_nodes_scope_activation ON node_graph_nodes(scope_key, activation DESC);
      CREATE INDEX IF NOT EXISTS idx_node_graph_nodes_scope_usage ON node_graph_nodes(scope_key, access_count DESC);
      CREATE TABLE IF NOT EXISTS node_graph_edges (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL DEFAULT 'miki:default-owner:default-workspace',
        agent_id TEXT NOT NULL DEFAULT 'miki',
        owner_id TEXT NOT NULL DEFAULT 'default-owner',
        workspace_id TEXT NOT NULL DEFAULT 'default-workspace',
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'related',
        weight REAL NOT NULL DEFAULT 0.1,
        usage_count INTEGER NOT NULL DEFAULT 0,
        last_used_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_key, source_id, target_id, relation),
        FOREIGN KEY (source_id) REFERENCES node_graph_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES node_graph_nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_node_graph_edges_scope_source ON node_graph_edges(scope_key, source_id);
      CREATE INDEX IF NOT EXISTS idx_node_graph_edges_scope_target ON node_graph_edges(scope_key, target_id);
      CREATE INDEX IF NOT EXISTS idx_node_graph_edges_scope_usage ON node_graph_edges(scope_key, usage_count DESC);
    `);
    this._migrateScopeColumns('node_graph_nodes');
    this._migrateScopeColumns('node_graph_edges');
    return this;
  }

  _migrateScopeColumns(table) {
    const columns = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
    const scope = this.defaultScope;
    const additions = [
      ['scope_key', `TEXT NOT NULL DEFAULT '${scope.scopeKey.replace(/'/g, "''")}'`],
      ['agent_id', `TEXT NOT NULL DEFAULT '${scope.agentId.replace(/'/g, "''")}'`],
      ['owner_id', `TEXT NOT NULL DEFAULT '${scope.ownerId.replace(/'/g, "''")}'`],
      ['workspace_id', `TEXT NOT NULL DEFAULT '${scope.workspaceId.replace(/'/g, "''")}'`],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_scope ON ${table}(scope_key)`);
  }

  _scope(input) { return this.normalizeScope(input); }
  _now() { return new Date().toISOString(); }
  _idFromKey(key, scopeKey = this.defaultScope.scopeKey) {
    return `node-${crypto.createHash('sha256').update(`${scopeKey}:${String(key)}`).digest('hex').slice(0, 24)}`;
  }
  _parse(value, fallback = {}) {
    if (!value) return fallback;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : fallback; } catch { return fallback; }
  }
  _mergeContext(previous, next) { return JSON.stringify({ ...this._parse(previous, {}), ...(next && typeof next === 'object' ? next : {}) }); }

  _resolveId(idOrKey, scopeInput) {
    if (!idOrKey) return null;
    const scope = this._scope(scopeInput);
    const direct = this.db.prepare('SELECT id FROM node_graph_nodes WHERE id = ? AND scope_key = ?').get(String(idOrKey), scope.scopeKey);
    if (direct) return direct.id;
    const byKey = this.db.prepare('SELECT id FROM node_graph_nodes WHERE node_key = ? AND scope_key = ?').get(String(idOrKey), scope.scopeKey);
    return byKey ? byKey.id : null;
  }

  upsertNode({ id, key, nodeKey, kind = 'memory', label = '', context = {}, scope } = {}) {
    const normalizedScope = this._scope(scope);
    const resolvedKey = String(nodeKey || key || id || '').trim();
    if (!resolvedKey) throw new Error('NodeGraph node requires a key or id');
    const nodeId = id && normalizedScope.scopeKey === this.defaultScope.scopeKey
      ? String(id)
      : (id ? this._idFromKey(id, normalizedScope.scopeKey) : this._idFromKey(resolvedKey, normalizedScope.scopeKey));
    const now = this._now();
    const byId = this.db.prepare('SELECT * FROM node_graph_nodes WHERE id = ? AND scope_key = ?').get(nodeId, normalizedScope.scopeKey);
    const byKey = this.db.prepare('SELECT * FROM node_graph_nodes WHERE node_key = ? AND scope_key = ?').get(resolvedKey, normalizedScope.scopeKey);
    if (byId && byKey && byId.id !== byKey.id) throw new Error(`NodeGraph id/key conflict: id "${nodeId}" and key "${resolvedKey}" refer to different nodes`);
    const existing = byId || byKey;
    if (existing) {
      this.db.prepare(`UPDATE node_graph_nodes SET node_key = ?, kind = ?, label = ?, context = ?, updated_at = ? WHERE id = ? AND scope_key = ?`)
        .run(resolvedKey, kind, String(label || ''), this._mergeContext(existing.context, context), now, existing.id, normalizedScope.scopeKey);
      return existing.id;
    }
    this.db.prepare(`INSERT INTO node_graph_nodes
      (id, scope_key, agent_id, owner_id, workspace_id, node_key, kind, label, context, access_count, activation, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0.0, ?, ?)`)
      .run(nodeId, normalizedScope.scopeKey, normalizedScope.agentId, normalizedScope.ownerId, normalizedScope.workspaceId, resolvedKey, kind, String(label || ''), JSON.stringify(context || {}), now, now);
    return nodeId;
  }

  updateContext(idOrKey, contextPatch = {}, scope) {
    const normalizedScope = this._scope(scope);
    const id = this._resolveId(idOrKey, normalizedScope);
    if (!id) return null;
    const existing = this.db.prepare('SELECT context FROM node_graph_nodes WHERE id = ? AND scope_key = ?').get(id, normalizedScope.scopeKey);
    this.db.prepare('UPDATE node_graph_nodes SET context = ?, updated_at = ? WHERE id = ? AND scope_key = ?')
      .run(this._mergeContext(existing?.context, contextPatch), this._now(), id, normalizedScope.scopeKey);
    return id;
  }

  recordUsage(idOrKey, amount = 1, scope) {
    const normalizedScope = this._scope(scope);
    const id = this._resolveId(idOrKey, normalizedScope);
    if (!id) return null;
    const count = Math.max(1, Number.isFinite(Number(amount)) ? Math.floor(Number(amount)) : 1);
    const now = this._now();
    this.db.prepare(`UPDATE node_graph_nodes SET access_count = access_count + ?, activation = MIN(1.0, COALESCE(activation, 0.0) * 0.92 + MIN(0.24, 0.08 * ?)), last_used_at = ?, updated_at = ? WHERE id = ? AND scope_key = ?`)
      .run(count, count, now, now, id, normalizedScope.scopeKey);
    this.db.prepare(`UPDATE node_graph_edges SET usage_count = usage_count + 1, weight = MIN(1.0, weight + 0.02), last_used_at = ?, updated_at = ? WHERE scope_key = ? AND (source_id = ? OR target_id = ?)`)
      .run(now, now, normalizedScope.scopeKey, id, id);
    return id;
  }

  connect(sourceIdOrKey, targetIdOrKey, relation = 'related', metadata = {}, weight = 0.2, scope) {
    const normalizedScope = this._scope(scope);
    const sourceId = this._resolveId(sourceIdOrKey, normalizedScope);
    const targetId = this._resolveId(targetIdOrKey, normalizedScope);
    if (!sourceId || !targetId || sourceId === targetId) return null;
    const now = this._now();
    const existing = this.db.prepare('SELECT id FROM node_graph_edges WHERE scope_key = ? AND source_id = ? AND target_id = ? AND relation = ?').get(normalizedScope.scopeKey, sourceId, targetId, relation);
    if (existing) {
      this.db.prepare('UPDATE node_graph_edges SET weight = MIN(1.0, weight + 0.04), usage_count = usage_count + 1, last_used_at = ?, updated_at = ?, metadata = ? WHERE id = ? AND scope_key = ?')
        .run(now, now, JSON.stringify(metadata || {}), existing.id, normalizedScope.scopeKey);
      return existing.id;
    }
    const edgeId = `edge-${crypto.randomUUID()}`;
    this.db.prepare(`INSERT INTO node_graph_edges (id, scope_key, agent_id, owner_id, workspace_id, source_id, target_id, relation, weight, usage_count, last_used_at, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`)
      .run(edgeId, normalizedScope.scopeKey, normalizedScope.agentId, normalizedScope.ownerId, normalizedScope.workspaceId, sourceId, targetId, relation, Math.max(0, Math.min(1, Number(weight) || 0.2)), now, JSON.stringify(metadata || {}), now, now);
    return edgeId;
  }

  _tokens(text) { return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 1).slice(0, 32); }
  _recency(lastUsedAt) { if (!lastUsedAt) return 0.35; return Math.exp(-Math.max(0, (Date.now() - Date.parse(lastUsedAt)) / 86400000) / 30); }
  _score(node, tokens) {
    const contextText = JSON.stringify(this._parse(node.context, {})).toLowerCase();
    const haystack = `${node.node_key} ${node.kind} ${node.label || ''} ${contextText}`.toLowerCase();
    const matches = tokens.length === 0 ? 0 : tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
    return (tokens.length === 0 ? 0 : matches / tokens.length) * 0.58 + Math.min(1, node.activation || 0) * 0.24 + Math.min(1, Math.log1p(Math.max(0, node.access_count || 0)) / 6) * 0.12 + this._recency(node.last_used_at) * 0.06;
  }

  retrieve(query = '', limit = 8, scope) {
    const normalizedScope = this._scope(scope);
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 8));
    const tokens = this._tokens(query);
    const allNodes = this.db.prepare('SELECT * FROM node_graph_nodes WHERE scope_key = ? ORDER BY activation DESC, access_count DESC LIMIT 500').all(normalizedScope.scopeKey);
    const scored = allNodes.map(node => ({ node, score: this._score(node, tokens) })).filter(item => tokens.length === 0 || item.score > 0.05).sort((a, b) => b.score - a.score || String(b.node.updated_at).localeCompare(String(a.node.updated_at))).slice(0, safeLimit);
    const selected = []; const selectedIds = new Set();
    for (const item of scored) {
      if (!selectedIds.has(item.node.id)) { selected.push(item); selectedIds.add(item.node.id); }
      const neighbours = this.db.prepare(`SELECT n.*, e.weight AS edge_weight, e.relation, e.usage_count AS edge_usage FROM node_graph_edges e JOIN node_graph_nodes n ON n.id = CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END WHERE e.scope_key = ? AND n.scope_key = ? AND (e.source_id = ? OR e.target_id = ?) ORDER BY e.weight DESC, e.usage_count DESC LIMIT 4`).all(item.node.id, normalizedScope.scopeKey, normalizedScope.scopeKey, item.node.id, item.node.id);
      for (const neighbour of neighbours) { if (selected.length >= safeLimit) break; if (!selectedIds.has(neighbour.id)) { selected.push({ node: neighbour, score: this._score(neighbour, tokens) * 0.82 + (neighbour.edge_weight || 0) * 0.18 }); selectedIds.add(neighbour.id); } }
      if (selected.length >= safeLimit) break;
    }
    for (const item of selected) this.recordUsage(item.node.id, 1, normalizedScope);
    return selected.map(({ node, score }) => ({ id: node.id, key: node.node_key, kind: node.kind, label: node.label, context: this._parse(node.context, {}), accessCount: node.access_count, activation: node.activation, lastUsedAt: node.last_used_at, score: Number(score.toFixed(6)) }));
  }

  getContext(query = '', limit = 8, scope) { return this.retrieve(query, limit, scope).map(node => ({ ...node, text: node.context.text || node.context.summary || node.label || node.key })); }

  snapshot(limit = 100, scope) {
    const normalizedScope = this._scope(scope);
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    const nodes = this.db.prepare(`SELECT id, node_key AS key, kind, label, context, access_count AS accessCount, activation, last_used_at AS lastUsedAt, created_at AS createdAt, updated_at AS updatedAt FROM node_graph_nodes WHERE scope_key = ? ORDER BY activation DESC, access_count DESC LIMIT ?`).all(normalizedScope.scopeKey, safeLimit).map(node => ({ ...node, context: this._parse(node.context, {}) }));
    const edges = this.db.prepare(`SELECT id, source_id AS sourceId, target_id AS targetId, relation, weight, usage_count AS usageCount, last_used_at AS lastUsedAt, metadata FROM node_graph_edges WHERE scope_key = ? ORDER BY weight DESC, usage_count DESC LIMIT ?`).all(normalizedScope.scopeKey, safeLimit).map(edge => ({ ...edge, metadata: this._parse(edge.metadata, {}) }));
    return { nodes, edges };
  }

  getStats(scope) {
    const scopeKey = this._scope(scope).scopeKey;
    return {
      nodes: this.db.prepare('SELECT COUNT(*) AS count FROM node_graph_nodes WHERE scope_key = ?').get(scopeKey).count,
      edges: this.db.prepare('SELECT COUNT(*) AS count FROM node_graph_edges WHERE scope_key = ?').get(scopeKey).count,
      activeNodes: this.db.prepare('SELECT COUNT(*) AS count FROM node_graph_nodes WHERE scope_key = ? AND activation >= 0.25').get(scopeKey).count,
    };
  }
}

module.exports = NodeGraph;
module.exports.NodeGraph = NodeGraph;
