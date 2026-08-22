'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;
const SpecialEventHighlighter = require('./special-event-highlighter');
const { createEmbeddingProvider } = require('./embedding-provider');
const NodeGraph = require('./node-graph');
const GraphCognitiveMemory = require('./graph-cognitive-memory');
const SelectiveMemoryEngine = require('./selective-memory-engine');

class TemporalKnowledgeGraph {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.nodeGraph = null;
    this.selectiveMemory = null;
    this.initialized = false;
    // Regex-pattern-based importance scoring, used by writeEvent() in place
    // of a cruder inline keyword-substring check. Constructed here (not
    // required lazily) since it's stateless aside from holding a reference
    // back to this TKG instance for its getUnresolved()/resolve() helpers.
    this._highlighter = new SpecialEventHighlighter(this);
    // Offline-first embedding foundation (hash by default; swap later).
    this._embeddingProvider = createEmbeddingProvider();
    // Lazy-consolidation throttle: consolidation is checked on read access
    // (not on a background timer), but we avoid re-scanning the DB on every
    // single read by only re-checking once per hour at most.
    this._lastConsolidationCheckMs = 0;
    this._consolidationCheckIntervalMs = 60 * 60 * 1000;

    // Contradiction-detection / connection-weight-decay tuning.
    // A new fact whose similarity to an existing active fact (same
    // source/target/relation) meets or exceeds REPEAT_SIMILARITY_THRESHOLD
    // is treated as a restatement of the same fact (reinforce, don't decay).
    // Below that but at/above CONTRADICTION_SIMILARITY_THRESHOLD, it's
    // treated as a contradiction on the same topic (decay the old edge).
    // Below CONTRADICTION_SIMILARITY_THRESHOLD, the new fact is considered
    // unrelated and is simply added alongside the old one with no effect on
    // its weight.
    this.REPEAT_SIMILARITY_THRESHOLD = 0.85;
    this.CONTRADICTION_SIMILARITY_THRESHOLD = 0.3;
    this.CONTRADICTION_DECAY_FACTOR = 0.65;
    this.REINFORCE_STEP = 0.1;

    // The memory regions matching the Agent brain diagram.
    // long_term, daily, static, skill, rule_emotion, temporary.
    // Kept as an instance property so it is the single source of truth.
    const { ALL_REGIONS } = require('./regions');
    this.MEMORY_CATEGORIES = [...ALL_REGIONS];
  }

  /**
   * Synchronous initialize. better-sqlite3 is fully sync; the only prior
   * async step was mkdir. Using the sync path eliminates the fire-and-forget
   * race where callers could write/query before schema creation finished.
   */
  initializeSync() {
    if (this.initialized) return this;
    const dir = path.dirname(this.dbPath);
    const fsSync = require('fs');
    fsSync.mkdirSync(dir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._createSchema();
    this.initialized = true;
    return this;
  }

  async initialize() {
    if (this.initialized) return this;
    // Prefer the sync path so awaiters and non-awaiters both see a ready DB.
    return this.initializeSync();
  }

  _createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hourly_chunks (
        id TEXT PRIMARY KEY,
        hour_key TEXT NOT NULL,
        hour_start TEXT NOT NULL,
        hour_end TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',
        event_count INTEGER DEFAULT 0,
        summary TEXT,
        consolidated_into TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hourly_chunks_hour_key ON hourly_chunks(hour_key);
      CREATE INDEX IF NOT EXISTS idx_hourly_chunks_status ON hourly_chunks(status);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        chunk_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        content TEXT,
        source TEXT,
        importance REAL DEFAULT 0.0,
        is_special INTEGER DEFAULT 0,
        special_event_name TEXT,
        metadata TEXT,
        memory_category TEXT NOT NULL DEFAULT 'daily',
        created_at TEXT NOT NULL,
        FOREIGN KEY (chunk_id) REFERENCES hourly_chunks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_events_chunk_id ON events(chunk_id);
      CREATE INDEX IF NOT EXISTS idx_events_is_special ON events(is_special);
      CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at);

      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'entity',
        attributes TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        access_count INTEGER DEFAULT 1,
        is_active INTEGER DEFAULT 1,
        memory_category TEXT NOT NULL DEFAULT 'long_term'
      );

      CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);
      CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

      CREATE TABLE IF NOT EXISTS entity_edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL DEFAULT 1.0,
        valid_from TEXT,
        valid_until TEXT,
        metadata TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES entities(id),
        FOREIGN KEY (target_id) REFERENCES entities(id)
      );

      CREATE INDEX IF NOT EXISTS idx_entity_edges_source ON entity_edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_entity_edges_target ON entity_edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_entity_edges_type ON entity_edges(relation_type);

      CREATE TABLE IF NOT EXISTS working_anchor (
        id TEXT PRIMARY KEY DEFAULT 'current',
        current_timestamp TEXT NOT NULL,
        current_situation TEXT,
        key_entities TEXT,
        active_context TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS daily_summaries (
        id TEXT PRIMARY KEY,
        date_key TEXT NOT NULL,
        summary TEXT NOT NULL,
        graph_snapshot TEXT,
        chunk_ids TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date_key);

      CREATE TABLE IF NOT EXISTS daily_summary_edges (
        id TEXT PRIMARY KEY,
        source_date_key TEXT NOT NULL,
        target_date_key TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(source_date_key, target_date_key)
      );

      CREATE INDEX IF NOT EXISTS idx_daily_summary_edges_source ON daily_summary_edges(source_date_key);
      CREATE INDEX IF NOT EXISTS idx_daily_summary_edges_target ON daily_summary_edges(target_date_key);
      CREATE INDEX IF NOT EXISTS idx_daily_summary_edges_weight ON daily_summary_edges(weight);

      CREATE TABLE IF NOT EXISTS special_events_index (
        id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        chunk_id TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        summary TEXT,
        entities_involved TEXT,
        resolved INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_special_events_name ON special_events_index(event_name);
      CREATE INDEX IF NOT EXISTS idx_special_events_importance ON special_events_index(importance);
    `);

    this._migrateMemoryCategoryColumns();
    this._migrateEntityEdgesUpdatedAt();
    this._migrateUsageAndDynamicColumns();
    this._ensureFtsTables();
    // Temporary region tables
    const TemporaryMemory = require('./temporary-memory');
    TemporaryMemory.ensureSchema(this.db);

    // NodeGraph shares this connection so event history and usage-ranked
    // context stay transactionally consistent in the same durable database.
    this.nodeGraph = new NodeGraph(this.db);
    this.nodeGraph.initializeSync();

    // The scoped cognitive graph shares this connection so the new memory
    // model is durable and transactional without disturbing legacy tables.
    this.graphMemory = new GraphCognitiveMemory(this.db, {
      defaultScope: {
        agentId: process.env.MIKI_AGENT_ID || 'miki',
        ownerId: process.env.MIKI_OWNER_ID || 'default-owner',
        workspaceId: process.env.MIKI_WORKSPACE_ID || 'default-workspace',
      },
    });
    this.graphMemory.initializeSync();

    // Canonical selective retrieval/index layer. It shares this SQLite
    // connection so ingestion and retrieval remain transactional with the
    // legacy event graph during migration.
    this.selectiveMemory = new SelectiveMemoryEngine(this.db, {
      scope: {
        agentId: process.env.MIKI_AGENT_ID || 'miki',
        ownerId: process.env.MIKI_OWNER_ID || 'default-owner',
        workspaceId: process.env.MIKI_WORKSPACE_ID || 'default-workspace',
      },
      embeddingProvider: this._embeddingProvider,
    });
    this.selectiveMemory.initializeSync();
  }

  /**
   * Ensure FTS5 virtual tables exist for events and entities, and backfill
   * them from existing rows on first creation. Uses unicode61 tokenizer so
   * Bengali and other Unicode scripts are searchable. Idempotent.
   * @private
   */
  _ensureFtsTables() {
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
        content,
        event_id UNINDEXED,
        tokenize = 'unicode61'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
        name,
        attributes,
        entity_id UNINDEXED,
        tokenize = 'unicode61'
      );
    `);

    // Backfill only when FTS is empty but base tables have rows (first
    // upgrade path). Subsequent starts skip the scan.
    const eventFtsCount = this.db.prepare('SELECT COUNT(*) AS c FROM events_fts').get().c;
    const eventCount = this.db.prepare('SELECT COUNT(*) AS c FROM events').get().c;
    if (eventFtsCount === 0 && eventCount > 0) {
      this.db.exec(`
        INSERT INTO events_fts(event_id, content)
        SELECT id, COALESCE(content, '') FROM events
      `);
    }

    const entityFtsCount = this.db.prepare('SELECT COUNT(*) AS c FROM entities_fts').get().c;
    const entityCount = this.db.prepare('SELECT COUNT(*) AS c FROM entities').get().c;
    if (entityFtsCount === 0 && entityCount > 0) {
      this.db.exec(`
        INSERT INTO entities_fts(entity_id, name, attributes)
        SELECT id, COALESCE(name, ''), COALESCE(attributes, '') FROM entities
      `);
    }
  }

  /**
   * Build a safe FTS5 MATCH query from free text. Strips FTS operators that
   * would cause syntax errors, keeps Unicode letters/digits, and joins
   * remaining tokens with OR so partial multi-word queries still match.
   * @param {string} queryStr
   * @returns {string|null} MATCH expression or null if nothing usable
   * @private
   */
  _buildFtsQuery(queryStr) {
    if (!queryStr || typeof queryStr !== 'string') return null;
    // Keep letters (any script), digits, and basic internal punctuation for
    // tokens; drop FTS special chars that break MATCH syntax.
    const cleaned = queryStr
      .replace(/[*"^~:(){}[\]\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return null;
    const tokens = cleaned.split(' ').filter(t => t.length > 0);
    if (tokens.length === 0) return null;
    // Quote each token so unicode / hyphenated tokens are treated as phrases
    // and not as operators.
    return tokens.map(t => `"${t.replace(/"/g, '')}"`).join(' OR ');
  }

  /**
   * Additive migration for databases created before the memory_category
   * column existed on events/entities. CREATE TABLE IF NOT EXISTS above is a
   * no-op on an already-existing table, so pre-existing DB files need an
   * explicit ALTER TABLE here. SQLite has no "ADD COLUMN IF NOT EXISTS", so
   * we check PRAGMA table_info first and only add the column when missing.
   * Safe to run on every startup — idempotent, and cheap (single pragma
   * query per table).
   * @private
   */
  _migrateMemoryCategoryColumns() {
    const tables = [
      { name: 'events', defaultCategory: "'daily'" },
      { name: 'entities', defaultCategory: "'long_term'" }
    ];
    for (const { name, defaultCategory } of tables) {
      const columns = this.db.prepare(`PRAGMA table_info(${name})`).all();
      const hasColumn = columns.some(c => c.name === 'memory_category');
      if (!hasColumn) {
        this.db.exec(`ALTER TABLE ${name} ADD COLUMN memory_category TEXT NOT NULL DEFAULT ${defaultCategory}`);
      }
      // Index creation runs unconditionally (idempotent via IF NOT EXISTS):
      // on a fresh install the column already exists from CREATE TABLE, so
      // hasColumn is true above and the index would otherwise never be
      // created without this being outside the if-block.
      this.db.exec(`CREATE INDEX IF NOT EXISTS idx_${name}_memory_category ON ${name}(memory_category)`);
    }
  }

  /**
   * Additive migration for databases created before entity_edges had an
   * updated_at column. Backfills it from created_at (best available proxy
   * for "last confirmed" on rows that predate reinforcement tracking).
   * Without this column, runConsolidation()'s 30-day archival check had no
   * way to tell "an edge nobody has restated or contradicted in 30 days"
   * apart from "an edge that was reinforced yesterday but first created 40
   * days ago" — both looked identical on created_at alone, so a
   * continuously-reinforced, still-current fact could get archived right
   * alongside genuinely stale ones. See _reconcileEntityRelationship, which
   * now bumps updated_at on every reinforcement/contradiction-decay.
   * @private
   */
  _migrateEntityEdgesUpdatedAt() {
    const columns = this.db.prepare(`PRAGMA table_info(entity_edges)`).all();
    const hasColumn = columns.some(c => c.name === 'updated_at');
    if (!hasColumn) {
      this.db.exec(`ALTER TABLE entity_edges ADD COLUMN updated_at TEXT`);
      this.db.exec(`UPDATE entity_edges SET updated_at = created_at WHERE updated_at IS NULL`);
    }
  }

  /**
   * Additive migration for usage-based proximity and dynamic node categories.
   * - entities: dynamic_category, activation
   * - entity_edges: usage_count, last_used_at
   * Idempotent; safe on every startup.
   * @private
   */
  _migrateUsageAndDynamicColumns() {
    // entities
    const entCols = this.db.prepare(`PRAGMA table_info(entities)`).all().map(c => c.name);
    if (!entCols.includes('dynamic_category')) {
      this.db.exec(`ALTER TABLE entities ADD COLUMN dynamic_category TEXT`);
    }
    if (!entCols.includes('activation')) {
      this.db.exec(`ALTER TABLE entities ADD COLUMN activation REAL DEFAULT 0.0`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entities_dynamic_category ON entities(dynamic_category)`);

    // entity_edges
    const edgeCols = this.db.prepare(`PRAGMA table_info(entity_edges)`).all().map(c => c.name);
    if (!edgeCols.includes('usage_count')) {
      this.db.exec(`ALTER TABLE entity_edges ADD COLUMN usage_count INTEGER DEFAULT 0`);
    }
    if (!edgeCols.includes('last_used_at')) {
      this.db.exec(`ALTER TABLE entity_edges ADD COLUMN last_used_at TEXT`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entity_edges_usage ON entity_edges(usage_count)`);
  }

  _now() {
    return new Date().toISOString();
  }

  _uuid() {
    return crypto.randomUUID();
  }

  _getHourKey(date) {
    const d = date || new Date();
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hour = String(d.getUTCHours()).padStart(2, '0');
    return `${year}-${month}-${day}T${hour}`;
  }

  _getHourStart(hourKey) {
    return new Date(hourKey + ':00:00.000Z').toISOString();
  }

  _getHourEnd(hourKey) {
    const d = new Date(hourKey + ':00:00.000Z');
    d.setUTCHours(d.getUTCHours() + 1);
    return d.toISOString();
  }

  _getDateKey(date) {
    const d = date || new Date();
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  getOrCreateCurrentChunk() {
    const hourKey = this._getHourKey();
    let chunk = this.db.prepare('SELECT * FROM hourly_chunks WHERE hour_key = ?').get(hourKey);
    if (!chunk) {
      const id = this._uuid();
      const now = this._now();
      this.db.prepare(`
        INSERT INTO hourly_chunks (id, hour_key, hour_start, hour_end, status, event_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'ACTIVE', 0, ?, ?)
      `).run(id, hourKey, this._getHourStart(hourKey), this._getHourEnd(hourKey), now, now);
      chunk = this.db.prepare('SELECT * FROM hourly_chunks WHERE id = ?').get(id);
    }
    return chunk;
  }

  /**
   * Single write gateway for all memory ingestion. Every caller (agent
   * turns, tool calls, system events) funnels through here, which makes
   * this the natural chokepoint for the offline noise filter and category
   * classifier rather than standing up a separate gateway process:
   * it's already the only door into memory, so filtering here has zero
   * extra IPC/latency cost and can't be bypassed by a caller that forgets
   * to call a separate service.
   *
   * Noise filtering happens first and is a hard reject — content that is
   * empty, pure filler, or symbol-only is never written at all (not even
   * indexed and later pruned), since running the rest of the pipeline
   * (chunking, entity extraction, importance scoring) on it would just be
   * wasted work. Set eventData.skipNoiseFilter = true to bypass (used by
   * tests and by callers that already validated the content themselves,
   * e.g. explicit user "remember this" commands).
   *
   * Before anything else, content is passed through `_redactSecrets`. This
   * is unconditional (unlike the noise filter, there is no bypass flag) —
   * a caller cannot opt out of secret redaction, because the whole point is
   * that no code path may ever accidentally persist a live credential into
   * a store that gets replayed into every future LLM system prompt. The
   * redacted string is what gets written to the DB, chunked for entities,
   * and fed into the working anchor / special-event summary, so a secret
   * can never survive in any derived artifact even if one of those steps
   * is later changed to look at raw content again.
   *
   * @param {Object} eventData
   * @returns {{eventId: string, chunkId: string, isSpecial: boolean, specialEventName: string|null}|{filtered: true}}
   */
  writeEvent(eventData) {
    if (!eventData.skipNoiseFilter && this._isNoise(eventData.content)) {
      return { filtered: true };
    }

    const redactedContent = this._redactSecrets(eventData.content || '');
    // Downstream helpers (this._highlighter.classify(), _classifyMemoryCategory,
    // _extractEntities, _updateWorkingAnchor) all read eventData.content,
    // so we work off a shallow copy with the redacted string substituted
    // in rather than threading a second parameter through every call site.
    eventData = { ...eventData, content: redactedContent };

    const chunk = this.getOrCreateCurrentChunk();
    const eventId = this._uuid();
    const now = this._now();

    const importance = typeof eventData.importance === 'number'
      ? eventData.importance
      : this._highlighter.classify(
          eventData.content || '',
          eventData.source || 'system',
          eventData.event_type || 'general',
          eventData.metadata || {},
        ).importance;
    const isSpecial = importance >= 0.7 ? 1 : 0;
    const specialEventName = isSpecial ? this._generateSpecialEventName(eventData) : null;
    const memoryCategory = this._classifyMemoryCategory(eventData);

    this.db.prepare(`
      INSERT INTO events (id, chunk_id, event_type, content, source, importance, is_special, special_event_name, metadata, memory_category, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, chunk.id, eventData.event_type || 'general', eventData.content || '', eventData.source || 'system', importance, isSpecial, specialEventName, JSON.stringify(eventData.metadata || {}), memoryCategory, now);

    // Keep FTS index in sync with the base table (unicode61 tokenizer).
    this.db.prepare(`
      INSERT INTO events_fts(event_id, content) VALUES (?, ?)
    `).run(eventId, eventData.content || '');

    this.db.prepare('UPDATE hourly_chunks SET event_count = event_count + 1, updated_at = ? WHERE id = ?').run(now, chunk.id);

    if (isSpecial && specialEventName) {
      this.db.prepare(`
        INSERT INTO special_events_index (id, event_name, chunk_id, importance, summary, entities_involved, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this._uuid(), specialEventName, chunk.id, importance, eventData.content ? eventData.content.substring(0, 500) : '', JSON.stringify(eventData.entities || []), now);
    }

    const entities = this._extractEntities(eventData);
    const graphEntityIds = [];
    for (const entity of entities) {
      const entityId = this._ensureEntity(entity, memoryCategory);
      graphEntityIds.push({ id: entityId, entity });
    }

    // Keep the backend-only NodeGraph synchronized with durable events. Each
    // node stores its own context, while event/entity edges provide the local
    // neighborhood used by usage-ranked retrieval.
    if (this.nodeGraph) {
      try {
        const eventNodeId = `event:${eventId}`;
        this.nodeGraph.upsertNode({
          id: eventNodeId,
          key: eventNodeId,
          kind: 'event',
          label: eventData.event_type || 'general',
          context: {
            text: eventData.content || '',
            source: eventData.source || 'system',
            eventType: eventData.event_type || 'general',
            memoryCategory,
            importance,
            createdAt: now,
          },
        });
        for (const { id, entity } of graphEntityIds) {
          const entityNodeId = `entity:${id}`;
          this.nodeGraph.upsertNode({
            id: entityNodeId,
            key: entityNodeId,
            kind: 'entity',
            label: entity.name,
            context: {
              name: entity.name,
              type: entity.type || 'entity',
              memoryCategory,
              attributes: entity.attributes || {},
            },
          });
          this.nodeGraph.connect(eventNodeId, entityNodeId, 'mentions', { eventId, memoryCategory }, 0.35);
        }
        for (let index = 0; index < graphEntityIds.length; index += 1) {
          for (let next = index + 1; next < graphEntityIds.length; next += 1) {
            this.nodeGraph.connect(
              `entity:${graphEntityIds[index].id}`,
              `entity:${graphEntityIds[next].id}`,
              'co_occurs',
              { eventId },
              0.18,
            );
          }
        }
      } catch (err) {
        // Graph enrichment must never prevent the canonical event write.
        console.warn('[TemporalKnowledgeGraph] NodeGraph sync warning:', err.message);
      }
    }

    this._updateWorkingAnchor(eventData);

    // Keep the new selective layer synchronized with the canonical event
    // chokepoint. Failure is isolated so the legacy memory contract remains
    // available during migration or a partial index outage.
    if (this.selectiveMemory) {
      try {
        const selectiveScope = eventData.memoryScope || eventData.scope || eventData.metadata?.memoryScope || {
          agentId: process.env.MIKI_AGENT_ID || 'miki',
          ownerId: process.env.MIKI_OWNER_ID || 'default-owner',
          workspaceId: process.env.MIKI_WORKSPACE_ID || 'default-workspace',
        };
        this.selectiveMemory.ingest({
          scope: selectiveScope,
          content: eventData.content || '',
          region: memoryCategory,
          summary: eventData.summary || null,
          sourceType: eventData.source || 'system',
          sourceReference: eventData.messageId || eventData.runId || eventData.taskId || eventId,
          provenance: eventData.source || 'conversation',
          confidence: typeof eventData.confidence === 'number' ? eventData.confidence : 0.7,
          importance,
          createdAt: now,
          entities: graphEntityIds.map(({ entity }) => entity.name),
          metadata: {
            eventId,
            legacyChunkId: chunk.id,
            eventType: eventData.event_type || 'general',
            source: eventData.source || 'system',
          },
        });
      } catch (err) {
        console.warn('[TemporalKnowledgeGraph] Selective memory sync warning:', err.message);
      }
    }

    return { eventId, chunkId: chunk.id, isSpecial: !!isSpecial, specialEventName, memoryCategory };
  }

  /**
   * Redact live credential-shaped substrings before content is persisted
   * anywhere. This is deliberately pattern-based (shape of the secret, not
   * the word "token"/"password" near it) so ordinary conversation that
   * merely mentions the concept of a token or password is left untouched —
   * only the value itself is replaced.
   *
   * Patterns covered: GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_ + 36 chars),
   * generic long hex/base62 API-key-shaped runs after key=/token=/
   * password=/secret= style assignment, and OpenAI-style sk-... keys.
   * Deliberately conservative (a few well-known high-confidence shapes)
   * rather than trying to catch every possible secret format — false
   * negatives here are a known limitation (see README), but false
   * positives that redact ordinary prose are worse for a memory system
   * whose whole point is faithfully recording what was said.
   *
   * @param {string} content
   * @returns {string}
   * @private
   */
  _redactSecrets(content) {
    if (!content) return content;
    let redacted = content;

    // key=VALUE / token=VALUE / password=VALUE / secret=VALUE assignments
    // run FIRST, and only when the value doesn't already look like one of
    // our own redaction markers (a previous pass, or content that already
    // passed through this method once). Requires the value itself to look
    // credential-shaped (8+ chars, no whitespace) so "password = the one
    // from the sticky note" style prose isn't touched.
    redacted = redacted.replace(
      /\b((?:api[_-]?key|token|password|passwd|secret)\s*[:=]\s*)["']?(?!\[REDACTED)([^\s"'`,;]{8,})["']?/gi,
      '$1[REDACTED]'
    );

    // GitHub personal access tokens / installation tokens — runs after the
    // generic pass so a bare token with no key= prefix (e.g. pasted alone,
    // or inside a "Token : ..." label the generic pass already redacted
    // to [REDACTED]) still gets the more specific marker where the raw
    // shape is still present.
    redacted = redacted.replace(/\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, '[REDACTED_GITHUB_TOKEN]');

    // OpenAI / Anthropic-style secret keys (sk-..., sk-ant-...).
    redacted = redacted.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_API_KEY]');

    return redacted;
  }

  // Importance scoring for writeEvent() lives in SpecialEventHighlighter
  // (see this._highlighter.classify() above) — a regex-word-boundary,
  // context-boosted classifier that used to sit unused alongside a cruder
  // inline substring-match version here. That duplicate was removed;
  // SpecialEventHighlighter is now the single source of truth for
  // importance/isSpecial, and its own getUnresolved()/resolve()/
  // formatSpecialEventsSummary() helpers are reachable via this._highlighter.

  /**
   * Classify an incoming event into one of the diagram regions.
   *
   *   - long_term:   durable facts, identity, knowledge
   *   - daily:       scheduling / tasks / day-to-day
   *   - static:      core / stable data that almost never changes
   *   - skill:       tool/ability usage and learned procedures
   *   - rule_emotion: guidelines, constraints, behavioural context
   *   - temporary:   explicit project-scoped scratch (usually set by caller)
   *
   * Explicit metadata.memory_category always wins.
   * Falls back to 'daily'.
   *
   * @param {Object} eventData
   * @returns {string}
   */
  _classifyMemoryCategory(eventData) {
    if (eventData.metadata && eventData.metadata.memory_category) {
      const explicit = eventData.metadata.memory_category;
      if (this.MEMORY_CATEGORIES.includes(explicit)) return explicit;
    }

    const content = (eventData.content || '').toLowerCase();
    const eventType = (eventData.event_type || '').toLowerCase();
    const source = (eventData.source || '').toLowerCase();

    // Explicit temporary markers
    if (eventType === 'temp_summary' || source === 'temporary_memory' || eventType === 'temporary') {
      return 'temporary';
    }

    // Tool activity → skill
    if (source === 'tool' || eventType === 'tool_call' || eventType === 'tool_result') {
      return 'skill';
    }

    const scores = {
      long_term: 0,
      daily: 0,
      static: 0,
      skill: 0,
      rule_emotion: 0,
      temporary: 0,
    };

    const longTermKeywords = ['my name is', 'i am a', 'i work at', 'i live in', 'prefer', 'always use', 'never use', 'remember that', 'fact:', 'definition', 'architecture', 'repo', 'repository', 'project name'];
    const dailyKeywords = ['todo', 'task', 'reminder', 'meeting', 'schedule', 'deadline', 'deploy', 'commit', 'push', 'pr ', 'pull request', 'status', 'progress', 'today', 'tomorrow', 'this week', 'fix', 'bug'];
    const staticKeywords = ['core config', 'system setting', 'immutable', 'constant', 'base url', 'default model', 'protected file', 'never change', 'static data'];
    const skillKeywords = ['how to', 'how do i', 'use the tool', 'run the command', 'install', 'configure', 'setup', 'step by step', 'procedure', 'workflow'];
    const ruleEmotionKeywords = ['must', 'never', 'always', 'do not', "don't", 'rule:', 'guideline', 'policy', 'angry', 'frustrated', 'excited', 'thrilled', 'devastated', 'grateful', 'furious', 'anxious', 'happy', 'sad', 'sorry', 'apologize', 'please be', 'i feel', 'i want you to'];

    for (const kw of longTermKeywords) if (content.includes(kw)) scores.long_term++;
    for (const kw of dailyKeywords) if (content.includes(kw)) scores.daily++;
    for (const kw of staticKeywords) if (content.includes(kw)) scores.static++;
    for (const kw of skillKeywords) if (content.includes(kw)) scores.skill++;
    for (const kw of ruleEmotionKeywords) if (content.includes(kw)) scores.rule_emotion++;

    if (eventType === 'decision' || eventType === 'fact') scores.long_term += 2;
    if (eventType === 'alert' || eventType === 'system') scores.daily += 1;
    if (eventType === 'config' || eventType === 'setting') scores.static += 2;

    const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
    return best[1] > 0 ? best[0] : 'daily';
  }

  /**
   * Offline noise filter for the memory write gateway. Rejects content that
   * carries no retrievable signal at all: empty/whitespace-only text, and
   * content with no actual letters/digits (pure punctuation, symbols, or a
   * single repeated character). Pure string heuristics, no network calls —
   * safe to run on every write.
   *
   * Deliberately conservative: ordinary short conversational turns (a
   * greeting, "thanks", "ok") are NOT filtered — they're legitimate parts
   * of conversation history and dropping them would break turn-by-turn
   * continuity. This only rejects content that is degenerate on its face,
   * never anything a human said as part of a real exchange.
   *
   * @param {string} content
   * @returns {boolean} true if the content should be dropped
   */
  _isNoise(content) {
    if (!content) return true;
    const trimmed = content.trim();
    if (trimmed.length === 0) return true;
    // Pure punctuation/whitespace/symbols, no actual word characters
    // (Unicode-aware: covers Latin and Bengali letters/digits alike).
    if (!/[\p{L}\p{N}]/u.test(trimmed)) return true;
    // A single character repeated (e.g. "......", "aaaaaa", "----") carries
    // no information regardless of length.
    if (/^(.)\1*$/u.test(trimmed)) return true;
    return false;
  }

  _generateSpecialEventName(eventData) {
    const content = eventData.content || '';
    const words = content.split(/\s+/).filter(w => w.length > 3).slice(0, 5);
    if (words.length === 0) return 'HighlightSpecialEvent_' + this._uuid().substring(0, 8);
    return 'HighlightSpecialEvent_' + words.join('_').replace(/[^a-zA-Z0-9_]/g, '').substring(0, 60);
  }

  _extractEntities(eventData) {
    const entities = [];
    if (eventData.entities && Array.isArray(eventData.entities)) {
      for (const e of eventData.entities) {
        entities.push({ name: e.name || e, type: e.type || 'entity' });
      }
    }
    const content = eventData.content || '';
    const seen = new Set(entities.map(e => String(e.name).toLowerCase()));

    // 1) English-style Capitalized multi-word names (legacy heuristic).
    const engMatches = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
    if (engMatches) {
      for (const name of engMatches) {
        if (name.length > 3 && !seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          entities.push({ name, type: 'entity' });
        }
      }
    }

    // 2) Unicode letter sequences (Bengali, Arabic, Devanagari, CJK, etc.).
    //    Require length >= 2 so single particles are skipped. Prefer runs
    //    at word boundaries (start, whitespace, punctuation).
    const unicodeNameRe = /(?:^|[\s,;:«»„"\u0964\u0965])([\p{L}][\p{L}\p{M}\p{N}'’-]{1,40})/gu;
    let m;
    while ((m = unicodeNameRe.exec(content)) !== null) {
      const name = m[1].trim();
      if (name.length < 2) continue;
      // Skip pure ASCII lowercase short fillers already covered / noise.
      if (/^[a-z]+$/.test(name) && name.length < 5) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      if (/^(the|and|for|with|from|this|that|have|been|will|are|was|were|not|but|you|your|our|their)$/i.test(name)) {
        continue;
      }
      seen.add(key);
      entities.push({ name, type: 'entity' });
    }

    // Cap extraction volume per event to avoid flooding the graph.
    return entities.slice(0, 30);
  }

  /**
   * Stable entity id that preserves Unicode letters (Bengali etc.) instead of
   * stripping them with [^\w-]. Falls back to a short hash when the cleaned
   * name would otherwise be empty.
   * @private
   */
  _entityIdFromName(name) {
    const raw = String(name || '').trim();
    let id = raw
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{M}\p{N}-]/gu, '')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    if (!id) {
      id = 'ent-' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 12);
    }
    if (id.length > 120) id = id.slice(0, 120);
    return id;
  }

  _ensureEntity(entityData, memoryCategory) {
    const now = this._now();
    const id = this._entityIdFromName(entityData.name);
    const existing = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
    if (existing) {
      this.db.prepare('UPDATE entities SET last_seen_at = ?, access_count = access_count + 1, is_active = 1 WHERE id = ?').run(now, id);
      // Promote dynamic_category if caller supplies one and row still empty.
      if (entityData.dynamic_category && !existing.dynamic_category) {
        this.db.prepare('UPDATE entities SET dynamic_category = ? WHERE id = ?')
          .run(String(entityData.dynamic_category).slice(0, 120), id);
      }
      return id;
    }
    // Entities inherit the event's region by default. dynamic_category is a
    // free-form sub-label (created on demand) for finer grouping inside a region.
    const category = this.MEMORY_CATEGORIES.includes(memoryCategory) ? memoryCategory : 'long_term';
    const dynCat = entityData.dynamic_category
      || entityData.type
      || entityData.category
      || null;
    const attributesJson = JSON.stringify(entityData.attributes || {});
    this.db.prepare(`
      INSERT INTO entities (id, name, type, attributes, first_seen_at, last_seen_at, access_count, is_active, memory_category, dynamic_category)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, ?, ?)
    `).run(
      id,
      entityData.name,
      entityData.type || 'entity',
      attributesJson,
      now,
      now,
      category,
      dynCat ? String(dynCat).slice(0, 120) : null
    );
    this.db.prepare(`
      INSERT INTO entities_fts(entity_id, name, attributes) VALUES (?, ?, ?)
    `).run(id, entityData.name || '', attributesJson);
    return id;
  }

  /**
   * Add a relation edge between two entities. If an active (non-deprecated)
   * edge already exists for the same source/target/relation_type, this
   * detects whether the new fact contradicts the old one:
   *
   * - Contradictory (similar topic, different content): the OLD edge is
   *   never deleted or overwritten - its connection weight is decayed
   *   (multiplied by contradictionDecayFactor) so it becomes progressively
   *   less trusted, while the NEW edge is inserted fresh at full weight.
   *   Both remain queryable, preserving full fact history across years.
   * - Repeated (same fact restated): the existing edge's weight is
   *   reinforced (increased, capped at 1.0) rather than decayed, and no
   *   duplicate edge is inserted.
   * - No prior edge: a new edge is inserted normally.
   *
   * This is deliberately pure string/vector similarity - no LLM call - so
   * behavior is deterministic and cheap enough to run on every write.
   *
   * @param {string} sourceId
   * @param {string} targetId
   * @param {string} relationType
   * @param {Object} [metadata]
   * @param {string} [metadata.factText] - the natural-language fact text, used for
   *   contradiction/repeat similarity comparison. Falls back to relationType if omitted.
   * @param {number} [metadata.weight]
   * @returns {{id: string, contradicted: string|null, reinforced: boolean}}
   */
  addEntityRelation(sourceId, targetId, relationType, metadata = {}) {
    const now = this._now();
    const factText = metadata.factText || relationType;

    const existingActive = this.db.prepare(`
      SELECT * FROM entity_edges
      WHERE source_id = ? AND target_id = ? AND relation_type = ? AND valid_until IS NULL
      ORDER BY created_at DESC
    `).all(sourceId, targetId, relationType);

    let contradicted = null;
    let reinforced = false;

    for (const oldEdge of existingActive) {
      const oldFactText = this._extractFactTextFromEdge(oldEdge);
      const similarity = this._factSimilarity(factText, oldFactText);

      if (similarity >= this.REPEAT_SIMILARITY_THRESHOLD) {
        // Same fact restated: reinforce the existing edge rather than
        // inserting a duplicate. updated_at is bumped alongside weight so
        // runConsolidation's staleness check (30 days since last
        // confirmation) treats this edge as freshly re-confirmed, not as
        // 30-days-old-and-untouched just because created_at is old.
        const newWeight = Math.min(1.0, (oldEdge.weight || 1.0) + this.REINFORCE_STEP);
        this.db.prepare('UPDATE entity_edges SET weight = ?, updated_at = ? WHERE id = ?').run(newWeight, now, oldEdge.id);
        reinforced = true;
        return { id: oldEdge.id, contradicted: null, reinforced: true };
      }

      if (similarity >= this.CONTRADICTION_SIMILARITY_THRESHOLD) {
        // Same topic, different content: this is a contradiction. Decay the
        // old edge's connection weight - never delete or overwrite it - so
        // fact history is fully preserved but retrieval naturally favors the
        // newer, more-trusted version. updated_at is bumped too: a
        // contradiction is itself evidence the edge is still "live" (someone
        // is actively talking about this topic), so it shouldn't silently
        // archive on the old created_at timestamp either.
        const decayedWeight = Math.max(0, (oldEdge.weight || 1.0) * this.CONTRADICTION_DECAY_FACTOR);
        this.db.prepare('UPDATE entity_edges SET weight = ?, updated_at = ? WHERE id = ?').run(decayedWeight, now, oldEdge.id);
        contradicted = oldEdge.id;
      }
    }

    const id = this._uuid();
    const weight = typeof metadata.weight === 'number' ? metadata.weight : 1.0;
    this.db.prepare(`
      INSERT INTO entity_edges (id, source_id, target_id, relation_type, weight, valid_from, valid_until, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, sourceId, targetId, relationType, weight, metadata.validFrom || now, metadata.validUntil || null, JSON.stringify(metadata), now, now);

    return { id, contradicted, reinforced };
  }

  /**
   * Extract the comparable fact text from a stored edge's metadata JSON.
   * @param {Object} edge
   * @returns {string}
   * @private
   */
  _extractFactTextFromEdge(edge) {
    try {
      const meta = JSON.parse(edge.metadata || '{}');
      return meta.factText || edge.relation_type;
    } catch {
      return edge.relation_type;
    }
  }

  /**
   * Similarity between two short fact strings using the same
   * dependency-free cosine-similarity approach used for daily summaries.
   * Returns 1.0 for identical strings without needing tokenization.
   * @param {string} a
   * @param {string} b
   * @returns {number} similarity in [0, 1]
   * @private
   */
  _factSimilarity(a, b) {
    if (!a || !b) return 0;
    const normA = a.trim().toLowerCase();
    const normB = b.trim().toLowerCase();
    if (normA === normB) return 1.0;
    return this._cosineSimilarity(this._tokenizeForSimilarity(a), this._tokenizeForSimilarity(b));
  }

  /**
   * Hard-deprecate an edge immediately (sets valid_until to now). Distinct
   * from the automatic soft-decay in addEntityRelation: use this only when a
   * fact is explicitly known to be fully retracted/invalid, not merely
   * superseded by a newer version.
   * @param {string} edgeId
   */
  deprecateEntityRelation(edgeId) {
    const now = this._now();
    this.db.prepare('UPDATE entity_edges SET valid_until = ?, updated_at = ? WHERE id = ?').run(now, now, edgeId);
  }

  getOrSetWorkingAnchor(contextData) {
    const existing = this.db.prepare('SELECT * FROM working_anchor WHERE id = ?').get('current');
    const now = this._now();
    if (existing) {
      const situation = typeof contextData.situation === 'string' ? contextData.situation : existing.current_situation;
      const entities = contextData.entities !== undefined ? contextData.entities : JSON.parse(existing.key_entities || '[]');
      const context = typeof contextData.context === 'string' ? contextData.context : existing.active_context;
      this.db.prepare(`
        UPDATE working_anchor SET current_timestamp = ?, current_situation = ?, key_entities = ?, active_context = ?, updated_at = ?
        WHERE id = 'current'
      `).run(now, situation, JSON.stringify(entities), context, now);
    } else {
      this.db.prepare(`
        INSERT INTO working_anchor (id, current_timestamp, current_situation, key_entities, active_context, updated_at)
        VALUES ('current', ?, ?, ?, ?, ?)
      `).run(now, contextData.situation || '', JSON.stringify(contextData.entities || []), contextData.context || '', now);
    }
    return this.getWorkingAnchor();
  }

  _updateWorkingAnchor(eventData) {
    const existing = this.db.prepare('SELECT * FROM working_anchor WHERE id = ?').get('current');
    const now = this._now();
    const context = eventData.content || '';
    const entities = this._extractEntities(eventData);
    const entityNames = entities.map(e => e.name);
    if (existing) {
      let existingEntities = [];
      try { existingEntities = JSON.parse(existing.key_entities || '[]'); } catch {}
      const merged = [...new Set([...entityNames, ...existingEntities])].slice(0, 20);
      this.db.prepare(`
        UPDATE working_anchor SET current_timestamp = ?, current_situation = ?, key_entities = ?, active_context = ?, updated_at = ?
        WHERE id = 'current'
      `).run(now, context.substring(0, 500), JSON.stringify(merged), context.substring(0, 2000), now);
    } else {
      this.db.prepare(`
        INSERT INTO working_anchor (id, current_timestamp, current_situation, key_entities, active_context, updated_at)
        VALUES ('current', ?, ?, ?, ?, ?)
      `).run(now, context.substring(0, 500), JSON.stringify(entityNames.slice(0, 20)), context.substring(0, 2000), now);
    }
  }

  getWorkingAnchor() {
    const anchor = this.db.prepare('SELECT * FROM working_anchor WHERE id = ?').get('current');
    if (!anchor) {
      const now = this._now();
      return { id: 'current', current_timestamp: now, current_situation: '', key_entities: '[]', active_context: '', updated_at: now };
    }
    return anchor;
  }

  getHourlyChunk(hourKey) {
    if (hourKey) {
      return this.db.prepare('SELECT * FROM hourly_chunks WHERE hour_key = ?').get(hourKey);
    }
    return this.getOrCreateCurrentChunk();
  }

  getHoursInRange(startHourKey, endHourKey) {
    return this.db.prepare(`
      SELECT * FROM hourly_chunks WHERE hour_key >= ? AND hour_key <= ? ORDER BY hour_key ASC
    `).all(startHourKey, endHourKey);
  }

  getRecentEvents(hoursBack = 24) {
    const since = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
    return this.db.prepare(`
      SELECT e.*, h.hour_key FROM events e
      JOIN hourly_chunks h ON e.chunk_id = h.id
      WHERE e.created_at >= ?
      ORDER BY e.created_at DESC
    `).all(since);
  }

  getEventsInChunk(chunkId) {
    return this.db.prepare('SELECT * FROM events WHERE chunk_id = ? ORDER BY created_at ASC').all(chunkId);
  }

  /**
   * Fetch recent events scoped to one of the 4 memory categories. Powers
   * category-grouped retrieval (getContextWindow) and lets any caller pull
   * "just the rules" or "just the skills" without scanning everything.
   * @param {'long_term'|'daily'|'skill'|'rule_emotion'} category
   * @param {number} limit
   * @returns {Array<Object>}
   */
  getEventsByCategory(category, limit = 20) {
    if (!this.MEMORY_CATEGORIES.includes(category)) return [];
    return this.db.prepare(`
      SELECT e.*, h.hour_key FROM events e
      JOIN hourly_chunks h ON e.chunk_id = h.id
      WHERE e.memory_category = ?
      ORDER BY e.created_at DESC LIMIT ?
    `).all(category, limit);
  }

  getSpecialEvents(limit = 20, unresolvedOnly = false) {
    let query = 'SELECT * FROM special_events_index';
    const params = [];
    if (unresolvedOnly) {
      query += ' WHERE resolved = 0';
    }
    query += ' ORDER BY importance DESC, created_at DESC LIMIT ?';
    params.push(limit);
    return this.db.prepare(query).all(...params);
  }

  resolveSpecialEvent(eventId) {
    return this.db.prepare('UPDATE special_events_index SET resolved = 1 WHERE id = ?').run(eventId);
  }

  queryTemporalGraph(queryStr, timeRange) {
    const results = { entities: [], edges: [], events: [], chunks: [] };
    const ftsQuery = this._buildFtsQuery(queryStr);
    const searchTerm = `%${queryStr || ''}%`;

    // Prefer FTS5 MATCH (unicode61) when a usable query exists; fall back to
    // LIKE only when the query is empty/unusable after sanitization.
    if (ftsQuery) {
      try {
        if (timeRange && timeRange.start && timeRange.end) {
          results.entities = this.db.prepare(`
            SELECT e.* FROM entities e
            JOIN entities_fts f ON e.id = f.entity_id
            WHERE entities_fts MATCH ?
              AND e.last_seen_at >= ? AND e.first_seen_at <= ?
            ORDER BY e.access_count DESC LIMIT 50
          `).all(ftsQuery, timeRange.start, timeRange.end);
        } else {
          results.entities = this.db.prepare(`
            SELECT e.* FROM entities e
            JOIN entities_fts f ON e.id = f.entity_id
            WHERE entities_fts MATCH ?
            ORDER BY e.access_count DESC LIMIT 50
          `).all(ftsQuery);
        }
      } catch (err) {
        // Malformed FTS query edge case — fall back to LIKE.
        results.entities = this.db.prepare(`
          SELECT * FROM entities WHERE name LIKE ? OR attributes LIKE ? ORDER BY access_count DESC LIMIT 50
        `).all(searchTerm, searchTerm);
      }

      try {
        if (timeRange && timeRange.start && timeRange.end) {
          // Time-bounded event search: FTS for relevance + created_at filter.
          results.events = this.db.prepare(`
            SELECT e.*, h.hour_key FROM events e
            JOIN hourly_chunks h ON e.chunk_id = h.id
            JOIN events_fts f ON e.id = f.event_id
            WHERE events_fts MATCH ?
              AND e.created_at >= ? AND e.created_at <= ?
            ORDER BY e.created_at DESC LIMIT 100
          `).all(ftsQuery, timeRange.start, timeRange.end);
        } else {
          results.events = this.db.prepare(`
            SELECT e.*, h.hour_key FROM events e
            JOIN hourly_chunks h ON e.chunk_id = h.id
            JOIN events_fts f ON e.id = f.event_id
            WHERE events_fts MATCH ?
            ORDER BY e.created_at DESC LIMIT 50
          `).all(ftsQuery);
        }
      } catch (err) {
        results.events = this.db.prepare(`
          SELECT e.*, h.hour_key FROM events e
          JOIN hourly_chunks h ON e.chunk_id = h.id
          WHERE e.content LIKE ?
          ORDER BY e.created_at DESC LIMIT 50
        `).all(searchTerm);
      }
    } else {
      // Empty / unusable query: keep previous time-range listing behavior.
      if (timeRange && timeRange.start && timeRange.end) {
        results.entities = this.db.prepare(`
          SELECT * FROM entities WHERE last_seen_at >= ? AND first_seen_at <= ?
          ORDER BY access_count DESC LIMIT 50
        `).all(timeRange.start, timeRange.end);
        results.events = this.db.prepare(`
          SELECT e.*, h.hour_key FROM events e
          JOIN hourly_chunks h ON e.chunk_id = h.id
          WHERE e.created_at >= ? AND e.created_at <= ?
          ORDER BY e.created_at DESC LIMIT 100
        `).all(timeRange.start, timeRange.end);
      } else {
        results.entities = this.db.prepare(`
          SELECT * FROM entities ORDER BY access_count DESC LIMIT 50
        `).all();
        results.events = this.db.prepare(`
          SELECT e.*, h.hour_key FROM events e
          JOIN hourly_chunks h ON e.chunk_id = h.id
          ORDER BY e.created_at DESC LIMIT 50
        `).all();
      }
    }

    if (results.entities.length > 0) {
      const entityIds = results.entities.map(e => e.id);
      const placeholders = entityIds.map(() => '?').join(',');
      results.edges = this.db.prepare(`
        SELECT * FROM entity_edges WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
        ORDER BY weight DESC LIMIT 100
      `).all(...entityIds, ...entityIds);
    }

    results.chunks = this.db.prepare(`
      SELECT * FROM hourly_chunks WHERE hour_key >= COALESCE(?, '1970-01-01T00') AND hour_key <= COALESCE(?, '2099-12-31T23')
      ORDER BY hour_key DESC LIMIT 48
    `).all(timeRange ? timeRange.start : null, timeRange ? timeRange.end : null);

    return results;
  }

  /**
   * Lazily run consolidation if it hasn't been checked recently. Called from
   * read paths (like getContextWindow) rather than a background timer, so
   * daily summaries appear on-demand following the 24h cycle without any
   * cron/daemon dependency.
   * @private
   */
  _maybeRunLazyConsolidation() {
    const now = Date.now();
    if (now - this._lastConsolidationCheckMs < this._consolidationCheckIntervalMs) {
      return;
    }
    this._lastConsolidationCheckMs = now;
    try {
      this.runConsolidation();
    } catch (err) {
      console.error('[TemporalKnowledgeGraph] Lazy consolidation error:', err.message);
    }
  }


  /**
   * Approximate token count (chars / 4). Good enough for budget enforcement
   * without pulling a tokenizer dependency.
   * @private
   */
  _approxTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / 4);
  }

  /**
   * Assemble a context window under an approximate token budget.
   * Priority order (high → low): working anchor → special events →
   * long_term → rule_emotion → query-relevant → recent 24h → daily links →
   * current hour meta. Sections are added only while budget remains.
   *
   * @param {string} queryStr
   * @param {number} maxEvents - soft cap on recent event lines (legacy)
   * @param {number} [tokenBudget=6000] - approximate token ceiling
   * @returns {string}
   */
  getContextWindow(queryStr, maxEvents = 20, tokenBudget = 6000) {
    this._maybeRunLazyConsolidation();

    const budget = typeof tokenBudget === 'number' && tokenBudget > 0 ? tokenBudget : 6000;
    let used = 0;
    const parts = [];

    const tryAdd = (line) => {
      const cost = this._approxTokens(line) + 1;
      if (used + cost > budget) return false;
      parts.push(line);
      used += cost;
      return true;
    };

    const tryAddSection = (header, lines) => {
      if (!lines || lines.length === 0) return;
      if (!tryAdd(header)) return;
      for (const line of lines) {
        if (!tryAdd(line)) break;
      }
      tryAdd('');
    };

    const anchor = this.getWorkingAnchor();
    const specialEvents = this.getSpecialEvents(5, true);
    const recent = this.getRecentEvents(24);

    const now = new Date();
    const hourKey = this._getHourKey(now);
    const currentChunk = this.getHourlyChunk(hourKey);

    // Priority 1 — Working anchor
    {
      const lines = [
        `Current Time: ${anchor.current_timestamp}`,
        `Situation: ${anchor.current_situation || 'No active context'}`
      ];
      if (anchor.key_entities) {
        let entities = [];
        try { entities = JSON.parse(anchor.key_entities); } catch {}
        if (entities.length > 0) {
          lines.push(`Active Entities: ${entities.join(', ')}`);
        }
      }
      tryAddSection('=== \u0986\u09ae\u09bf (Working Memory Anchor) ===', lines);
    }

    // Priority 2 — Special / highlighted events
    if (specialEvents.length > 0) {
      const lines = [];
      for (const se of specialEvents) {
        lines.push(`- ${se.event_name} (importance: ${se.importance})`);
        if (se.summary) lines.push(`  Summary: ${se.summary.substring(0, 200)}`);
      }
      tryAddSection('=== Highlighted Special Events ===', lines);
    }

    const recentIds = new Set(recent.slice(0, maxEvents).map(ev => ev.id));
    const longTermEvents = this.getEventsByCategory('long_term', 15).filter(ev => !recentIds.has(ev.id));
    const ruleEmotionEvents = this.getEventsByCategory('rule_emotion', 10).filter(ev => !recentIds.has(ev.id));

    // Priority 3 — Long-term knowledge
    if (longTermEvents.length > 0) {
      const lines = longTermEvents.map(ev =>
        `[${ev.hour_key}] ${(ev.content || '').substring(0, 300)}`
      );
      tryAddSection('=== Long-Term Knowledge ===', lines);
    }

    // Priority 4 — Rules & behavioral context
    if (ruleEmotionEvents.length > 0) {
      const lines = ruleEmotionEvents.map(ev =>
        `[${ev.hour_key}] ${(ev.content || '').substring(0, 300)}`
      );
      tryAddSection('=== Rules & Behavioral Context ===', lines);
    }

    // Priority 5 — Query-relevant (FTS)
    if (queryStr) {
      const queryResult = this.queryTemporalGraph(queryStr, {
        start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
        end: new Date().toISOString()
      });
      if (queryResult.entities.length > 0) {
        const lines = queryResult.entities.slice(0, 10).map(ent =>
          `- ${ent.name} (${ent.type})`
        );
        tryAddSection('=== Relevant Entities ===', lines);
      }
      if (queryResult.events.length > 0) {
        const lines = queryResult.events.slice(0, 10).map(ev =>
          `[${ev.hour_key}] ${(ev.content || '').substring(0, 200)}`
        );
        tryAddSection('=== Relevant Past Events ===', lines);
      }
    }

    // Priority 6 — Backend NodeGraph context. Nodes are ranked by lexical
    // relevance plus activation, recency, and repeated usage; traversal also
    // strengthens their neighborhood for future turns.
    if (queryStr && this.nodeGraph) {
      try {
        const graphContext = this.nodeGraph.getContext(queryStr, 8);
        if (graphContext.length > 0) {
          const lines = graphContext.map(node => {
            const category = node.context.memoryCategory || node.kind;
            const usage = node.accessCount != null ? node.accessCount : 0;
            return `- [${category}] ${node.text.substring(0, 300)} (activation: ${Number(node.activation || 0).toFixed(2)}, uses: ${usage})`;
          });
          tryAddSection('=== NodeGraph Context (usage-ranked) ===', lines);
        }
      } catch (err) {
        // Retrieval enrichment is best-effort; canonical memory remains usable.
        console.warn('[TemporalKnowledgeGraph] NodeGraph retrieval warning:', err.message);
      }
    }

    // Priority 7 — Recent events (24h)
    if (recent.length > 0) {
      const lines = [];
      for (const ev of recent.slice(0, maxEvents)) {
        const content = (ev.content || '').substring(0, 300);
        const category = ev.memory_category || 'daily';
        lines.push(`[${ev.hour_key}] [${ev.source}] [${category}] ${content}`);
      }
      tryAddSection('=== Recent Events (Last 24h) ===', lines);
    }

    // Priority 8 — Inter-day neural connections
    try {
      const todayKey = this._getDateKey(new Date());
      const connected = this.getConnectedDailySummaries(todayKey, 3);
      if (connected.length > 0) {
        const lines = connected.map(conn => {
          const summary = conn.summary;
          const weight = conn.weight != null ? conn.weight.toFixed(2) : '?';
          const snippet = (summary.summary || summary.content || '').substring(0, 300);
          return `[${conn.dateKey}] (relevance: ${weight}) ${snippet}`;
        });
        tryAddSection('=== Related Past Days (Neural Connections) ===', lines);
      }
    } catch {
      // best-effort
    }

    // Priority 9 — Current hour meta
    if (currentChunk && currentChunk.status !== 'EMPTY') {
      tryAddSection(`=== Current Hourly Chunk: ${currentChunk.hour_key} ===`, [
        `Events in this hour: ${currentChunk.event_count}`
      ]);
    }

    return parts.join('\n');
  }


  /**
   * Lazily consolidate any fully-elapsed calendar day (UTC) that does not yet
   * have a daily_summary. "Fully elapsed" means the day is strictly before
   * today's UTC date - the current day is never consolidated since it may
   * still receive more events (24h cycle). This is designed to be called
   * on-demand (e.g. from a read/context-window path) rather than from a
   * background timer, so no chunks are ever "missing" or backfilled -
   * consolidation simply runs whenever it's next needed.
   */
  runConsolidation() {
    const report = { hoursConsolidated: 0, daysSummarized: 0, entitiesArchived: 0, edgesDeprecated: 0, dailyEdgesCreated: 0 };

    const todayKey = this._getDateKey(new Date());

    // Any ACTIVE hourly chunk belonging to a day strictly before today is
    // eligible for consolidation - this is a rolling 24h-cycle boundary,
    // not a fixed lookback window.
    const eligibleChunks = this.db.prepare(`
      SELECT * FROM hourly_chunks WHERE status = 'ACTIVE' AND substr(hour_key, 1, 10) < ? ORDER BY hour_key ASC
    `).all(todayKey);

    const dailyGroups = {};
    for (const chunk of eligibleChunks) {
      const dateKey = chunk.hour_key.substring(0, 10);
      if (!dailyGroups[dateKey]) dailyGroups[dateKey] = [];
      dailyGroups[dateKey].push(chunk);
    }

    const newlyCreatedDateKeys = [];

    for (const [dateKey, chunks] of Object.entries(dailyGroups)) {
      const existingDaily = this.db.prepare('SELECT * FROM daily_summaries WHERE date_key = ?').get(dateKey);
      if (existingDaily) continue;

      const chunkIds = chunks.map(c => c.id);
      const allEvents = [];
      for (const cid of chunkIds) {
        const evts = this.getEventsInChunk(cid);
        allEvents.push(...evts);
      }

      const summary = this._buildDailySummary(allEvents);

      const entityIds = new Set();
      for (const ev of allEvents) {
        let metadata = {};
        try { metadata = JSON.parse(ev.metadata || '{}'); } catch {}
        if (metadata.entityIds) metadata.entityIds.forEach(id => entityIds.add(id));
      }
      const activeEntitiesDuringPeriod = this.db.prepare(
        "SELECT id FROM entities WHERE last_seen_at >= ? AND last_seen_at <= ?"
      ).all(chunks[0].created_at, chunks[chunks.length - 1].updated_at);
      for (const ent of activeEntitiesDuringPeriod) {
        entityIds.add(ent.id);
      }

      const graphSnapshot = JSON.stringify({
        entities: Array.from(entityIds),
        eventCount: allEvents.length,
        chunkCount: chunks.length
      });

      this.db.prepare(`
        INSERT INTO daily_summaries (id, date_key, summary, graph_snapshot, chunk_ids, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(this._uuid(), dateKey, summary, graphSnapshot, JSON.stringify(chunkIds), this._now());

      for (const chunk of chunks) {
        this.db.prepare('UPDATE hourly_chunks SET status = ?, consolidated_into = ?, updated_at = ? WHERE id = ?').run('CONSOLIDATED', `daily:${dateKey}`, this._now(), chunk.id);
        report.hoursConsolidated++;
      }
      report.daysSummarized++;
      newlyCreatedDateKeys.push(dateKey);
    }

    // Link each newly-created daily summary to every other existing daily
    // summary using fast token-overlap similarity, forming a
    // neural-network-like web of connections between days so retrieval can
    // traverse related days without reading every day's full text.
    for (const dateKey of newlyCreatedDateKeys) {
      report.dailyEdgesCreated += this._linkDailySummary(dateKey);
    }

    const archiveDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const staleEntities = this.db.prepare('SELECT * FROM entities WHERE last_seen_at < ? AND access_count < 3').all(archiveDate);
    for (const ent of staleEntities) {
      this.db.prepare('UPDATE entities SET is_active = 0 WHERE id = ?').run(ent.id);
      report.entitiesArchived++;
    }

    // Deprecate edges that haven't been confirmed (reinforced), contradicted,
    // or freshly created in 30+ days. Gated on updated_at, not created_at:
    // an edge that keeps getting restated/reinforced has its updated_at
    // bumped every time (see addEntityRelation), so a fact that is still
    // actively true stays exempt indefinitely even if it was first recorded
    // long ago. Only edges nobody has touched in 30 days — genuinely stale —
    // get archived here.
    const oldEdges = this.db.prepare('SELECT * FROM entity_edges WHERE valid_until IS NULL AND updated_at < ?').all(archiveDate);
    for (const edge of oldEdges) {
      this.db.prepare('UPDATE entity_edges SET valid_until = ? WHERE id = ?').run(archiveDate, edge.id);
      report.edgesDeprecated++;
    }

    return report;
  }

  /**
   * Build a real extractive daily summary: rank events by importance
   * (highest first) rather than concatenating everything in chronological
   * order, so the most significant things that happened in the day surface
   * first even when truncated for length.
   * @param {Array<Object>} events
   * @returns {string}
   * @private
   */
  _buildDailySummary(events) {
    if (events.length === 0) return 'No activity recorded.';

    const ranked = [...events].sort((a, b) => (b.importance || 0) - (a.importance || 0));

    const lines = ranked.map(e => {
      const tag = e.importance >= 0.7 ? '[KEY] ' : '';
      return `${tag}[${e.source}] ${(e.content || '').substring(0, 200)}`;
    });

    return lines.join('\n').substring(0, 5000);
  }

  /**
   * Tokenize text into a bag-of-words frequency map for fast, dependency-free
   * similarity scoring between day summaries.
   * @param {string} text
   * @returns {Map<string, number>}
   * @private
   */
  _tokenizeForSimilarity(text) {
    const freq = new Map();
    const tokens = (text || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2);
    for (const t of tokens) {
      freq.set(t, (freq.get(t) || 0) + 1);
    }
    return freq;
  }

  /**
   * Cosine similarity between two term-frequency maps.
   * @param {Map<string, number>} a
   * @param {Map<string, number>} b
   * @returns {number} similarity in [0, 1]
   * @private
   */
  _cosineSimilarity(a, b) {
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (const [term, freq] of a.entries()) {
      magA += freq * freq;
      if (b.has(term)) dot += freq * b.get(term);
    }
    for (const freq of b.values()) {
      magB += freq * freq;
    }
    if (magA === 0 || magB === 0) return 0;
    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  /**
   * Link a daily summary to every other existing daily summary whose
   * similarity exceeds the threshold, storing a weighted edge in
   * daily_summary_edges. This is what lets retrieval "traverse" related
   * days instead of the LLM having to read every day's text.
   * @param {string} dateKey
   * @param {number} [threshold=0.3]
   * @returns {number} number of edges created
   * @private
   */
  _linkDailySummary(dateKey, threshold = 0.3) {
    const target = this.db.prepare('SELECT * FROM daily_summaries WHERE date_key = ?').get(dateKey);
    if (!target) return 0;

    const others = this.db.prepare('SELECT * FROM daily_summaries WHERE date_key != ?').all(dateKey);
    if (others.length === 0) return 0;

    const targetVec = this._tokenizeForSimilarity(target.summary);
    const now = this._now();
    let created = 0;

    const upsert = this.db.prepare(`
      INSERT INTO daily_summary_edges (id, source_date_key, target_date_key, weight, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_date_key, target_date_key) DO UPDATE SET weight = excluded.weight, updated_at = excluded.updated_at
    `);

    for (const other of others) {
      const otherVec = this._tokenizeForSimilarity(other.summary);
      const sim = this._cosineSimilarity(targetVec, otherVec);
      if (sim >= threshold) {
        const weight = Math.round(sim * 1000) / 1000;
        upsert.run(this._uuid(), dateKey, other.date_key, weight, now, now);
        upsert.run(this._uuid(), other.date_key, dateKey, weight, now, now);
        created++;
      }
    }

    return created;
  }

  /**
   * Get daily summaries connected to a given date, ordered by connection
   * strength (highest weight first). Mirrors entity-edge traversal but at
   * the day-summary level.
   * @param {string} dateKey
   * @param {number} [limit=10]
   * @returns {Array<Object>}
   */
  getConnectedDailySummaries(dateKey, limit = 10) {
    const edges = this.db.prepare(`
      SELECT * FROM daily_summary_edges WHERE source_date_key = ? ORDER BY weight DESC LIMIT ?
    `).all(dateKey, limit);

    return edges.map(edge => ({
      dateKey: edge.target_date_key,
      weight: edge.weight,
      summary: this.db.prepare('SELECT * FROM daily_summaries WHERE date_key = ?').get(edge.target_date_key)
    })).filter(r => r.summary);
  }

  /**
   * Backend-only NodeGraph accessors. The graph is intentionally kept behind
   * the memory package so frontend code cannot create sessions or mutate
   * memory topology directly.
   */
  getNodeGraph() {
    return this.nodeGraph;
  }

  getSelectiveContext(queryStr, options = {}) {
    if (!this.selectiveMemory) return { items: [], text: '', trace: {}, stats: { fallbackReason: 'not_initialized' } };
    return this.selectiveMemory.retrieve(queryStr, options);
  }

  getSelectiveMemoryStats(scope) {
    return this.selectiveMemory ? this.selectiveMemory.stats(scope) : { chunks: 0, edges: 0, postings: 0, retrievals: 0, byRegion: [] };
  }

  listSelectiveMemory(scope, options = {}) {
    return this.selectiveMemory ? this.selectiveMemory.list(scope, options) : [];
  }

  inspectSelectiveMemory(scope, chunkId) {
    return this.selectiveMemory ? this.selectiveMemory.inspect(scope, chunkId) : null;
  }

  forgetSelectiveMemory(scope, chunkId) {
    return this.selectiveMemory ? this.selectiveMemory.forget(scope, chunkId) : { forgotten: false, chunkId };
  }

  reindexSelectiveMemory(scope) {
    return this.selectiveMemory ? this.selectiveMemory.reindex(scope) : { reindexed: 0 };
  }

  getNodeGraphContext(queryStr, limit = 8) {
    if (!this.nodeGraph) return [];
    return this.nodeGraph.getContext(queryStr, limit);
  }

  getNodeGraphSnapshot(limit = 100) {
    if (!this.nodeGraph) return { nodes: [], edges: [] };
    return this.nodeGraph.snapshot(limit);
  }

  getStats() {
    const chunkStats = this.db.prepare(`
      SELECT status, COUNT(*) as count, SUM(event_count) as total_events FROM hourly_chunks GROUP BY status
    `).all();
    const entityCount = this.db.prepare('SELECT COUNT(*) as count FROM entities').get().count;
    const activeEntityCount = this.db.prepare('SELECT COUNT(*) as count FROM entities WHERE is_active = 1').get().count;
    const edgeCount = this.db.prepare('SELECT COUNT(*) as count FROM entity_edges').get().count;
    const eventCount = this.db.prepare('SELECT COUNT(*) as count FROM events').get().count;
    const specialCount = this.db.prepare('SELECT COUNT(*) as count FROM special_events_index').get().count;
    const unresolvedSpecialCount = this.db.prepare('SELECT COUNT(*) as count FROM special_events_index WHERE resolved = 0').get().count;
    const dailyCount = this.db.prepare('SELECT COUNT(*) as count FROM daily_summaries').get().count;

    // Per-category counts for both events and entities, so a dashboard or
    // caller can show "how much memory is in each of the 4 categories"
    // without a separate query per category. Categories with zero events
    // still appear (0), so consumers don't need to special-case missing
    // keys.
    const eventCategoryRows = this.db.prepare('SELECT memory_category, COUNT(*) as count FROM events GROUP BY memory_category').all();
    const entityCategoryRows = this.db.prepare('SELECT memory_category, COUNT(*) as count FROM entities GROUP BY memory_category').all();
    const eventsByCategory = {};
    const entitiesByCategory = {};
    for (const cat of this.MEMORY_CATEGORIES) {
      eventsByCategory[cat] = 0;
      entitiesByCategory[cat] = 0;
    }
    for (const row of eventCategoryRows) {
      if (Object.prototype.hasOwnProperty.call(eventsByCategory, row.memory_category)) {
        eventsByCategory[row.memory_category] = row.count;
      }
    }
    for (const row of entityCategoryRows) {
      if (Object.prototype.hasOwnProperty.call(entitiesByCategory, row.memory_category)) {
        entitiesByCategory[row.memory_category] = row.count;
      }
    }

    const anchor = this.getWorkingAnchor();

    return {
      chunks: chunkStats,
      entities: { total: entityCount, active: activeEntityCount, byCategory: entitiesByCategory },
      edges: edgeCount,
      events: eventCount,
      eventsByCategory,
      specialEvents: { total: specialCount, unresolved: unresolvedSpecialCount },
      dailySummaries: dailyCount,
      nodeGraph: this.nodeGraph ? this.nodeGraph.getStats() : { nodes: 0, edges: 0, activeNodes: 0 },
      workingAnchor: { situation: (anchor.current_situation || '').substring(0, 100), entityCount: anchor.key_entities ? JSON.parse(anchor.key_entities).length : 0 },
      timestamp: this._now()
    };
  }

  /**
   * Lazy TemporaryMemory helper (project-scoped scratch + summary rollup).
   */
  getTemporaryMemory() {
    if (!this._temporaryMemory) {
      const TemporaryMemory = require('./temporary-memory');
      this._temporaryMemory = new TemporaryMemory(this);
    }
    return this._temporaryMemory;
  }

  /**
   * Lazy MultiHopRetriever – supports call → analysis → call loop.
   */
  getMultiHopRetriever() {
    if (!this._multiHopRetriever) {
      const MultiHopRetriever = require('./multi-hop-retriever');
      this._multiHopRetriever = new MultiHopRetriever(this);
    }
    return this._multiHopRetriever;
  }

  /**
   * Convenience wrapper for multi-hop retrieval.
   */
  multiHopRetrieve(opts) {
    return this.getMultiHopRetriever().retrieve(opts);
  }

  /**
   * Record a free-form dynamic category label on an entity.
   */
  ensureDynamicCategory(entityId, categoryLabel) {
    if (!categoryLabel) return;
    this.db.prepare(`
      UPDATE entities SET dynamic_category = ? WHERE id = ?
    `).run(String(categoryLabel).slice(0, 120), entityId);
  }

  /**
   * Usage-based proximity: bump access_count + activation.
   */
  recordEntityUsage(entityId) {
    this.db.prepare(`
      UPDATE entities
      SET access_count = COALESCE(access_count, 0) + 1,
          activation = MIN(1.0, COALESCE(activation, 0) + 0.08),
          last_seen_at = datetime('now')
      WHERE id = ?
    `).run(entityId);
  }

  close() {
    if (this.db) {
      this.db.close();
      this.initialized = false;
    }
  }
}

module.exports = TemporalKnowledgeGraph;
