'use strict';

const crypto = require('crypto');
const { REGIONS, ALL_REGIONS, isDurableRegion } = require('./regions');

/**
 * TemporaryMemory – project-scoped scratch space.
 *
 * While the agent is actively building something (a file, a multi-step task),
 * all intermediate observations go into a Temporary session instead of
 * polluting Long-term / Daily. When the session is closed a concise summary
 * is written into a durable region so the agent never forgets *what* it built.
 */
class TemporaryMemory {
  /**
   * @param {import('./temporal-knowledge-graph')} tkg
   */
  constructor(tkg) {
    this.tkg = tkg;
  }

  /**
   * Ensure the temporary_sessions table exists (called from TKG schema).
   * @param {import('better-sqlite3').Database} db
   */
  static ensureSchema(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS temporary_sessions (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL,
        title TEXT,
        status TEXT NOT NULL DEFAULT 'open',
        summary TEXT,
        durable_region TEXT DEFAULT 'long_term',
        created_at TEXT NOT NULL,
        closed_at TEXT,
        metadata TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_temp_sessions_project ON temporary_sessions(project_key);
      CREATE INDEX IF NOT EXISTS idx_temp_sessions_status ON temporary_sessions(status);

      CREATE TABLE IF NOT EXISTS temporary_nodes (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        node_type TEXT DEFAULT 'note',
        dynamic_category TEXT,
        weight REAL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES temporary_sessions(id)
      );
      CREATE INDEX IF NOT EXISTS idx_temp_nodes_session ON temporary_nodes(session_id);
    `);
  }

  /**
   * Open (or reuse) a temporary session for a project.
   * @param {string} projectKey  e.g. "file:src/foo.ts" or "task:implement-login"
   * @param {object} [opts]
   * @returns {{sessionId: string, isNew: boolean}}
   */
  openSession(projectKey, opts = {}) {
    if (typeof projectKey !== 'string' || projectKey.trim().length === 0) {
      throw new Error('Temporary session requires a non-empty project key');
    }
    const durableRegion = this._resolveDurableRegion(opts.durableRegion);
    const existing = this.tkg.db.prepare(
      `SELECT id FROM temporary_sessions WHERE project_key = ? AND status = 'open' LIMIT 1`
    ).get(projectKey);

    if (existing) {
      return { sessionId: existing.id, isNew: false };
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.tkg.db.prepare(`
      INSERT INTO temporary_sessions (id, project_key, title, status, durable_region, created_at, metadata)
      VALUES (?, ?, ?, 'open', ?, ?, ?)
    `).run(
      id,
      projectKey,
      opts.title || projectKey,
      durableRegion,
      now,
      JSON.stringify(opts.metadata || {})
    );
    return { sessionId: id, isNew: true };
  }

  /**
   * Write a node into an open temporary session.
   */
  writeNode(sessionId, content, opts = {}) {
    const session = this.tkg.db.prepare(
      `SELECT id, status FROM temporary_sessions WHERE id = ?`
    ).get(sessionId);
    if (!session || session.status !== 'open') {
      throw new Error(`Temporary session ${sessionId} is not open`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.tkg.db.prepare(`
      INSERT INTO temporary_nodes (id, session_id, content, node_type, dynamic_category, weight, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      sessionId,
      content,
      opts.nodeType || 'note',
      opts.dynamicCategory || null,
      opts.weight != null ? opts.weight : 1.0,
      now
    );
    return id;
  }

  /**
   * Close a session and roll a summary into durable memory.
   * Returns the durable event id if a summary was written.
   */
  closeSession(sessionId, opts = {}) {
    const session = this.tkg.db.prepare(
      `SELECT * FROM temporary_sessions WHERE id = ?`
    ).get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (session.status === 'closed') return null;

    const nodes = this.tkg.db.prepare(
      `SELECT content, node_type, dynamic_category, weight FROM temporary_nodes WHERE session_id = ? ORDER BY created_at`
    ).all(sessionId);

    const summaryText = opts.summary || this._buildSummary(session, nodes);
    const durableRegion = this._resolveDurableRegion(
      opts.durableRegion || session.durable_region,
    );
    const now = new Date().toISOString();

    this.tkg.db.prepare(`
      UPDATE temporary_sessions
      SET status = 'closed', summary = ?, closed_at = ?
      WHERE id = ?
    `).run(summaryText, now, sessionId);

    // Roll summary into durable region so the agent never forgets what it built.
    if (summaryText && summaryText.trim().length > 0) {
      const eventResult = this.tkg.writeEvent({
        event_type: 'temp_summary',
        content: summaryText,
        source: 'temporary_memory',
        importance: 0.7,
        metadata: {
          memory_category: durableRegion,
          temporary_session_id: sessionId,
          project_key: session.project_key,
          node_count: nodes.length,
        },
      });
      return eventResult.eventId || null;
    }
    return null;
  }

  /**
   * List open sessions (optionally filtered by projectKey).
   */
  listOpenSessions(projectKey = null) {
    if (projectKey) {
      return this.tkg.db.prepare(
        `SELECT * FROM temporary_sessions WHERE status = 'open' AND project_key = ?`
      ).all(projectKey);
    }
    return this.tkg.db.prepare(
      `SELECT * FROM temporary_sessions WHERE status = 'open'`
    ).all();
  }

  /**
   * Get nodes belonging to a session.
   */
  getSessionNodes(sessionId) {
    return this.tkg.db.prepare(
      `SELECT * FROM temporary_nodes WHERE session_id = ? ORDER BY created_at`
    ).all(sessionId);
  }

  /**
   * Close open sessions older than maxAgeMs (default 4 hours).
   * Returns number of sessions closed. Safe to call periodically from
   * the consolidation daemon or agent heartbeat.
   */
  closeStaleSessions(maxAgeMs = 4 * 60 * 60 * 1000) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const stale = this.tkg.db.prepare(
      `SELECT id FROM temporary_sessions WHERE status = 'open' AND created_at < ?`
    ).all(cutoff);
    let closed = 0;
    for (const row of stale) {
      try {
        this.closeSession(row.id);
        closed++;
      } catch (_) {
        // ignore individual failures
      }
    }
    return closed;
  }

  _resolveDurableRegion(region) {
    const resolved = region || REGIONS.LONG_TERM;
    if (!ALL_REGIONS.includes(resolved) || !isDurableRegion(resolved)) {
      throw new Error(`Temporary summary region must be durable: ${resolved}`);
    }
    return resolved;
  }

  _buildSummary(session, nodes) {
    if (nodes.length === 0) {
      return `Temporary work on "${session.project_key}" produced no recorded nodes.`;
    }
    const lines = nodes.map((n, i) => {
      const cat = n.dynamic_category ? ` [${n.dynamic_category}]` : '';
      return `${i + 1}. (${n.node_type}${cat}) ${n.content.slice(0, 200)}`;
    });
    return [
      `Summary of temporary work: ${session.title || session.project_key}`,
      `Nodes recorded: ${nodes.length}`,
      '',
      ...lines,
    ].join('\n');
  }
}

module.exports = TemporaryMemory;
