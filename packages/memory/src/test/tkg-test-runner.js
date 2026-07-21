'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const TemporalKnowledgeGraph = require('../temporal-knowledge-graph');
const WorkingMemoryAnchor = require('../working-memory-anchor');
const SpecialEventHighlighter = require('../special-event-highlighter');
const MemoryConsolidationDaemon = require('../memory-consolidation-daemon');
const AgentMemoryIntegration = require('../agent-memory-integration');

const TEST_DB = path.join(__dirname, '..', '..', 'data_test', 'test-tkg.db');

async function cleanTestDb() {
  try { await fs.unlink(TEST_DB); } catch {}
  try { await fs.unlink(TEST_DB + '-wal'); } catch {}
  try { await fs.unlink(TEST_DB + '-shm'); } catch {}
}

async function runTests() {
  console.log('\u{1F9EA} Starting Temporal Knowledge Graph Integration Tests...\n');
  let failures = 0;
  const startTime = Date.now();

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`\u2705 [PASS] ${name}`);
    } catch (err) {
      console.error(`\u274C [FAIL] ${name}`);
      console.error(`  ${err.message}`);
      failures++;
    }
  };

  // ═══════════════════════════════════════
  // TKG: INITIALIZATION
  // ═══════════════════════════════════════
  await test('TKG: Initialize SQLite database with schema', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();
    assert(tkg.initialized === true);
    assert(tkg.db !== null);

    const tables = tkg.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
    const tableNames = tables.map(t => t.name);
    assert(tableNames.includes('hourly_chunks'), 'hourly_chunks table missing');
    assert(tableNames.includes('events'), 'events table missing');
    assert(tableNames.includes('entities'), 'entities table missing');
    assert(tableNames.includes('entity_edges'), 'entity_edges table missing');
    assert(tableNames.includes('working_anchor'), 'working_anchor table missing');
    assert(tableNames.includes('daily_summaries'), 'daily_summaries table missing');
    assert(tableNames.includes('special_events_index'), 'special_events_index table missing');

    tkg.close();
  });

  // ═══════════════════════════════════════
  // TKG: HOURLY CHUNKS
  // ═══════════════════════════════════════
  await test('TKG: Create and retrieve current hourly chunk', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    const chunk = tkg.getOrCreateCurrentChunk();
    assert(chunk !== null, 'Chunk should exist');
    assert(chunk.status === 'ACTIVE', `Expected ACTIVE got ${chunk.status}`);
    assert(chunk.hour_key.length > 0, 'hour_key should be set');
    assert(chunk.event_count === 0, 'New chunk should have 0 events');

    const sameChunk = tkg.getOrCreateCurrentChunk();
    assert(sameChunk.id === chunk.id, 'Re-getting should return same chunk');

    tkg.close();
  });

  await test('TKG: Empty chunk creation and tracking', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    const emptyHourKey = '2026-01-01T03';
    const empty = tkg.writeEmptyChunk(emptyHourKey);
    assert(empty.status === 'EMPTY', `Expected EMPTY got ${empty.status}`);
    assert(empty.event_count === 0);
    assert(empty.summary === 'No activity recorded');

    const duplicateEmpty = tkg.writeEmptyChunk(emptyHourKey);
    assert(duplicateEmpty.id === empty.id, 'Should not create duplicate empty chunk');

    tkg.close();
  });

  await test('TKG: Fill missing empty chunks in time range', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    tkg.writeEvent({ content: 'Test event', source: 'test', event_type: 'test' });

    const created = tkg.fillMissingEmptyChunks('2026-01-01T00', '2026-01-01T05');
    assert(created.length >= 5, `Expected >=5 empty chunks, got ${created.length}`);

    const hoursInRange = tkg.getHoursInRange('2026-01-01T00', '2026-01-01T05');
    const currentHourKey = tkg._getHourKey();
    const nonEmptyCount = hoursInRange.filter(c => c.hour_key === currentHourKey).length;

    const emptyCount = hoursInRange.filter(c => c.status === 'EMPTY').length;
    assert(emptyCount >= 4, `Expected >=4 empty chunks, got ${emptyCount}`);

    tkg.close();
  });

  // ═══════════════════════════════════════
  // TKG: EVENTS
  // ═══════════════════════════════════════
  await test('TKG: Write events and track in hourly chunk', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    const result1 = tkg.writeEvent({ content: 'User asked about weather', source: 'user', event_type: 'message' });
    assert(result1.eventId.length > 0);
    assert(result1.isSpecial === false);

    const result2 = tkg.writeEvent({ content: 'URGENT: System security breach detected', source: 'system', event_type: 'alert' });
    assert(result2.isSpecial === true, 'Urgent event should be flagged as special');
    assert(result2.specialEventName.startsWith('HighlightSpecialEvent_'), 'Should generate special event name');

    const chunk = tkg.getOrCreateCurrentChunk();
    assert(chunk.event_count >= 2, `Expected >=2 events, got ${chunk.event_count}`);

    const events = tkg.getEventsInChunk(chunk.id);
    assert(events.length >= 2);

    tkg.close();
  });

  await test('TKG: Recent events retrieval', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    tkg.writeEvent({ content: 'Event 1', source: 'user', event_type: 'message' });
    tkg.writeEvent({ content: 'Event 2', source: 'agent', event_type: 'message' });

    const recent = tkg.getRecentEvents(24);
    assert(recent.length >= 2, `Expected >=2 recent events, got ${recent.length}`);

    tkg.close();
  });

  // ═══════════════════════════════════════
  // TKG: ENTITIES & RELATIONS
  // ═══════════════════════════════════════
  await test('TKG: Entity extraction and creation', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    tkg.writeEvent({
      content: 'Rahim went to Mama House and met Sara',
      source: 'user',
      event_type: 'message',
      entities: [{ name: 'Rahim', type: 'person' }, { name: 'Mama House', type: 'place' }, { name: 'Sara', type: 'person' }]
    });

    const entities = tkg.db.prepare('SELECT * FROM entities').all();
    assert(entities.length >= 3, `Expected >=3 entities, got ${entities.length}`);
    const rahim = entities.find(e => e.name === 'Rahim');
    assert(rahim !== null, 'Rahim entity should exist');
    assert(rahim.is_active === 1);

    tkg.writeEvent({
      content: 'Rahim is returning tomorrow',
      source: 'user',
      event_type: 'message',
      entities: [{ name: 'Rahim', type: 'person' }]
    });

    const rahimUpdated = tkg.db.prepare('SELECT * FROM entities WHERE name = ?').get('Rahim');
    assert(rahimUpdated.access_count >= 2, `Expected >=2 access_count, got ${rahimUpdated.access_count}`);

    tkg.close();
  });

  await test('TKG: Entity relationships with temporal metadata', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    tkg._ensureEntity({ name: 'Rahim', type: 'person' });
    tkg._ensureEntity({ name: 'Mama House', type: 'place' });

    const rahimId = 'rahim';
    const mamaId = 'mama-house';

    const edgeId = tkg.addEntityRelation(rahimId, mamaId, 'went_to', {
      weight: 0.9,
      validFrom: new Date().toISOString()
    });
    assert(edgeId.length > 0);

    const edges = tkg.db.prepare('SELECT * FROM entity_edges').all();
    assert(edges.length === 1);
    assert(edges[0].relation_type === 'went_to');
    assert(edges[0].source_id === 'rahim');

    tkg.deprecateEntityRelation(edgeId);
    const deprecatedEdge = tkg.db.prepare('SELECT * FROM entity_edges WHERE id = ?').get(edgeId);
    assert(deprecatedEdge.valid_until !== null, 'Deprecated edge should have valid_until set');

    tkg.close();
  });

  // ═══════════════════════════════════════
  // TKG: WORKING ANCHOR
  // ═══════════════════════════════════════
  await test('TKG: Working memory anchor CRUD', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    const anchor = tkg.getWorkingAnchor();
    assert(anchor.id === 'current', 'Anchor id should be current');

    const updated = tkg.getOrSetWorkingAnchor({
      situation: 'Debugging login issue',
      entities: ['AuthModule', 'UserSession'],
      context: 'Working on authentication flow'
    });

    assert(updated.current_situation.includes('Debugging'), `Expected situation match, got ${updated.current_situation}`);

    let keyEntities = [];
    try { keyEntities = JSON.parse(updated.key_entities); } catch {}
    assert(keyEntities.length >= 2, `Expected >=2 entities, got ${keyEntities.length}`);

    const queriedAnchor = tkg.getWorkingAnchor();
    assert(queriedAnchor.current_situation === updated.current_situation);

    tkg.close();
  });

  await test('TKG: Auto-update anchor on event write', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    tkg.writeEvent({
      content: 'Working on fixing the database connection pool',
      source: 'user',
      event_type: 'message'
    });

    const anchor = tkg.getWorkingAnchor();
    assert(anchor.current_situation.length > 0, 'Situation should be auto-populated');

    tkg.close();
  });

  // ═══════════════════════════════════════
  // TKG: SPECIAL EVENTS
  // ═══════════════════════════════════════
  await test('TKG: Special event classification and retrieval', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    tkg.writeEvent({ content: 'Normal conversation about the weather', source: 'user', event_type: 'message' });
    tkg.writeEvent({ content: 'URGENT: Critical production issue needs immediate attention', source: 'user', event_type: 'message' });
    tkg.writeEvent({ content: 'The team is excited about the breakthrough in quantum optimization', source: 'user', event_type: 'message' });
    tkg.writeEvent({ content: 'Approved the new architecture proposal for Q3', source: 'agent', event_type: 'decision' });

    const specials = tkg.getSpecialEvents(10, false);
    const unresolved = tkg.getSpecialEvents(10, true);

    assert(specials.length >= 2, `Expected >=2 special events, got ${specials.length}`);

    if (unresolved.length > 0) {
      tkg.resolveSpecialEvent(unresolved[0].id);
      const afterResolve = tkg.getSpecialEvents(10, true);
      assert(afterResolve.length < unresolved.length, 'Resolving should reduce unresolved count');
    }

    tkg.close();
  });

  // ═══════════════════════════════════════
  // TKG: CONTEXT WINDOW
  // ═══════════════════════════════════════
  await test('TKG: Context window assembly', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    tkg.writeEvent({ content: 'User asked about the project timeline', source: 'user', event_type: 'message' });
    tkg.writeEvent({ content: 'Rahim is working on the frontend module', source: 'user', event_type: 'message', entities: [{ name: 'Rahim', type: 'person' }] });

    tkg.getOrSetWorkingAnchor({
      situation: 'Software development project',
      entities: ['Rahim', 'Frontend'],
      context: 'Active sprint'
    });

    const context = tkg.getContextWindow('Rahim timeline');
    assert(context.includes('Rahim'), 'Context should contain queried entity');
    assert(context.includes('Working Memory Anchor'), 'Context should include anchor header');
    assert(context.length > 100, 'Context should be substantial');

    tkg.close();
  });

  // ═══════════════════════════════════════
  // TKG: CONSOLIDATION
  // ═══════════════════════════════════════
  await test('TKG: Memory consolidation (hourly -> daily)', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    const oldHour = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const oldHourKey = tkg._getHourKey(oldHour);

    const chunk = tkg.getOrCreateCurrentChunk();
    tkg.db.prepare('UPDATE hourly_chunks SET hour_key = ?, hour_start = ?, hour_end = ?, created_at = ?, updated_at = ? WHERE id = ?')
      .run(oldHourKey, tkg._getHourStart(oldHourKey), tkg._getHourEnd(oldHourKey), oldHour.toISOString(), oldHour.toISOString(), chunk.id);

    for (let i = 0; i < 3; i++) {
      tkg.writeEvent({ content: `Historical event ${i}`, source: 'test', event_type: 'test' });
    }

    const report = tkg.runConsolidation();
    assert(report.hoursConsolidated >= 1, `Expected >=1 hour consolidated, got ${report.hoursConsolidated}`);
    assert(report.daysSummarized >= 1, `Expected >=1 day summarized, got ${report.daysSummarized}`);

    const consolidated = tkg.db.prepare('SELECT * FROM hourly_chunks WHERE id = ?').get(chunk.id);
    assert(consolidated.status === 'CONSOLIDATED',
      `Expected CONSOLIDATED status, got ${consolidated.status}`);
    assert(consolidated.consolidated_into !== null,
      'Consolidated chunk should reference daily summary');

    const dailyCount = tkg.db.prepare('SELECT COUNT(*) as count FROM daily_summaries').get().count;
    assert(dailyCount >= 1, `Expected >=1 daily summary, got ${dailyCount}`);

    tkg.close();
  });

  // ═══════════════════════════════════════
  // TKG: QUERY
  // ═══════════════════════════════════════
  await test('TKG: Temporal graph query with time range', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    tkg.writeEvent({ content: 'Discussed machine learning models', source: 'user', event_type: 'message' });
    tkg.writeEvent({ content: 'Python dependency issue with numpy', source: 'user', event_type: 'message' });
    tkg._ensureEntity({ name: 'Python', type: 'technology' });

    const results = tkg.queryTemporalGraph('Python', {
      start: new Date(Date.now() - 3600000).toISOString(),
      end: new Date().toISOString()
    });

    assert(results.entities.length >= 1 || results.events.length >= 1, 'Should find Python-related content');
    assert(Array.isArray(results.events));
    assert(Array.isArray(results.edges));

    tkg.close();
  });

  // ═══════════════════════════════════════
  // WORKING MEMORY ANCHOR
  // ═══════════════════════════════════════
  await test('WorkingMemoryAnchor: Format anchor string with Bengali script', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();
    const anchor = new WorkingMemoryAnchor(tkg);

    anchor.updateSituation('Testing anchor system', ['EntityA', 'EntityB'], 'Test context');
    const formatted = anchor.formatAnchorString();
    assert(formatted.includes('\u0986\u09ae\u09bf'), 'Should contain Bengali script');
    assert(formatted.includes('EntityA'), 'Should contain entity names');
    assert(formatted.includes('Testing anchor system'), 'Should contain situation');

    anchor.removeActiveEntity('EntityA');
    const updated = anchor.getAnchor();
    let entities = [];
    try { entities = JSON.parse(updated.key_entities); } catch {}
    assert(!entities.includes('EntityA'), 'Removed entity should not be present');

    anchor.clearContext();
    const cleared = anchor.getAnchor();
    assert(cleared.current_situation === '', 'Situation should be empty after clear');

    tkg.close();
  });

  // ═══════════════════════════════════════
  // SPECIAL EVENT HIGHLIGHTER
  // ═══════════════════════════════════════
  await test('SpecialEventHighlighter: Importance classification', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();
    const highlighter = new SpecialEventHighlighter(tkg);

    const criticalResult = highlighter.classify('URGENT: Security breach in production', 'system', 'alert');
    assert(criticalResult.importance >= 0.8, `Expected >=0.8 importance, got ${criticalResult.importance}`);
    assert(criticalResult.isSpecial === true);

    const normalResult = highlighter.classify('The weather is nice today', 'user', 'message');
    assert(normalResult.importance < 0.7, `Expected <0.7 importance, got ${normalResult.importance}`);

    const decisionResult = highlighter.classify('The committee approved the new budget allocation', 'agent', 'decision');
    assert(decisionResult.importance >= 0.7, `Decision events should be >=0.7, got ${decisionResult.importance}`);

    tkg.close();
  });

  // ═══════════════════════════════════════
  // AGENT MEMORY INTEGRATION
  // ═══════════════════════════════════════
  await test('AgentMemoryIntegration: Pre/post execution hooks', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();
    const integration = new AgentMemoryIntegration(tkg);

    const preHook = integration.preExecutionHook('What is the project status?');
    assert(preHook.contextWindow.length > 0, 'Pre-hook should provide context');
    assert(preHook.anchor !== null, 'Pre-hook should include anchor');

    const postHook = integration.postExecutionHook('The project is on track for Q3 delivery', 'What is the project status?', { sessionId: 'test-123' });
    assert(postHook.eventId.length > 0, 'Post-hook should return event ID');

    const logResult = integration.logInteraction('Hello', 'Hi there!', { sessionId: 'test-456' });
    assert(logResult.userEvent !== null, 'User event should be logged');
    assert(logResult.agentEvent !== null, 'Agent event should be logged');

    const toolResult = integration.logToolCall('search_web', { query: 'test' }, 'search results here');
    assert(toolResult.eventId.length > 0, 'Tool call should be logged');

    const systemResult = integration.logSystemEvent('startup', 'System initialized');
    assert(systemResult.eventId.length > 0, 'System event should be logged');

    const enhancedPrompt = integration.getEnhancedSystemPrompt('What is the project status?');
    assert(enhancedPrompt.includes('MEMORY CONTEXT'), 'Enhanced prompt should include MEMORY CONTEXT header');

    tkg.close();
  });

  // ═══════════════════════════════════════
  // MEMORY CONSOLIDATION DAEMON
  // ═══════════════════════════════════════
  await test('MemoryConsolidationDaemon: Run-once operation', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();
    const daemon = new MemoryConsolidationDaemon(tkg, {
      checkIntervalMs: 60000,
      fillEmptyChunksIntervalMs: 60000,
      consolidationIntervalMs: 60000,
      maxEmptyChunkLookbackHours: 6
    });

    const result = await daemon.runOnce();
    assert(result !== null);
    assert(typeof result.emptyChunksFilled === 'number');
    assert(result.consolidation !== null);

    tkg.close();
  });

  // ═══════════════════════════════════════
  // TKG: STATS
  // ═══════════════════════════════════════
  await test('TKG: System statistics', async () => {
    await cleanTestDb();
    const tkg = new TemporalKnowledgeGraph(TEST_DB);
    await tkg.initialize();

    tkg.writeEvent({ content: 'Test event 1', source: 'user', event_type: 'message' });
    tkg.writeEvent({ content: 'URGENT: Critical alert!', source: 'system', event_type: 'alert' });
    tkg._ensureEntity({ name: 'TestEntity', type: 'concept' });

    const stats = tkg.getStats();
    assert(stats.entities.total >= 1, `Expected >=1 entity, got ${stats.entities.total}`);
    assert(stats.events >= 2, `Expected >=2 events, got ${stats.events}`);
    assert(stats.specialEvents.total >= 1, `Expected >=1 special event, got ${stats.specialEvents.total}`);
    assert(stats.timestamp !== undefined, 'Should have timestamp');

    tkg.close();
  });

  // ═══════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n\u{1F3C1} Test Run Summary: ${failures === 0 ? 'ALL PASSED!' : `${failures} FAILED`} (${elapsed}s)`);

  await cleanTestDb().catch(() => {});
  if (failures > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('[CRITICAL] Unhandled test exception:', err);
  process.exit(1);
});
