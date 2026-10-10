'use strict';

const crypto = require('crypto');
const { tokenize } = require('./text-tokens');
const { splitParagraphs } = require('./paragraph-chunker');
const { canonicalRegion, CANONICAL_REGIONS } = require('./regions');
const { cosineSimilarity } = require('./embedding-provider');

const STOP_WORDS = new Set([
  'the', 'and', 'that', 'this', 'with', 'from', 'what', 'when', 'where', 'which',
  'how', 'does', 'will', 'would', 'could', 'should', 'have', 'has', 'into',
  'about', 'your', 'you', 'for', 'are', 'was', 'were', 'been', 'আমি', 'এবং',
  'এই', 'সেই', 'কী', 'কেন', 'কখন', 'কোথায়', 'করতে', 'হবে', 'জন্য',
]);

// Bump when tokenization changes so stored tokens/postings are rebuilt once.
const TOKENIZER_VERSION = 'v2-indic-marks-bengali-stems';
// Bump when the memory unit changes (whole message -> paragraph) so old chunks are re-cut once.
const CHUNKING_VERSION = 'p1-paragraphs';
// Chunks longer than this many characters are candidates for re-cutting into paragraphs.
const RECHUNK_MIN_CHARS = 1400;

function nowIso() { return new Date().toISOString(); }
function id(prefix) { return `${prefix}-${crypto.randomUUID()}`; }
function clamp(value, min = 0, max = 1) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}
function safeJson(value, fallback = {}) {
  try { return JSON.stringify(value == null ? fallback : value); } catch { return JSON.stringify(fallback); }
}
function parseJson(value, fallback = {}) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

class SelectiveMemoryEngine {
  constructor(db, options = {}) {
    if (!db || typeof db.prepare !== 'function') throw new Error('SelectiveMemoryEngine requires a SQLite database');
    this.db = db;
    this.options = {
      candidateLimit: 64,
      maxSelected: 12,
      maxDepth: 2,
      maxNeighbors: 6,
      maxTokens: 1200,
      minScore: 0.04,
      // Relevance evidence an item needs before priors (freshness, importance,
      // confidence, region) may rank it: at least two matching query tokens, or
      // this share of the query's tokens, or a real embedding similarity.
      minLexical: 0.12,
      minSemantic: 0.35,
      scope: {
        agentId: process.env.MIKI_AGENT_ID || 'miki',
        ownerId: process.env.MIKI_OWNER_ID || 'default-owner',
        workspaceId: process.env.MIKI_WORKSPACE_ID || 'default-workspace',
      },
      embeddingProvider: null,
      ...options,
    };
    this.embeddingProvider = this.options.embeddingProvider || null;
    this.initialized = false;
  }

  initializeSync() {
    if (this.initialized) return this;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_chunk_index (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        region TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        content_hash TEXT NOT NULL,
        source_type TEXT,
        source_reference TEXT,
        provenance TEXT NOT NULL DEFAULT 'conversation',
        confidence REAL NOT NULL DEFAULT 0.7,
        importance REAL NOT NULL DEFAULT 0.5,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_accessed_at TEXT,
        access_count INTEGER NOT NULL DEFAULT 0,
        expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        metadata TEXT NOT NULL DEFAULT '{}',
        embedding TEXT,
        UNIQUE(scope_key, content_hash)
      );
      CREATE INDEX IF NOT EXISTS idx_mci_scope_region_status
        ON memory_chunk_index(scope_key, region, status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_mci_scope_rank
        ON memory_chunk_index(scope_key, status, importance DESC, confidence DESC, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_mci_source
        ON memory_chunk_index(scope_key, source_type, source_reference);

      CREATE TABLE IF NOT EXISTS memory_chunk_postings (
        scope_key TEXT NOT NULL,
        token TEXT NOT NULL,
        chunk_id TEXT NOT NULL,
        frequency INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(scope_key, token, chunk_id),
        FOREIGN KEY(chunk_id) REFERENCES memory_chunk_index(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_token_scope ON memory_chunk_postings(scope_key, token);
      CREATE INDEX IF NOT EXISTS idx_mcp_chunk ON memory_chunk_postings(scope_key, chunk_id);

      CREATE TABLE IF NOT EXISTS memory_chunk_edges (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        source_chunk_id TEXT NOT NULL,
        target_chunk_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.2,
        confidence REAL NOT NULL DEFAULT 0.7,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE(scope_key, source_chunk_id, target_chunk_id, relation_type),
        FOREIGN KEY(source_chunk_id) REFERENCES memory_chunk_index(id) ON DELETE CASCADE,
        FOREIGN KEY(target_chunk_id) REFERENCES memory_chunk_index(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mce_source ON memory_chunk_edges(scope_key, source_chunk_id, weight DESC);
      CREATE INDEX IF NOT EXISTS idx_mce_target ON memory_chunk_edges(scope_key, target_chunk_id, weight DESC);

      CREATE TABLE IF NOT EXISTS memory_retrieval_events (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL,
        query TEXT NOT NULL,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        selected_count INTEGER NOT NULL DEFAULT 0,
        selected_ids TEXT NOT NULL DEFAULT '[]',
        trace TEXT NOT NULL DEFAULT '{}',
        token_budget INTEGER NOT NULL DEFAULT 0,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL DEFAULT 0,
        fallback_reason TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mre_scope_time ON memory_retrieval_events(scope_key, created_at DESC);
    `);
    this.initialized = true;
    this._migrateTokenizer();
    this._migrateParagraphs();
    return this;
  }

  /**
   * Chunks stored before the tokenizer learned Bengali have mangled tokens and
   * postings. Rebuild them once whenever the tokenizer version changes.
   */
  _migrateTokenizer() {
    this.db.exec('CREATE TABLE IF NOT EXISTS memory_engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const current = this.db.prepare("SELECT value FROM memory_engine_meta WHERE key = 'tokenizer_version'").get();
    if (current && current.value === TOKENIZER_VERSION) return;
    const select = this.db.prepare('SELECT rowid AS rid, id, scope_key, content, metadata FROM memory_chunk_index WHERE rowid > ? ORDER BY rowid LIMIT 500');
    const updateMeta = this.db.prepare('UPDATE memory_chunk_index SET metadata = ? WHERE id = ?');
    const clearPostings = this.db.prepare('DELETE FROM memory_chunk_postings WHERE chunk_id = ?');
    const insertPosting = this.db.prepare('INSERT OR REPLACE INTO memory_chunk_postings (scope_key, token, chunk_id, frequency) VALUES (?, ?, ?, 1)');
    let last = 0;
    for (;;) {
      const rows = select.all(last);
      if (rows.length === 0) break;
      this.db.transaction(() => {
        for (const row of rows) {
          const tokens = this.normalizeTokens(row.content);
          const metadata = parseJson(row.metadata, {});
          updateMeta.run(safeJson({ ...metadata, tokens }), row.id);
          clearPostings.run(row.id);
          for (const token of tokens) insertPosting.run(row.scope_key, token, row.id);
        }
      })();
      last = rows[rows.length - 1].rid;
    }
    this.db.prepare("INSERT OR REPLACE INTO memory_engine_meta (key, value) VALUES ('tokenizer_version', ?)").run(TOKENIZER_VERSION);
  }

  /**
   * Memories written before paragraph chunking are whole messages. Re-cut the long
   * ones once: each becomes a chain of paragraph chunks, and the original chunk is
   * marked 'superseded' (not deleted; the raw event still holds the full text).
   */
  _migrateParagraphs() {
    const current = this.db.prepare("SELECT value FROM memory_engine_meta WHERE key = 'chunking_version'").get();
    if (current && current.value === CHUNKING_VERSION) return;
    const select = this.db.prepare(`SELECT rowid AS rid, * FROM memory_chunk_index
      WHERE rowid > ? AND status = 'active' AND length(content) > ? AND metadata NOT LIKE '%"paragraphCount"%'
      ORDER BY rowid LIMIT 100`);
    const supersede = this.db.prepare("UPDATE memory_chunk_index SET status = 'superseded', updated_at = ? WHERE id = ?");
    let last = 0;
    for (;;) {
      const rows = select.all(last, RECHUNK_MIN_CHARS);
      if (rows.length === 0) break;
      for (const row of rows) {
        last = row.rid;
        const parts = splitParagraphs(row.content);
        if (parts.length <= 1) continue;
        const [agentId, ownerId, workspaceId] = String(row.scope_key).split(':').map(decodeURIComponent);
        const old = parseJson(row.metadata, {});
        const result = this.ingestParagraphs({
          scope: { agentId, ownerId, workspaceId },
          content: row.content,
          region: row.region,
          sourceType: row.source_type,
          sourceReference: row.source_reference,
          provenance: row.provenance,
          confidence: Number(row.confidence),
          importance: Number(row.importance),
          createdAt: row.created_at,
          entities: Array.isArray(old.entities) ? old.entities : [],
          metadata: { ...old, rechunkedFrom: row.id },
          group: `rechunk-${row.id}`,
        });
        if (result.chunkIds.length > 0) supersede.run(nowIso(), row.id);
      }
    }
    this.db.prepare("INSERT OR REPLACE INTO memory_engine_meta (key, value) VALUES ('chunking_version', ?)").run(CHUNKING_VERSION);
  }

  normalizeScope(scope = {}) {
    const input = { ...this.options.scope, ...(scope || {}) };
    const agentId = String(input.agentId || input.agent_id || '').trim() || 'miki';
    const ownerId = String(input.ownerId || input.owner_id || '').trim() || 'default-owner';
    const workspaceId = String(input.workspaceId || input.workspace_id || '').trim() || 'default-workspace';
    return { agentId, ownerId, workspaceId, scopeKey: [agentId, ownerId, workspaceId].map(encodeURIComponent).join(':'), legacyScopeKey: `${agentId}:${ownerId}:${workspaceId}` };
  }

  _scopeKeys(scope) {
    return scope.legacyScopeKey && scope.legacyScopeKey !== scope.scopeKey
      ? [scope.scopeKey, scope.legacyScopeKey]
      : [scope.scopeKey];
  }

  estimatePromptTokens(text) {
    const value = String(text || '');
    let ascii = 0;
    let nonAscii = 0;
    for (const character of value) {
      if (character.codePointAt(0) < 128) ascii += 1;
      else nonAscii += 1;
    }
    return Math.max(1, Math.ceil(ascii / 4) + Math.ceil(nonAscii / 2));
  }

  normalizeTokens(text) {
    return tokenize(text, { stopWords: STOP_WORDS, max: 96 });
  }

  inferRegions(query) {
    const text = String(query || '').toLowerCase();
    const regions = new Set();
    if (/(schedule|calendar|task|todo|deadline|tomorrow|today|পরিকল্পনা|সময়|কাজ|শিডিউল)/iu.test(text)) regions.add('day_to_day');
    if (/(skill|tool|ability|workflow|how to|কীভাবে|দক্ষতা|টুল)/iu.test(text)) regions.add('skill');
    if (/(rule|always|never|prefer|behavior|emotion|guideline|নিয়ম|পছন্দ|আচরণ)/iu.test(text)) regions.add('rule_emotion');
    if (/(config|core|static|identity|stable|version|কনফিগ|স্থায়ী)/iu.test(text)) regions.add('static');
    if (regions.size === 0) return new Set(CANONICAL_REGIONS);
    regions.add('long_term');
    return regions;
  }

  _hash(content) {
    return crypto.createHash('sha256').update(String(content || '').trim().toLowerCase()).digest('hex');
  }

  _summary(content, explicitSummary) {
    if (explicitSummary) return String(explicitSummary).trim().slice(0, 600);
    const normalized = String(content || '').replace(/\s+/g, ' ').trim();
    return normalized.length > 600 ? `${normalized.slice(0, 597)}...` : normalized;
  }

  _embedding(content, explicitEmbedding) {
    if (explicitEmbedding && typeof explicitEmbedding.length === 'number') return Array.from(explicitEmbedding);
    if (this.embeddingProvider && typeof this.embeddingProvider.embedSync === 'function') {
      try {
        if (this.embeddingProvider.name !== 'hash-offline') return Array.from(this.embeddingProvider.embedSync(content));
      } catch (_) {
        // Semantic enrichment is optional; lexical retrieval remains safe.
      }
    }
    return null;
  }

  ingest(input = {}) {
    if (!this.initialized) this.initializeSync();
    const scope = this.normalizeScope(input.scope);
    const content = String(input.content || '').replace(/\s+/g, ' ').trim();
    if (!content || content.length < 2) return { stored: false, reason: 'empty' };
    const region = canonicalRegion(input.region || input.category, 'day_to_day');
    const contentHash = this._hash(`${region}|${content}`);
    const existing = this.db.prepare('SELECT * FROM memory_chunk_index WHERE scope_key = ? AND content_hash = ?').get(scope.scopeKey, contentHash);
    const now = input.createdAt ? new Date(input.createdAt).toISOString() : nowIso();
    if (existing) {
      this.db.prepare(`UPDATE memory_chunk_index SET access_count = access_count + 1, last_accessed_at = ?, updated_at = ?, confidence = MAX(confidence, ?), importance = MAX(importance, ?), status = 'active' WHERE id = ? AND scope_key = ?`)
        .run(now, now, clamp(input.confidence, 0, 1) || existing.confidence, clamp(input.importance, 0, 1) || existing.importance, existing.id, scope.scopeKey);
      return { stored: false, duplicate: true, chunkId: existing.id, region };
    }

    const chunkId = String(input.id || id('mchunk'));
    const tokens = this.normalizeTokens(content);
    const metadata = {
      ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
      tokens,
      entities: Array.isArray(input.entities) ? input.entities.slice(0, 64) : [],
    };
    const insert = this.db.prepare(`INSERT INTO memory_chunk_index
      (id, scope_key, region, content, summary, content_hash, source_type, source_reference, provenance, confidence, importance, created_at, updated_at, last_accessed_at, access_count, expires_at, status, metadata, embedding)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`);
    const post = this.db.prepare('INSERT OR REPLACE INTO memory_chunk_postings (scope_key, token, chunk_id, frequency) VALUES (?, ?, ?, ?)');
    const tx = this.db.transaction(() => {
      insert.run(
        chunkId,
        scope.scopeKey,
        region,
        content,
        this._summary(content, input.summary),
        contentHash,
        input.sourceType || input.source_type || 'conversation',
        input.sourceReference || input.source_reference || null,
        input.provenance || 'conversation',
        clamp(input.confidence, 0, 1) || 0.7,
        clamp(input.importance, 0, 1) || 0.5,
        now,
        now,
        now,
        1,
        input.expiresAt || null,
        safeJson(metadata),
        this._embedding(content, input.embedding),
      );
      for (const token of tokens) post.run(scope.scopeKey, token, chunkId, 1);
    });
    tx();
    this._linkRecent(scope, chunkId, region, tokens, input.relationType || 'related_to');
    return { stored: true, duplicate: false, chunkId, region, tokenCount: tokens.length };
  }

  _linkRecent(scope, chunkId, region, tokens, relationType) {
    const recent = this.db.prepare(`SELECT id, content, region, metadata FROM memory_chunk_index
      WHERE scope_key = ? AND status = 'active' AND id <> ? ORDER BY updated_at DESC LIMIT 12`).all(scope.scopeKey, chunkId);
    const tokenSet = new Set(tokens);
    for (const candidate of recent) {
      const candidateTokens = parseJson(candidate.metadata, {}).tokens || this.normalizeTokens(candidate.content);
      const overlap = candidateTokens.filter(token => tokenSet.has(token)).length;
      const regionBoost = candidate.region === region ? 0.12 : 0;
      const weight = clamp(0.12 + Math.min(0.65, overlap * 0.12) + regionBoost, 0, 1);
      // Sharing a region is not a relationship, and neither is one common word ("details", "notes").
      // Two topic words in common are the minimum for an edge; otherwise the graph becomes a web of
      // coincidences that drags unrelated memories into recall.
      if (overlap < 2) continue;
      this.connect(scope, chunkId, candidate.id, overlap > 1 ? relationType : 'related_to', { weight, confidence: 0.65, metadata: { tokenOverlap: overlap } });
    }
    this._linkByRareTokens(scope, chunkId, region, tokens, relationType, new Set(recent.map(candidate => candidate.id)));
  }

  /**
   * Connect a new chunk to OLDER chunks that share at least two rare tokens.
   * Linking only to the 12 most recent chunks would make the graph forget the
   * past: a fact from months ago could never be reached from today's context.
   * Rare tokens keep this cheap (their posting lists are short) and meaningful.
   */
  _linkByRareTokens(scope, chunkId, region, tokens, relationType, alreadyLinked) {
    const maxPosting = 500;
    const rare = [];
    const probe = this.db.prepare('SELECT COUNT(*) AS n FROM (SELECT 1 FROM memory_chunk_postings WHERE scope_key = ? AND token = ? LIMIT ?)');
    for (const token of tokens.slice(0, 32)) {
      const { n } = probe.get(scope.scopeKey, token, maxPosting + 1);
      if (n > 1 && n <= maxPosting) rare.push(token);
      if (rare.length >= 16) break;
    }
    if (rare.length < 2) return;
    const rows = this.db.prepare(`SELECT p.chunk_id AS id, c.region AS region, COUNT(*) AS overlap
      FROM memory_chunk_postings p JOIN memory_chunk_index c ON c.id = p.chunk_id
      WHERE p.scope_key = ? AND p.token IN (${rare.map(() => '?').join(',')}) AND p.chunk_id <> ? AND c.status = 'active'
      GROUP BY p.chunk_id HAVING COUNT(*) >= 2 ORDER BY overlap DESC LIMIT 8`).all(scope.scopeKey, ...rare, chunkId);
    for (const row of rows) {
      if (alreadyLinked.has(row.id)) continue;
      const weight = clamp(0.12 + Math.min(0.65, row.overlap * 0.12) + (row.region === region ? 0.12 : 0), 0, 1);
      this.connect(scope, chunkId, row.id, row.overlap > 1 ? relationType : 'related_to', { weight, confidence: 0.6, metadata: { tokenOverlap: row.overlap, link: 'rare_tokens' } });
    }
  }

  /**
   * Store text as paragraph-sized memories instead of one blob. Each paragraph is
   * its own chunk (so recalling it costs a few dozen tokens, not the whole
   * message) and consecutive paragraphs are chained with strong "next_paragraph"
   * edges, so the graph can still walk from a recalled paragraph to its
   * neighbours and rebuild the surrounding passage when needed.
   */
  ingestParagraphs(input = {}) {
    if (!this.initialized) this.initializeSync();
    const scope = this.normalizeScope(input.scope);
    const parts = splitParagraphs(String(input.content || ''), input.chunking);
    if (parts.length === 0) return { stored: false, reason: 'empty', chunkIds: [], paragraphs: 0 };
    const group = String(input.group || input.metadata?.eventId || id('mgroup'));
    const chunkIds = [];
    let storedCount = 0;
    for (const part of parts) {
      const result = this.ingest({
        ...input,
        content: part.text,
        summary: parts.length === 1 ? input.summary : null,
        metadata: {
          ...(input.metadata && typeof input.metadata === 'object' ? input.metadata : {}),
          paragraphGroup: group,
          paragraphIndex: part.index,
          paragraphCount: parts.length,
        },
      });
      if (result.chunkId) chunkIds.push(result.chunkId);
      if (result.stored) storedCount += 1;
    }
    for (let index = 1; index < chunkIds.length; index += 1) {
      if (chunkIds[index - 1] !== chunkIds[index]) {
        this.connect(scope, chunkIds[index - 1], chunkIds[index], 'next_paragraph', { weight: 0.85, confidence: 0.95, metadata: { group } });
      }
    }
    return { stored: storedCount > 0, chunkIds, paragraphs: parts.length, group };
  }

  connect(scopeInput, sourceChunkId, targetChunkId, relationType = 'related_to', options = {}) {
    if (!this.initialized) this.initializeSync();
    const scope = this.normalizeScope(scopeInput);
    if (!sourceChunkId || !targetChunkId || sourceChunkId === targetChunkId) return null;
    const exists = this.db.prepare('SELECT id FROM memory_chunk_index WHERE id IN (?, ?) AND scope_key = ?').all(sourceChunkId, targetChunkId, scope.scopeKey);
    if (exists.length !== 2) return null;
    const existing = this.db.prepare(`SELECT id FROM memory_chunk_edges WHERE scope_key = ? AND source_chunk_id = ? AND target_chunk_id = ? AND relation_type = ?`).get(scope.scopeKey, sourceChunkId, targetChunkId, relationType);
    const now = nowIso();
    if (existing) {
      this.db.prepare('UPDATE memory_chunk_edges SET weight = MIN(1, weight + 0.03), confidence = MAX(confidence, ?), updated_at = ?, metadata = ? WHERE id = ?')
        .run(clamp(options.confidence, 0, 1) || 0.7, now, safeJson(options.metadata || {}), existing.id);
      return existing.id;
    }
    const edgeId = id('medge');
    this.db.prepare(`INSERT INTO memory_chunk_edges
      (id, scope_key, source_chunk_id, target_chunk_id, relation_type, weight, confidence, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(edgeId, scope.scopeKey, sourceChunkId, targetChunkId, relationType, clamp(options.weight, 0, 1) || 0.2, clamp(options.confidence, 0, 1) || 0.7, now, now, safeJson(options.metadata || {}));
    return edgeId;
  }

  /**
   * Fix #8: retention/consolidation for the selective store.
   * - archives expired chunks
   * - removes orphan postings
   * - trims retrieval events older than 30 days (and caps per-scope rows)
   * - merges exact normalized duplicates (keeps the highest importance row)
   * Idempotent and transactional; safe to run from the daemon.
   */
  maintenance(options = {}) {
    if (!this.initialized) this.initializeSync();
    const now = nowIso();
    const eventCutoff = new Date(Date.now() - Number(options.eventRetentionDays || 30) * 86400000).toISOString();
    const report = { expired: 0, orphanPostings: 0, eventsDeleted: 0, duplicatesMerged: 0 };
    const tx = this.db.transaction(() => {
      report.expired = this.db.prepare("UPDATE memory_chunk_index SET status = 'archived', updated_at = ? WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").run(now, now).changes;
      report.orphanPostings = this.db.prepare('DELETE FROM memory_chunk_postings WHERE chunk_id NOT IN (SELECT id FROM memory_chunk_index)').run().changes;
      report.eventsDeleted = this.db.prepare('DELETE FROM memory_retrieval_events WHERE created_at < ?').run(eventCutoff).changes;
      const dupes = this.db.prepare(`SELECT scope_key, region, lower(trim(content)) AS norm, COUNT(*) AS n
        FROM memory_chunk_index WHERE status = 'active' GROUP BY scope_key, region, norm HAVING n > 1 LIMIT 500`).all();
      for (const d of dupes) {
        const rows = this.db.prepare(`SELECT id FROM memory_chunk_index WHERE scope_key = ? AND region = ? AND status = 'active' AND lower(trim(content)) = ? ORDER BY importance DESC, confidence DESC, updated_at DESC`).all(d.scope_key, d.region, d.norm);
        for (const r of rows.slice(1)) {
          this.db.prepare("UPDATE memory_chunk_index SET status = 'merged', updated_at = ? WHERE id = ?").run(now, r.id);
          report.duplicatesMerged++;
        }
      }
    });
    tx();
    return report;
  }

  _candidateRows(scope, tokens, regions) {
    // Fix #3: Hybrid retrieval — lexical and semantic candidates are always
    // merged. The previous early-return meant that when lexical hits existed,
    // semantic-only matches (high importance/confidence but different phrasing)
    // were silently dropped. Now both pools contribute to the candidate set.
    const regionList = [...regions];
    const regionPlaceholders = regionList.map(() => '?').join(',');
    const scopeKeys = this._scopeKeys(scope);
    const scopePlaceholders = scopeKeys.map(() => '?').join(',');

    const seen = new Set();
    const allRows = [];

    if (tokens.length > 0) {
      const tokenPlaceholders = tokens.map(() => '?').join(',');
      const lexicalRows = this.db.prepare(`SELECT c.*, SUM(p.frequency) AS lexical_hits
        FROM memory_chunk_postings p JOIN memory_chunk_index c ON c.id = p.chunk_id
        WHERE p.scope_key IN (${scopePlaceholders}) AND p.token IN (${tokenPlaceholders})
          AND c.scope_key IN (${scopePlaceholders}) AND c.status = 'active' AND c.region IN (${regionPlaceholders})
          AND (c.expires_at IS NULL OR c.expires_at > ?)
        GROUP BY c.id ORDER BY lexical_hits DESC, c.updated_at DESC LIMIT ?`)
        .all(...scopeKeys, ...tokens, ...scopeKeys, ...regionList, nowIso(), this.options.candidateLimit);
      for (const row of lexicalRows) {
        if (!seen.has(row.id)) { seen.add(row.id); allRows.push(row); }
      }
    }

    // Semantic/importance-ranked candidates always supplement lexical results
    // so high-confidence facts with different phrasing are never silently lost.
    const semanticLimit = Math.max(16, Math.floor(this.options.candidateLimit / 2));
    const semanticRows = this.db.prepare(`SELECT * FROM memory_chunk_index
      WHERE scope_key IN (${scopePlaceholders}) AND status = 'active' AND region IN (${regionPlaceholders})
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY importance DESC, confidence DESC, updated_at DESC LIMIT ?`)
      .all(...scopeKeys, ...regionList, nowIso(), semanticLimit);
    for (const row of semanticRows) {
      if (!seen.has(row.id)) { seen.add(row.id); allRows.push(row); }
    }

    return allRows;
  }

  _queryEmbedding(query, options) {
    if (options && options.queryEmbedding) return Array.from(options.queryEmbedding);
    if (this.embeddingProvider && typeof this.embeddingProvider.embedSync === 'function' && this.embeddingProvider.name !== 'hash-offline') {
      try { return Array.from(this.embeddingProvider.embedSync(query)); } catch (_) { return null; }
    }
    return null;
  }

  _freshness(dateValue) {
    const ageDays = Math.max(0, (Date.now() - Date.parse(dateValue || nowIso())) / 86400000);
    return Math.exp(-Math.log(2) * ageDays / 30);
  }

  _score(row, tokens, queryEmbedding, regions) {
    const rowTokens = parseJson(row.metadata, {}).tokens || this.normalizeTokens(row.content);
    const rowTokenSet = new Set(rowTokens);
    const matches = tokens.filter(token => rowTokenSet.has(token)).length;
    const lexical = tokens.length === 0 ? 0 : matches / tokens.length;
    let semantic = 0;
    if (queryEmbedding && row.embedding) semantic = Math.max(0, cosineSimilarity(queryEmbedding, parseJson(row.embedding, [])));
    const regionBoost = regions.has(row.region) ? 0.08 : 0;
    const freshness = this._freshness(row.updated_at);
    const score = (0.48 * lexical) + (0.20 * semantic) + (0.10 * freshness) + (0.10 * clamp(row.importance)) + (0.08 * clamp(row.confidence)) + regionBoost;
    const relevant = (matches >= 1 && (matches >= 2 || lexical >= this.options.minLexical)) || semantic >= this.options.minSemantic;
    return { score: clamp(score, 0, 1), lexical, semantic, freshness, relevant };
  }

  _neighbors(scope, chunkId, regions, maxNeighbors) {
    const rows = this.db.prepare(`SELECT c.*, e.id AS edge_id, e.relation_type AS relation_type, e.weight AS edge_weight,
      CASE WHEN e.source_chunk_id = ? THEN e.target_chunk_id ELSE e.source_chunk_id END AS neighbor_id
      FROM memory_chunk_edges e JOIN memory_chunk_index c ON c.id = CASE WHEN e.source_chunk_id = ? THEN e.target_chunk_id ELSE e.source_chunk_id END
      WHERE e.scope_key = ? AND (e.source_chunk_id = ? OR e.target_chunk_id = ?)
        AND c.scope_key = ? AND c.status = 'active' AND c.region IN (${[...regions].map(() => '?').join(',')})
      ORDER BY e.weight DESC LIMIT ?`)
      .all(chunkId, chunkId, scope.scopeKey, chunkId, chunkId, scope.scopeKey, ...regions, maxNeighbors);
    return rows;
  }

  retrieve(query = '', options = {}) {
    if (!this.initialized) this.initializeSync();
    const started = Date.now();
    const scope = this.normalizeScope(options.scope);
    const maxSelected = Math.max(1, Math.min(64, Number(options.maxSelected || this.options.maxSelected)));
    const maxDepth = Math.max(0, Math.min(5, Number(options.maxDepth == null ? this.options.maxDepth : options.maxDepth)));
    const maxTokens = Math.max(64, Math.min(10000, Number(options.maxTokens || this.options.maxTokens)));
    const regions = new Set((options.regions || [...this.inferRegions(query)]).map(region => canonicalRegion(region, 'day_to_day')));
    const tokens = this.normalizeTokens(query);
    const queryEmbedding = this._queryEmbedding(query, options);
    const candidates = this._candidateRows(scope, tokens, regions);
    const scored = candidates.map(row => ({ row, ...this._score(row, tokens, queryEmbedding, regions), depth: 0, via: null }))
      // Priors (freshness, importance, ...) only rank relevant items; they never make one relevant.
      .filter(item => tokens.length === 0 || (item.relevant && item.score >= this.options.minScore))
      .sort((a, b) => b.score - a.score || String(b.row.updated_at).localeCompare(String(a.row.updated_at)));

    const selected = [];
    const selectedIds = new Set();
    const traces = [];
    const queue = scored.slice(0, Math.min(scored.length, this.options.candidateLimit));
    let tokensUsed = 0;
    const add = (item, depth, via) => {
      if (!item || selected.length >= maxSelected || selectedIds.has(item.row.id)) return false;
      const formatted = `[${item.row.region}/${item.row.provenance}] ${item.row.content}`;
      const cost = this.estimatePromptTokens(formatted);
      if (tokensUsed + cost > maxTokens && selected.length > 0) return false;
      selectedIds.add(item.row.id);
      tokensUsed += cost;
      selected.push({ ...item, depth, via });
      traces.push({ chunkId: item.row.id, depth, via, score: Number(item.score.toFixed(6)), lexical: Number(item.lexical.toFixed(6)), semantic: Number(item.semantic.toFixed(6)) });
      return true;
    };

    for (const seed of queue) add(seed, 0, null);
    let frontier = selected.slice();
    for (let depth = 1; depth <= maxDepth && frontier.length > 0 && selected.length < maxSelected; depth += 1) {
      const next = [];
      for (const parent of frontier) {
        const neighbors = this._neighbors(scope, parent.row.id, regions, this.options.maxNeighbors);
        for (const neighbor of neighbors) {
          if (selectedIds.has(neighbor.neighbor_id)) continue;
          // A neighbour is context for the memory that matched; it must never outrank it.
        const score = Math.min(parent.score * 0.92, clamp(parent.score * 0.78 + Number(neighbor.edge_weight || 0) * 0.22));
          const item = { row: neighbor, score, lexical: 0, semantic: 0, freshness: this._freshness(neighbor.updated_at) };
          if (add(item, depth, { chunkId: parent.row.id, edgeId: neighbor.edge_id, relation: neighbor.relation_type })) next.push(selected[selected.length - 1]);
          if (selected.length >= maxSelected) break;
        }
        if (selected.length >= maxSelected) break;
      }
      frontier = next;
    }

    const fallbackReason = selected.length === 0
      ? (candidates.length === 0 ? 'no_candidates' : 'below_score_threshold')
      : null;
    const items = selected.map(item => ({
      id: item.row.id,
      text: item.row.content,
      summary: item.row.summary,
      region: item.row.region,
      provenance: item.row.provenance,
      confidence: Number(item.row.confidence),
      importance: Number(item.row.importance),
      score: Number(item.score.toFixed(6)),
      lexical: Number(item.lexical.toFixed(6)),
      semantic: Number(item.semantic.toFixed(6)),
      depth: item.depth,
      via: item.via,
      sourceType: item.row.source_type,
      sourceReference: item.row.source_reference,
    }));

    const selectedIdsJson = safeJson(items.map(item => item.id), []);
    const trace = {
      regions: [...regions],
      tokens,
      maxDepth,
      maxSelected,
      maxTokens,
      tokenEstimator: 'char-aware-v1',
      candidateCount: candidates.length,
      semanticEnabled: Boolean(queryEmbedding),
      path: traces,
    };
    this.db.prepare(`INSERT INTO memory_retrieval_events
      (id, scope_key, query, candidate_count, selected_count, selected_ids, trace, token_budget, tokens_used, latency_ms, fallback_reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id('retrieval'), scope.scopeKey, String(query || '').slice(0, 1000), candidates.length, items.length, selectedIdsJson, safeJson(trace), maxTokens, tokensUsed, Date.now() - started, fallbackReason, nowIso());

    if (items.length > 0) {
      const update = this.db.prepare('UPDATE memory_chunk_index SET access_count = access_count + 1, last_accessed_at = ?, updated_at = ? WHERE id = ? AND scope_key = ?');
      const tx = this.db.transaction(() => items.forEach(item => update.run(nowIso(), nowIso(), item.id, scope.scopeKey)));
      tx();
    }

    return {
      items,
      text: items.map(item => `[${item.region}/${item.provenance}] ${item.text}`).join('\n'),
      trace,
      stats: {
        candidateCount: candidates.length,
        selectedCount: items.length,
        tokensUsed,
        maxTokens,
        tokenEstimator: 'char-aware-v1',
        latencyMs: Date.now() - started,
        fallbackReason,
      },
    };
  }

  getContext(query, options = {}) { return this.retrieve(query, options); }

  stats(scopeInput) {
    const scope = this.normalizeScope(scopeInput);
    const count = this.db.prepare('SELECT COUNT(*) AS count FROM memory_chunk_index WHERE scope_key = ? AND status = \'active\'').get(scope.scopeKey).count;
    const edges = this.db.prepare('SELECT COUNT(*) AS count FROM memory_chunk_edges WHERE scope_key = ?').get(scope.scopeKey).count;
    const postings = this.db.prepare('SELECT COUNT(*) AS count FROM memory_chunk_postings WHERE scope_key = ?').get(scope.scopeKey).count;
    const retrievals = this.db.prepare('SELECT COUNT(*) AS count FROM memory_retrieval_events WHERE scope_key = ?').get(scope.scopeKey).count;
    const byRegion = this.db.prepare('SELECT region, COUNT(*) AS count FROM memory_chunk_index WHERE scope_key = ? AND status = \'active\' GROUP BY region').all(scope.scopeKey);
    return { chunks: count, edges, postings, retrievals, byRegion };
  }

  list(scopeInput, options = {}) {
    const scope = this.normalizeScope(scopeInput);
    const limit = Math.max(1, Math.min(200, Number(options.limit || 50)));
    const region = options.region ? canonicalRegion(options.region, 'day_to_day') : null;
    const rows = region
      ? this.db.prepare('SELECT * FROM memory_chunk_index WHERE scope_key = ? AND region = ? ORDER BY updated_at DESC LIMIT ?').all(scope.scopeKey, region, limit)
      : this.db.prepare('SELECT * FROM memory_chunk_index WHERE scope_key = ? ORDER BY updated_at DESC LIMIT ?').all(scope.scopeKey, limit);
    return rows.map(row => ({ ...row, metadata: parseJson(row.metadata, {}), embedding: undefined }));
  }

  inspect(scopeInput, chunkId) {
    const scope = this.normalizeScope(scopeInput);
    const chunk = this.db.prepare('SELECT * FROM memory_chunk_index WHERE id = ? AND scope_key = ?').get(chunkId, scope.scopeKey);
    if (!chunk) return null;
    const edges = this.db.prepare(`SELECT e.*, CASE WHEN e.source_chunk_id = ? THEN e.target_chunk_id ELSE e.source_chunk_id END AS neighbor_id
      FROM memory_chunk_edges e WHERE e.scope_key = ? AND (e.source_chunk_id = ? OR e.target_chunk_id = ?) ORDER BY e.weight DESC`).all(chunkId, scope.scopeKey, chunkId, chunkId);
    return { ...chunk, metadata: parseJson(chunk.metadata, {}), embedding: undefined, edges };
  }

  forget(scopeInput, chunkId) {
    const scope = this.normalizeScope(scopeInput);
    const result = this.db.prepare('UPDATE memory_chunk_index SET status = \'forgotten\', updated_at = ? WHERE id = ? AND scope_key = ?').run(nowIso(), chunkId, scope.scopeKey);
    return { forgotten: result.changes > 0, chunkId };
  }

  reindex(scopeInput) {
    const scope = this.normalizeScope(scopeInput);
    const rows = this.db.prepare('SELECT id, content, metadata FROM memory_chunk_index WHERE scope_key = ? AND status = \'active\'').all(scope.scopeKey);
    const remove = this.db.prepare('DELETE FROM memory_chunk_postings WHERE scope_key = ? AND chunk_id = ?');
    const insert = this.db.prepare('INSERT OR REPLACE INTO memory_chunk_postings (scope_key, token, chunk_id, frequency) VALUES (?, ?, ?, ?)');
    const tx = this.db.transaction(() => {
      for (const row of rows) {
        remove.run(scope.scopeKey, row.id);
        const tokens = parseJson(row.metadata, {}).tokens || this.normalizeTokens(row.content);
        for (const token of tokens) insert.run(scope.scopeKey, token, row.id, 1);
      }
    });
    tx();
    return { reindexed: rows.length };
  }
}

module.exports = SelectiveMemoryEngine;
module.exports.SelectiveMemoryEngine = SelectiveMemoryEngine;
