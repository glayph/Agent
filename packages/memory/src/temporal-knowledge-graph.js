'use strict';

const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs').promises;

class TemporalKnowledgeGraph {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.initialized = false;
  }

  async initialize() {
    if (this.initialized) return;
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this._createSchema();
    this.initialized = true;
    return this;
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
        is_active INTEGER DEFAULT 1
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

  writeEvent(eventData) {
    const chunk = this.getOrCreateCurrentChunk();
    const eventId = this._uuid();
    const now = this._now();

    const importance = typeof eventData.importance === 'number' ? eventData.importance : this._classifyImportance(eventData);
    const isSpecial = importance >= 0.7 ? 1 : 0;
    const specialEventName = isSpecial ? this._generateSpecialEventName(eventData) : null;

    this.db.prepare(`
      INSERT INTO events (id, chunk_id, event_type, content, source, importance, is_special, special_event_name, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, chunk.id, eventData.event_type || 'general', eventData.content || '', eventData.source || 'system', importance, isSpecial, specialEventName, JSON.stringify(eventData.metadata || {}), now);

    this.db.prepare('UPDATE hourly_chunks SET event_count = event_count + 1, updated_at = ? WHERE id = ?').run(now, chunk.id);

    if (isSpecial && specialEventName) {
      this.db.prepare(`
        INSERT INTO special_events_index (id, event_name, chunk_id, importance, summary, entities_involved, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(this._uuid(), specialEventName, chunk.id, importance, eventData.content ? eventData.content.substring(0, 500) : '', JSON.stringify(eventData.entities || []), now);
    }

    const entities = this._extractEntities(eventData);
    for (const entity of entities) {
      this._ensureEntity(entity);
    }
    this._updateWorkingAnchor(eventData);

    return { eventId, chunkId: chunk.id, isSpecial: !!isSpecial, specialEventName };
  }

  _classifyImportance(eventData) {
    let score = 0.0;
    const content = (eventData.content || '').toLowerCase();
    const source = (eventData.source || '').toLowerCase();

    const highPriorityKeywords = ['urgent', 'critical', 'important', 'emergency', 'deadline', 'argument', 'conflict', 'decision', 'milestone', 'breakthrough', 'error', 'failure', 'warning', 'security', 'attack'];
    const emotionalKeywords = ['angry', 'frustrated', 'excited', 'thrilled', 'devastated', 'grateful', 'furious', 'anxious', 'celebrate', 'congratulate', 'apologize'];
    const actionKeywords = ['committed', 'deployed', 'launched', 'signed', 'approved', 'rejected', 'resolved', 'completed', 'started', 'changed'];

    for (const kw of highPriorityKeywords) {
      if (content.includes(kw)) score = Math.max(score, 0.8);
    }
    for (const kw of emotionalKeywords) {
      if (content.includes(kw)) score = Math.max(score, 0.75);
    }
    for (const kw of actionKeywords) {
      if (content.includes(kw)) score = Math.max(score, 0.6);
    }

    if (source === 'tool' && (eventData.event_type === 'tool_call' || eventData.event_type === 'tool_result')) {
      score = Math.max(score, 0.3);
    }

    if (eventData.metadata && eventData.metadata.importance) {
      score = Math.max(score, eventData.metadata.importance);
    }

    return Math.min(1.0, Math.round(score * 100) / 100);
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
    const matches = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b/g);
    if (matches) {
      const seen = new Set(entities.map(e => e.name.toLowerCase()));
      for (const name of matches) {
        if (name.length > 3 && !seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase());
          entities.push({ name, type: 'entity' });
        }
      }
    }
    return entities;
  }

  _ensureEntity(entityData) {
    const now = this._now();
    const id = entityData.name.toLowerCase().replace(/\s+/g, '-').replace(/[^\w-]/g, '');
    const existing = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id);
    if (existing) {
      this.db.prepare('UPDATE entities SET last_seen_at = ?, access_count = access_count + 1, is_active = 1 WHERE id = ?').run(now, id);
      return id;
    }
    this.db.prepare(`
      INSERT INTO entities (id, name, type, attributes, first_seen_at, last_seen_at, access_count, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    `).run(id, entityData.name, entityData.type || 'entity', JSON.stringify(entityData.attributes || {}), now, now);
    return id;
  }

  addEntityRelation(sourceId, targetId, relationType, metadata = {}) {
    const now = this._now();
    const id = this._uuid();
    this.db.prepare(`
      INSERT INTO entity_edges (id, source_id, target_id, relation_type, weight, valid_from, valid_until, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, sourceId, targetId, relationType, metadata.weight || 1.0, metadata.validFrom || now, metadata.validUntil || null, JSON.stringify(metadata), now);
    return id;
  }

  deprecateEntityRelation(edgeId) {
    const now = this._now();
    this.db.prepare('UPDATE entity_edges SET valid_until = ? WHERE id = ?').run(now, edgeId);
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

  writeEmptyChunk(hourKey) {
    const id = this._uuid();
    const now = this._now();
    const existing = this.db.prepare('SELECT * FROM hourly_chunks WHERE hour_key = ?').get(hourKey);
    if (existing) return existing;
    this.db.prepare(`
      INSERT INTO hourly_chunks (id, hour_key, hour_start, hour_end, status, event_count, summary, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'EMPTY', 0, 'No activity recorded', ?, ?)
    `).run(id, hourKey, this._getHourStart(hourKey), this._getHourEnd(hourKey), now, now);
    return this.db.prepare('SELECT * FROM hourly_chunks WHERE id = ?').get(id);
  }

  getHoursInRange(startHourKey, endHourKey) {
    return this.db.prepare(`
      SELECT * FROM hourly_chunks WHERE hour_key >= ? AND hour_key <= ? ORDER BY hour_key ASC
    `).all(startHourKey, endHourKey);
  }

  getMissingHoursInRange(startHourKey, endHourKey) {
    const existing = this.getHoursInRange(startHourKey, endHourKey);
    const existingKeys = new Set(existing.map(c => c.hour_key));
    const missing = [];
    const start = new Date(startHourKey + ':00:00.000Z');
    const end = new Date(endHourKey + ':00:00.000Z');
    const current = new Date(start);
    while (current <= end) {
      const key = this._getHourKey(current);
      if (!existingKeys.has(key)) {
        missing.push(key);
      }
      current.setUTCHours(current.getUTCHours() + 1);
    }
    return missing;
  }

  fillMissingEmptyChunks(startHourKey, endHourKey) {
    const missing = this.getMissingHoursInRange(startHourKey, endHourKey);
    const created = [];
    for (const hourKey of missing) {
      const chunk = this.writeEmptyChunk(hourKey);
      created.push(chunk);
    }
    return created;
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

    const searchTerm = `%${queryStr}%`;
    if (timeRange && timeRange.start && timeRange.end) {
      results.entities = this.db.prepare(`
        SELECT * FROM entities WHERE (name LIKE ? OR attributes LIKE ?) AND last_seen_at >= ? AND first_seen_at <= ?
        ORDER BY access_count DESC LIMIT 50
      `).all(searchTerm, searchTerm, timeRange.start, timeRange.end);
    } else {
      results.entities = this.db.prepare(`
        SELECT * FROM entities WHERE name LIKE ? OR attributes LIKE ? ORDER BY access_count DESC LIMIT 50
      `).all(searchTerm, searchTerm);
    }

    if (timeRange && timeRange.start && timeRange.end) {
      results.events = this.db.prepare(`
        SELECT e.*, h.hour_key FROM events e
        JOIN hourly_chunks h ON e.chunk_id = h.id
        WHERE e.created_at >= ? AND e.created_at <= ?
        ORDER BY e.created_at DESC LIMIT 100
      `).all(timeRange.start, timeRange.end);
    } else {
      results.events = this.db.prepare(`
        SELECT e.*, h.hour_key FROM events e
        JOIN hourly_chunks h ON e.chunk_id = h.id
        WHERE e.content LIKE ?
        ORDER BY e.created_at DESC LIMIT 50
      `).all(searchTerm);
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

  getContextWindow(queryStr, maxEvents = 20) {
    const anchor = this.getWorkingAnchor();
    const specialEvents = this.getSpecialEvents(5, true);
    const recent = this.getRecentEvents(24);

    const now = new Date();
    const hourKey = this._getHourKey(now);
    const currentChunk = this.getHourlyChunk(hourKey);

    let parts = [];
    parts.push('=== à¦†à¦®à¦¿ (Working Memory Anchor) ===');
    parts.push(`Current Time: ${anchor.current_timestamp}`);
    parts.push(`Situation: ${anchor.current_situation || 'No active context'}`);
    if (anchor.key_entities) {
      let entities = [];
      try { entities = JSON.parse(anchor.key_entities); } catch {}
      if (entities.length > 0) {
        parts.push(`Active Entities: ${entities.join(', ')}`);
      }
    }
    parts.push('');

    if (currentChunk && currentChunk.status !== 'EMPTY') {
      parts.push(`=== Current Hourly Chunk: ${currentChunk.hour_key} ===`);
      parts.push(`Events in this hour: ${currentChunk.event_count}`);
      parts.push('');
    }

    if (recent.length > 0) {
      parts.push(`=== Recent Events (Last 24h) ===`);
      for (const ev of recent.slice(0, maxEvents)) {
        const content = (ev.content || '').substring(0, 300);
        parts.push(`[${ev.hour_key}] [${ev.source}] ${content}`);
      }
      parts.push('');
    }

    if (specialEvents.length > 0) {
      parts.push('=== Highlighted Special Events ===');
      for (const se of specialEvents) {
        parts.push(`- ${se.event_name} (importance: ${se.importance})`);
        if (se.summary) parts.push(`  Summary: ${se.summary.substring(0, 200)}`);
      }
      parts.push('');
    }

    if (queryStr) {
      const queryResult = this.queryTemporalGraph(queryStr, { start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), end: new Date().toISOString() });
      if (queryResult.entities.length > 0) {
        parts.push(`=== Relevant Entities ===`);
        for (const ent of queryResult.entities.slice(0, 10)) {
          parts.push(`- ${ent.name} (${ent.type})`);
        }
        parts.push('');
      }
      if (queryResult.events.length > 0) {
        parts.push(`=== Relevant Past Events ===`);
        for (const ev of queryResult.events.slice(0, 10)) {
          parts.push(`[${ev.hour_key}] ${(ev.content || '').substring(0, 200)}`);
        }
        parts.push('');
      }
    }

    return parts.join('\n');
  }

  runConsolidation() {
    const report = { hoursConsolidated: 0, daysSummarized: 0, entitiesArchived: 0, edgesDeprecated: 0 };

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysAgoKey = this._getHourKey(sevenDaysAgo);

    const oldActiveChunks = this.db.prepare(`
      SELECT * FROM hourly_chunks WHERE hour_key <= ? AND status = 'ACTIVE' ORDER BY hour_key ASC
    `).all(sevenDaysAgoKey);

    const dailyGroups = {};
    for (const chunk of oldActiveChunks) {
      const dateKey = chunk.hour_key.substring(0, 10);
      if (!dailyGroups[dateKey]) dailyGroups[dateKey] = [];
      dailyGroups[dateKey].push(chunk);
    }

    for (const [dateKey, chunks] of Object.entries(dailyGroups)) {
      const existingDaily = this.db.prepare('SELECT * FROM daily_summaries WHERE date_key = ?').get(dateKey);
      if (existingDaily) continue;

      const chunkIds = chunks.map(c => c.id);
      const allEvents = [];
      for (const cid of chunkIds) {
        const evts = this.getEventsInChunk(cid);
        allEvents.push(...evts);
      }

      const summary = allEvents.map(e => `[${e.source}] ${(e.content || '').substring(0, 200)}`).join('\n').substring(0, 5000);
      const entityIds = new Set();
      for (const ev of allEvents) {
        const metadata = JSON.parse(ev.metadata || '{}');
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
    }

    const archiveDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const staleEntities = this.db.prepare('SELECT * FROM entities WHERE last_seen_at < ? AND access_count < 3').all(archiveDate);
    for (const ent of staleEntities) {
      this.db.prepare('UPDATE entities SET is_active = 0 WHERE id = ?').run(ent.id);
      report.entitiesArchived++;
    }

    const oldEdges = this.db.prepare('SELECT * FROM entity_edges WHERE valid_until IS NULL AND created_at < ?').all(archiveDate);
    for (const edge of oldEdges) {
      this.db.prepare('UPDATE entity_edges SET valid_until = ? WHERE id = ?').run(archiveDate, edge.id);
      report.edgesDeprecated++;
    }

    return report;
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

    const anchor = this.getWorkingAnchor();

    return {
      chunks: chunkStats,
      entities: { total: entityCount, active: activeEntityCount },
      edges: edgeCount,
      events: eventCount,
      specialEvents: { total: specialCount, unresolved: unresolvedSpecialCount },
      dailySummaries: dailyCount,
      workingAnchor: { situation: (anchor.current_situation || '').substring(0, 100), entityCount: anchor.key_entities ? JSON.parse(anchor.key_entities).length : 0 },
      timestamp: this._now()
    };
  }

  close() {
    if (this.db) {
      this.db.close();
      this.initialized = false;
    }
  }
}

module.exports = TemporalKnowledgeGraph;
