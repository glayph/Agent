'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_CATEGORIES = [
  ['conversation', 'Conversation', 'Stable information from ordinary conversations.'],
  ['personality', 'Personality', 'Identity, communication style and preferences.'],
  ['design', 'Design', 'UX, architecture and design decisions.'],
  ['project_context', 'Project context', 'Temporary knowledge for an active project.'],
  ['procedural', 'Procedural', 'Reusable workflows, skills and tool sequences.'],
  ['policy', 'Policy', 'Rules, constraints and behavioral guidelines.'],
  ['episodic', 'Episodic', 'Important events, outcomes, failures and lessons.'],
];

const RELATIONS = Object.freeze([
  'PREFERS', 'RELATED_TO', 'PART_OF', 'DERIVED_FROM', 'CONTRADICTS',
  'SUPERSEDES', 'DEPENDS_ON', 'USED_WITH', 'CAUSED', 'SUCCEEDED_IN',
  'FAILED_IN', 'APPLIES_TO', 'CONTACT_OF', 'BELONGS_TO_PROJECT',
]);

const REGION_TO_CATEGORY = Object.freeze({
  long_term: 'conversation',
  daily: 'episodic',
  static: 'conversation',
  skill: 'procedural',
  rule_emotion: 'policy',
  temporary: 'project_context',
});

function nowIso() { return new Date().toISOString(); }
function clamp(value, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(value) || 0)); }
function json(value, fallback = {}) {
  try { return JSON.stringify(value == null ? fallback : value); } catch { return JSON.stringify(fallback); }
}
function parse(value, fallback = {}) {
  if (!value) return fallback;
  try { const result = JSON.parse(value); return result && typeof result === 'object' ? result : fallback; } catch { return fallback; }
}
function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }

class GraphCognitiveMemory {
  constructor(dbOrPath, options = {}) {
    this.db = dbOrPath && typeof dbOrPath.prepare === 'function' ? dbOrPath : null;
    this.dbPath = typeof dbOrPath === 'string' ? dbOrPath : options.dbPath;
    this.options = {
      maxGraphDepth: 2,
      maxCandidates: 500,
      maxInjectedMemories: 12,
      maxInjectedTokens: 1200,
      projectInactivityDays: 30,
      recencyHalfLifeDays: 30,
      categoryRecurrenceThreshold: 2,
      defaultScope: { agentId: 'default-agent', ownerId: 'default-owner', workspaceId: 'default-workspace' },
      ...options,
    };
    this.initialized = false;
  }

  initializeSync() {
    if (this.initialized) return this;
    if (!this.db) {
      if (!this.dbPath) throw new Error('GraphCognitiveMemory requires a SQLite db or dbPath');
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    }
    this._createSchema();
    this._seedCategories();
    this.initialized = true;
    return this;
  }

  async initialize() { return this.initializeSync(); }

  _createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_categories (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        slug TEXT NOT NULL,
        label TEXT NOT NULL,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_key, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_categories_scope ON memory_categories(scope_key);

      CREATE TABLE IF NOT EXISTS memory_nodes (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        project_id TEXT,
        category_id TEXT NOT NULL,
        memory_type TEXT NOT NULL,
        content TEXT NOT NULL,
        structured_value TEXT,
        source_type TEXT,
        source_reference TEXT,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        explicit_importance REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.7,
        semantic_relevance REAL NOT NULL DEFAULT 0.0,
        graph_relevance REAL NOT NULL DEFAULT 0.0,
        recency_score REAL NOT NULL DEFAULT 1.0,
        frequency_score REAL NOT NULL DEFAULT 0.0,
        relationship_strength REAL NOT NULL DEFAULT 0.0,
        activation_score REAL NOT NULL DEFAULT 0.0,
        status TEXT NOT NULL DEFAULT 'active',
        review_at TEXT,
        expires_at TEXT,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        is_archived INTEGER NOT NULL DEFAULT 0,
        metadata TEXT NOT NULL DEFAULT '{}',
        embedding TEXT,
        UNIQUE(scope_key, fingerprint),
        FOREIGN KEY(category_id) REFERENCES memory_categories(id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_scope_status ON memory_nodes(scope_key, status, is_archived);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_scope_activation ON memory_nodes(scope_key, activation_score DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_project ON memory_nodes(scope_key, project_id);
      CREATE INDEX IF NOT EXISTS idx_memory_nodes_source ON memory_nodes(scope_key, source_type, source_reference);

      CREATE TABLE IF NOT EXISTS memory_edges (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        source_node_id TEXT NOT NULL,
        target_node_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.2,
        confidence REAL NOT NULL DEFAULT 0.7,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_traversed_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(scope_key, source_node_id, target_node_id, relation_type),
        FOREIGN KEY(source_node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE,
        FOREIGN KEY(target_node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_edges_scope_source ON memory_edges(scope_key, source_node_id);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_scope_target ON memory_edges(scope_key, target_node_id);
      CREATE INDEX IF NOT EXISTS idx_memory_edges_relation ON memory_edges(scope_key, relation_type);

      CREATE TABLE IF NOT EXISTS memory_access_events (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        node_id TEXT NOT NULL,
        task_reference TEXT,
        retrieved INTEGER NOT NULL DEFAULT 1,
        used INTEGER NOT NULL DEFAULT 0,
        useful INTEGER,
        created_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_access_scope_node ON memory_access_events(scope_key, node_id, created_at);

      CREATE TABLE IF NOT EXISTS memory_revisions (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        node_id TEXT NOT NULL,
        revision_type TEXT NOT NULL,
        previous_content TEXT,
        current_content TEXT,
        source_reference TEXT,
        created_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(node_id) REFERENCES memory_nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_memory_revisions_node ON memory_revisions(scope_key, node_id, created_at);

      CREATE TABLE IF NOT EXISTS project_contexts (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        project_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        relevance_boost REAL NOT NULL DEFAULT 0.15,
        opened_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        closed_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(scope_key, project_id)
      );
      CREATE INDEX IF NOT EXISTS idx_project_contexts_status ON project_contexts(scope_key, status, last_active_at);
    `);
  }

  _seedCategories() {
    const insert = this.db.prepare(`
      INSERT INTO memory_categories (id, scope_key, slug, label, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key, slug) DO UPDATE SET label=excluded.label, description=excluded.description, updated_at=excluded.updated_at
    `);
    const tx = this.db.transaction(() => {
      const scope = this.normalizeScope(this.options.defaultScope);
      for (const [slug, label, description] of DEFAULT_CATEGORIES) {
        insert.run(this._categoryId(scope.scopeKey, slug), scope.scopeKey, slug, label, description, nowIso(), nowIso());
      }
    });
    tx();
  }

  normalizeScope(scope = {}) {
    const source = { ...this.options.defaultScope, ...(scope || {}) };
    const agentId = String(source.agentId || source.agent_id || '').trim();
    const ownerId = String(source.ownerId || source.owner_id || '').trim();
    const workspaceId = String(source.workspaceId || source.workspace_id || '').trim();
    if (!agentId || !ownerId || !workspaceId) throw new Error('Memory scope requires agentId, ownerId and workspaceId');
    const projectId = source.projectId || source.project_id ? String(source.projectId || source.project_id) : null;
    const sessionId = source.sessionId || source.session_id ? String(source.sessionId || source.session_id) : null;
    return { agentId, ownerId, workspaceId, projectId, sessionId, scopeKey: [agentId, ownerId, workspaceId].join(':') };
  }

  _categoryId(scopeKey, slug) { return `cat-${hash(`${scopeKey}:${slug}`).slice(0, 24)}`; }
  _nodeId(scopeKey, fingerprint) { return `mem-${hash(`${scopeKey}:${fingerprint}`).slice(0, 32)}`; }
  _edgeId() { return `medge-${crypto.randomUUID()}`; }

  redact(value) {
    return String(value || '')
      .replace(/(api[_ -]?key|token|password|secret|authorization|credential)\s*[:=]\s*[^\s,;]+/gi, '$1: [REDACTED]')
      .replace(/\b(sk|AIza|ghp|xox[baprs]-)[A-Za-z0-9_-]{12,}\b/g, '[REDACTED]');
  }

  _isTransient(content, explicit) {
    if (explicit) return false;
    const normalized = String(content || '').trim().toLowerCase();
    if (!normalized || normalized.length < 8) return true;
    return /^(hi|hello|hey|thanks|thank you|ok|okay|হ্যালো|ধন্যবাদ|ঠিক আছে|আচ্ছা)[!.\s]*$/iu.test(normalized);
  }

  ensureCategory(scopeInput, slug, label, description = '') {
    const scope = this.normalizeScope(scopeInput);
    const safeSlug = String(slug || 'conversation').trim().toLowerCase().replace(/[^a-z0-9_\-]+/g, '_') || 'conversation';
    const existing = this.db.prepare('SELECT id FROM memory_categories WHERE scope_key = ? AND slug = ?').get(scope.scopeKey, safeSlug);
    if (existing) return existing.id;
    const id = this._categoryId(scope.scopeKey, safeSlug);
    const now = nowIso();
    this.db.prepare(`INSERT INTO memory_categories (id, scope_key, slug, label, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, scope.scopeKey, safeSlug, String(label || safeSlug), String(description || ''), now, now);
    return id;
  }

  ingest(input = {}) {
    const scope = this.normalizeScope(input.scope);
    const rawContent = typeof input.content === 'string' ? input.content : JSON.stringify(input.content || '');
    const content = this.redact(rawContent).trim();
    if (this._isTransient(content, input.explicit)) return { stored: false, reason: 'transient' };
    const categorySlug = DEFAULT_CATEGORIES.some(([slug]) => slug === input.category) ? input.category : (input.category || 'conversation');
    const categoryId = this.ensureCategory(scope, categorySlug);
    const memoryType = String(input.memoryType || input.memory_type || 'fact').trim() || 'fact';
    const canonical = content.replace(/\s+/g, ' ').trim();
    const fingerprint = hash(`${categorySlug}|${memoryType}|${canonical.toLowerCase()}`);
    const existing = this.db.prepare('SELECT * FROM memory_nodes WHERE scope_key = ? AND fingerprint = ?').get(scope.scopeKey, fingerprint);
    const now = input.createdAt ? new Date(input.createdAt).toISOString() : nowIso();
    const metadata = input.metadata && typeof input.metadata === 'object' ? input.metadata : {};
    const projectId = input.projectId || scope.projectId || null;
    if (existing) {
      this.db.prepare(`UPDATE memory_nodes SET access_count = access_count + 1, last_accessed_at = ?, updated_at = ?, confidence = MAX(confidence, ?), explicit_importance = MAX(explicit_importance, ?) WHERE id = ?`)
        .run(now, now, clamp(input.confidence, 0, 1) || existing.confidence, clamp(input.explicitImportance, 0, 1) || existing.explicit_importance, existing.id);
      this._recordAccess(scope, existing.id, input.taskReference, false, true, null, { duplicate: true });
      return { stored: false, duplicate: true, nodeId: existing.id, category: categorySlug };
    }
    const nodeId = this._nodeId(scope.scopeKey, fingerprint);
    this.db.prepare(`
      INSERT INTO memory_nodes
      (id, scope_key, agent_id, owner_id, workspace_id, project_id, category_id, memory_type, content, structured_value, source_type, source_reference, fingerprint, created_at, updated_at, last_accessed_at, access_count, explicit_importance, confidence, semantic_relevance, graph_relevance, recency_score, frequency_score, relationship_strength, activation_score, status, review_at, expires_at, is_pinned, is_archived, metadata, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 0, 0, 1, 0.1, 0, 0, 'active', ?, ?, ?, 0, ?, ?)
    `).run(
      nodeId, scope.scopeKey, scope.agentId, scope.ownerId, scope.workspaceId, projectId, categoryId, memoryType, canonical,
      input.structuredValue == null ? null : json(input.structuredValue), input.sourceType || input.source_type || 'conversation', input.sourceReference || input.source_reference || null,
      fingerprint, now, now, now, clamp(input.explicitImportance, 0, 1) || 0.5, clamp(input.confidence, 0, 1) || 0.7, input.reviewAt || null, input.expiresAt || null,
      input.isPinned ? 1 : 0, json(metadata), input.embedding ? json(input.embedding) : null,
    );
    if (projectId) this.touchProject(scope, projectId);
    this._recalculateNode(nodeId, scope);
    this._recordAccess(scope, nodeId, input.taskReference, false, false, null, { created: true });
    return { stored: true, nodeId, category: categorySlug };
  }

  connect(scopeInput, sourceNodeId, targetNodeId, relationType = 'RELATED_TO', options = {}) {
    const scope = this.normalizeScope(scopeInput);
    if (!RELATIONS.includes(relationType)) throw new Error(`Unsupported memory relation: ${relationType}`);
    if (!sourceNodeId || !targetNodeId || sourceNodeId === targetNodeId) return null;
    const source = this.db.prepare('SELECT id FROM memory_nodes WHERE id = ? AND scope_key = ?').get(sourceNodeId, scope.scopeKey);
    const target = this.db.prepare('SELECT id FROM memory_nodes WHERE id = ? AND scope_key = ?').get(targetNodeId, scope.scopeKey);
    if (!source || !target) return null;
    const now = nowIso();
    const existing = this.db.prepare('SELECT id FROM memory_edges WHERE scope_key = ? AND source_node_id = ? AND target_node_id = ? AND relation_type = ?')
      .get(scope.scopeKey, sourceNodeId, targetNodeId, relationType);
    if (existing) {
      this.db.prepare('UPDATE memory_edges SET weight = MIN(1, weight + 0.04), confidence = MAX(confidence, ?), updated_at = ?, metadata = ? WHERE id = ?')
        .run(clamp(options.confidence, 0, 1) || 0.7, now, json(options.metadata || {}), existing.id);
      return existing.id;
    }
    const edgeId = this._edgeId();
    this.db.prepare(`INSERT INTO memory_edges (id, scope_key, agent_id, owner_id, workspace_id, source_node_id, target_node_id, relation_type, weight, confidence, created_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(edgeId, scope.scopeKey, scope.agentId, scope.ownerId, scope.workspaceId, sourceNodeId, targetNodeId, relationType, clamp(options.weight, 0, 1) || 0.2, clamp(options.confidence, 0, 1) || 0.7, now, now, json(options.metadata || {}));
    this._recalculateNode(sourceNodeId, scope);
    this._recalculateNode(targetNodeId, scope);
    return edgeId;
  }

  _tokens(text) { return String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((token) => token.length > 1).slice(0, 32); }
  _recency(lastAccessedAt, now = Date.now()) {
    if (!lastAccessedAt) return 0.35;
    const ageDays = Math.max(0, (now - Date.parse(lastAccessedAt)) / 86400000);
    return Math.exp(-Math.log(2) * ageDays / Math.max(1, this.options.recencyHalfLifeDays));
  }
  _recalculateNode(nodeId, scopeInput) {
    const scope = this.normalizeScope(scopeInput);
    const node = this.db.prepare('SELECT * FROM memory_nodes WHERE id = ? AND scope_key = ?').get(nodeId, scope.scopeKey);
    if (!node) return null;
    const degree = this.db.prepare('SELECT COALESCE(SUM(weight), 0) AS value FROM memory_edges WHERE scope_key = ? AND (source_node_id = ? OR target_node_id = ?)').get(scope.scopeKey, nodeId, nodeId).value;
    const graph = clamp(Number(degree) / 3);
    const recency = this._recency(node.last_accessed_at);
    const frequency = clamp(Math.log1p(node.access_count || 0) / 6);
    const projectBoost = node.project_id ? this._projectBoost(scope, node.project_id) : 0;
    const activation = clamp(0.30 * Number(node.semantic_relevance || 0) + 0.20 * graph + 0.15 * recency + 0.15 * frequency + 0.10 * Number(node.explicit_importance || 0) + 0.10 * Number(node.confidence || 0) + projectBoost);
    this.db.prepare('UPDATE memory_nodes SET graph_relevance = ?, recency_score = ?, frequency_score = ?, relationship_strength = ?, activation_score = ?, updated_at = ? WHERE id = ? AND scope_key = ?')
      .run(graph, recency, frequency, graph, activation, nowIso(), nodeId, scope.scopeKey);
    return activation;
  }

  _projectBoost(scope, projectId) {
    if (!projectId) return 0;
    const project = this.db.prepare('SELECT relevance_boost, status FROM project_contexts WHERE scope_key = ? AND project_id = ?').get(scope.scopeKey, projectId);
    return project && project.status === 'active' ? Number(project.relevance_boost || 0) : 0;
  }

  _reasons(node, lexical, graph, projectBoost) {
    const reasons = [];
    if (lexical >= 0.5) reasons.push('directly matches current request');
    if (graph >= 0.35) reasons.push('strongly connected in memory graph');
    if (node.access_count >= 3) reasons.push('frequently accessed');
    if (this._recency(node.last_accessed_at) >= 0.7) reasons.push('recently used');
    if (projectBoost > 0) reasons.push('active project context boost');
    if (node.is_pinned) reasons.push('explicitly pinned');
    return reasons;
  }

  retrieve(query = '', options = {}) {
    const scope = this.normalizeScope(options.scope);
    const limit = Math.max(1, Math.min(this.options.maxInjectedMemories, Number(options.limit) || this.options.maxInjectedMemories));
    const tokens = this._tokens(query);
    const rows = this.db.prepare(`SELECT n.*, c.slug AS category_slug FROM memory_nodes n JOIN memory_categories c ON c.id = n.category_id WHERE n.scope_key = ? AND n.status = 'active' AND n.is_archived = 0 ORDER BY n.activation_score DESC, n.updated_at DESC LIMIT ?`).all(scope.scopeKey, this.options.maxCandidates);
    const scored = rows.map((node) => {
      const haystack = `${node.content} ${node.memory_type} ${node.category_slug} ${node.source_reference || ''}`.toLowerCase();
      const lexical = tokens.length ? tokens.filter((token) => haystack.includes(token)).length / tokens.length : 0.1;
      const projectBoost = node.project_id ? this._projectBoost(scope, node.project_id) : 0;
      const score = clamp(0.30 * lexical + 0.20 * Number(node.graph_relevance || 0) + 0.15 * Number(node.recency_score || 0) + 0.15 * Number(node.frequency_score || 0) + 0.10 * Number(node.explicit_importance || 0) + 0.10 * Number(node.confidence || 0) + projectBoost);
      return { node, score, lexical, projectBoost };
    }).filter((item) => !tokens.length || item.lexical > 0 || item.node.activation_score >= 0.35)
      .sort((a, b) => b.score - a.score || String(b.node.updated_at).localeCompare(String(a.node.updated_at)));

    const selected = [];
    const selectedIds = new Set();
    const add = (item, via = null) => {
      if (!item || selected.length >= limit || selectedIds.has(item.node.id)) return;
      selectedIds.add(item.node.id);
      selected.push({ ...item, via });
    };
    for (const item of scored) {
      add(item);
      if (selected.length >= limit) break;
      if ((options.maxGraphDepth == null ? this.options.maxGraphDepth : options.maxGraphDepth) >= 1) {
        const neighbors = this.db.prepare(`SELECT n.*, c.slug AS category_slug, e.weight AS edge_weight, e.relation_type FROM memory_edges e JOIN memory_nodes n ON n.id = CASE WHEN e.source_node_id = ? THEN e.target_node_id ELSE e.source_node_id END JOIN memory_categories c ON c.id = n.category_id WHERE e.scope_key = ? AND (e.source_node_id = ? OR e.target_node_id = ?) AND n.status = 'active' AND n.is_archived = 0 ORDER BY e.weight DESC LIMIT 6`).all(item.node.id, scope.scopeKey, item.node.id, item.node.id);
        for (const neighbor of neighbors) {
          const neighborScore = clamp(item.score * 0.82 + Number(neighbor.edge_weight || 0) * 0.18);
          add({ node: neighbor, score: neighborScore, lexical: 0, projectBoost: neighbor.project_id ? this._projectBoost(scope, neighbor.project_id) : 0 }, item.node.id);
        }
      }
      if (selected.length >= limit) break;
    }

    const record = this.db.transaction(() => {
      for (const item of selected) {
        this._recalculateNode(item.node.id, scope);
        this._recordAccess(scope, item.node.id, options.taskReference, true, Boolean(options.used), options.useful, { query: this.redact(query).slice(0, 160), via: item.via });
      }
    });
    record();
    return selected.map((item) => ({
      id: item.node.id,
      text: item.node.content,
      category: item.node.category_slug,
      memoryType: item.node.memory_type,
      sourceType: item.node.source_type,
      sourceReference: item.node.source_reference,
      score: Number(item.score.toFixed(6)),
      reasons: this._reasons(item.node, item.lexical, item.node.graph_relevance, item.projectBoost),
      via: item.via,
    }));
  }

  getContext(query, options = {}) {
    const items = this.retrieve(query, options);
    const maxTokens = Number(options.maxTokens || this.options.maxInjectedTokens);
    let used = 0;
    const lines = [];
    for (const item of items) {
      const words = item.text.split(/\s+/).filter(Boolean);
      if (used + words.length > maxTokens && lines.length) break;
      used += words.length;
      lines.push(`[${item.category}/${item.memoryType}] ${item.text}`);
    }
    return { items: items.slice(0, lines.length), text: lines.join('\n') };
  }

  _recordAccess(scopeInput, nodeId, taskReference, retrieved, used, useful, metadata = {}) {
    const scope = this.normalizeScope(scopeInput);
    const id = `access-${crypto.randomUUID()}`;
    this.db.prepare('INSERT INTO memory_access_events (id, scope_key, node_id, task_reference, retrieved, used, useful, created_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, scope.scopeKey, nodeId, taskReference || null, retrieved ? 1 : 0, used ? 1 : 0, useful == null ? null : (useful ? 1 : 0), nowIso(), json(metadata));
    this.db.prepare('UPDATE memory_nodes SET access_count = access_count + ?, last_accessed_at = ?, updated_at = ? WHERE id = ? AND scope_key = ?')
      .run(retrieved ? 1 : 0, nowIso(), nowIso(), nodeId, scope.scopeKey);
  }

  recordUse(scope, nodeIds = [], useful = true, taskReference = null) {
    for (const nodeId of nodeIds) this._recordAccess(scope, nodeId, taskReference, false, true, useful, { explicitUse: true });
  }

  touchProject(scopeInput, projectId, metadata = {}) {
    const scope = this.normalizeScope(scopeInput);
    const id = `project-${hash(`${scope.scopeKey}:${projectId}`).slice(0, 24)}`;
    const now = nowIso();
    this.db.prepare(`INSERT INTO project_contexts (id, scope_key, project_id, status, relevance_boost, opened_at, last_active_at, metadata) VALUES (?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(scope_key, project_id) DO UPDATE SET status='active', last_active_at=excluded.last_active_at, metadata=excluded.metadata`)
      .run(id, scope.scopeKey, String(projectId), Number(this.options.projectBoost || 0.15), now, now, json(metadata));
    return id;
  }

  closeProject(scopeInput, projectId) {
    const scope = this.normalizeScope(scopeInput);
    this.db.prepare('UPDATE project_contexts SET status = \'dormant\', closed_at = ?, relevance_boost = 0 WHERE scope_key = ? AND project_id = ?').run(nowIso(), scope.scopeKey, String(projectId));
    this.db.prepare('UPDATE memory_nodes SET updated_at = ? WHERE scope_key = ? AND project_id = ?').run(nowIso(), scope.scopeKey, String(projectId));
  }

  maintenance(options = {}) {
    const cutoffMs = Date.now() - Number(options.projectInactivityDays || this.options.projectInactivityDays) * 86400000;
    const cutoff = new Date(cutoffMs).toISOString();
    const stale = this.db.prepare('SELECT scope_key, project_id FROM project_contexts WHERE status = \'active\' AND last_active_at < ?').all(cutoff);
    const tx = this.db.transaction(() => {
      for (const project of stale) this.db.prepare('UPDATE project_contexts SET status = \'dormant\', relevance_boost = 0, closed_at = COALESCE(closed_at, ?) WHERE scope_key = ? AND project_id = ?').run(nowIso(), project.scope_key, project.project_id);
      this.db.prepare('UPDATE memory_nodes SET is_archived = 1, status = \'archived\', updated_at = ? WHERE expires_at IS NOT NULL AND expires_at < ? AND is_pinned = 0').run(nowIso(), nowIso());
      this.db.prepare('DELETE FROM memory_access_events WHERE created_at < datetime(\'now\', \'-180 days\')').run();
    });
    tx();
    return { dormantProjects: stale.length };
  }

  migrateLegacy(tkg, options = {}) {
    if (!tkg || !tkg.db) throw new Error('Legacy TemporalKnowledgeGraph database is required');
    const scope = this.normalizeScope(options.scope);
    const report = { events: 0, entities: 0, edges: 0, skipped: 0 };
    const eventRows = tkg.db.prepare('SELECT * FROM events ORDER BY created_at ASC').all();
    for (const event of eventRows) {
      const result = this.ingest({ scope, content: event.content || '', category: REGION_TO_CATEGORY[event.memory_category] || 'conversation', memoryType: event.event_type || 'event', sourceType: event.source || 'legacy_event', sourceReference: `legacy:event:${event.id}`, explicit: true, confidence: event.importance || 0.6, createdAt: event.created_at, metadata: { legacyId: event.id, legacyTable: 'events', legacyMetadata: parse(event.metadata, {}) } });
      result.stored || result.duplicate ? report.events++ : report.skipped++;
    }
    const entities = tkg.db.prepare('SELECT * FROM entities').all();
    const entityMap = new Map();
    for (const entity of entities) {
      const result = this.ingest({ scope, content: entity.name, category: REGION_TO_CATEGORY[entity.memory_category] || 'conversation', memoryType: entity.type || 'entity', sourceType: 'legacy_entity', sourceReference: `legacy:entity:${entity.id}`, explicit: true, confidence: 0.7, metadata: { legacyId: entity.id, attributes: parse(entity.attributes, {}) } });
      if (result.nodeId) entityMap.set(entity.id, result.nodeId);
      report.entities++;
    }
    const edges = tkg.db.prepare('SELECT * FROM entity_edges').all();
    for (const edge of edges) {
      const source = entityMap.get(edge.source_id);
      const target = entityMap.get(edge.target_id);
      if (source && target) { this.connect(scope, source, target, RELATIONS.includes(edge.relation_type) ? edge.relation_type : 'RELATED_TO', { weight: edge.weight, metadata: { legacyId: edge.id } }); report.edges++; }
      else report.skipped++;
    }
    return report;
  }

  stats(scopeInput) {
    const scope = this.normalizeScope(scopeInput);
    return {
      nodes: this.db.prepare('SELECT COUNT(*) AS count FROM memory_nodes WHERE scope_key = ?').get(scope.scopeKey).count,
      edges: this.db.prepare('SELECT COUNT(*) AS count FROM memory_edges WHERE scope_key = ?').get(scope.scopeKey).count,
      categories: this.db.prepare('SELECT COUNT(*) AS count FROM memory_categories WHERE scope_key = ?').get(scope.scopeKey).count,
      archived: this.db.prepare('SELECT COUNT(*) AS count FROM memory_nodes WHERE scope_key = ? AND is_archived = 1').get(scope.scopeKey).count,
    };
  }
}

GraphCognitiveMemory.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;
GraphCognitiveMemory.RELATIONS = RELATIONS;
GraphCognitiveMemory.REGION_TO_CATEGORY = REGION_TO_CATEGORY;
module.exports = GraphCognitiveMemory;
module.exports.GraphCognitiveMemory = GraphCognitiveMemory;
module.exports.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;
module.exports.RELATIONS = RELATIONS;
module.exports.REGION_TO_CATEGORY = REGION_TO_CATEGORY;
