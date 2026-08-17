'use strict';

/**
 * End-to-end integration tests for Phase 1 (memory ↔ agent connection).
 *
 * Covers:
 *   (a) logInteraction()  — runAgentLoop memory-write hook
 *   (b) logToolCall()     — shell / file tool-call memory logging
 *   (d) _detectSelfLabel / _formatAnchor — dynamic anchor prefix
 *   (e) getConnectedDailySummaries() injected into getContextWindow()
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs').promises;
const TemporalKnowledgeGraph = require('../temporal-knowledge-graph');
const AgentMemoryIntegration = require('../agent-memory-integration');

const TEST_DB = path.join(__dirname, '..', '..', 'data_test', 'integration-phase1.db');

// ── helpers ───────────────────────────────────────────────────────────────────

async function cleanTestDb() {
  for (const suffix of ['', '-wal', '-shm']) {
    try { await fs.unlink(TEST_DB + suffix); } catch {}
  }
}

async function freshTkg() {
  await cleanTestDb();
  const tkg = new TemporalKnowledgeGraph(TEST_DB);
  await tkg.initialize();
  return tkg;
}

/** Force-write the working anchor's current_situation to a known value. */
function setAnchorSituation(tkg, situation) {
  const now = new Date().toISOString();
  tkg.db.prepare(`
    INSERT OR REPLACE INTO working_anchor
      (id, current_timestamp, current_situation, key_entities, active_context, updated_at)
    VALUES ('current', ?, ?, '[]', '', ?)
  `).run(now, situation, now);
}

/** Insert a daily_summary + edge from today → pastKey with given weight. */
function insertDailyEdge(tkg, pastKey, weight, summaryText) {
  const todayKey = tkg._getDateKey(new Date());
  const sid = tkg._uuid();
  tkg.db.prepare(`
    INSERT INTO daily_summaries (id, date_key, summary, graph_snapshot, chunk_ids, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sid, pastKey, summaryText, '{}', '[]', new Date().toISOString());

  tkg.db.prepare(`
    INSERT INTO daily_summary_edges (id, source_date_key, target_date_key, weight, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(tkg._uuid(), todayKey, pastKey, weight, new Date().toISOString(), new Date().toISOString());
}

// ── test runner ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('\n🧪 Phase 1 End-to-End Integration Tests\n');
  let failures = 0;
  const startTime = Date.now();

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
    } catch (err) {
      console.error(`❌ [FAIL] ${name}`);
      console.error(`  ${err.message}`);
      failures++;
    }
  };

  // ══════════════════════════════════════════════════════════════════════════
  // (a) runAgentLoop memory-write hook — logInteraction
  // ══════════════════════════════════════════════════════════════════════════

  await test('(a) logInteraction: writes user + agent events to DB', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);

    const result = mem.logInteraction(
      'আমার প্রজেক্টের status কী?',
      'প্রজেক্ট Q3 delivery-এর জন্য on track আছে।',
      { sessionId: 'sess-001' }
    );

    assert(result.userEvent, 'userEvent should be returned');
    assert(result.agentEvent, 'agentEvent should be returned');
    assert(result.userEvent.eventId.length > 0, 'userEvent should have a non-empty ID');
    assert(result.agentEvent.eventId.length > 0, 'agentEvent should have a non-empty ID');

    const events = tkg.db.prepare('SELECT source FROM events ORDER BY created_at ASC').all();
    const sources = events.map(e => e.source);
    assert(sources.includes('user'), 'user event should be in DB');
    assert(sources.includes('agent'), 'agent event should be in DB');

    tkg.close();
  });

  await test('(a) logInteraction: empty agentResponse is safe (no crash)', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);

    const result = mem.logInteraction('ping', '', { sessionId: 'sess-noop' });
    assert(result.userEvent, 'userEvent should still be returned');
    assert(result.agentEvent, 'agentEvent should still be returned');

    tkg.close();
  });

  await test('(a) logInteraction: multi-turn conversation accumulates events', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);

    const turns = [
      ['Hello', 'Hi! How can I help?'],
      ['What time is it?', 'It is currently 3:00 PM.'],
      ['Thank you', 'You are welcome!'],
    ];
    for (const [user, agent] of turns) {
      mem.logInteraction(user, agent, { sessionId: 'sess-multi' });
    }

    const count = tkg.db.prepare('SELECT COUNT(*) as c FROM events').get().c;
    // 3 turns × 2 events (user + agent) = 6
    assert(count >= 6, `Expected >=6 events, got ${count}`);

    tkg.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // (b) tool-call memory logging — logToolCall
  // ══════════════════════════════════════════════════════════════════════════

  await test('(b) logToolCall: shell_execute success is written to DB', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);

    const ev = mem.logToolCall(
      'shell_execute',
      { command: 'ls -la /tmp', cwd: '/tmp' },
      { exitCode: 0, status: 'success', error: undefined }
    );

    assert(ev.eventId.length > 0, 'tool event should have an ID');
    const row = tkg.db.prepare('SELECT * FROM events WHERE id = ?').get(ev.eventId);
    assert(row, 'event should be persisted');
    assert(row.source === 'tool', `Expected source=tool, got ${row.source}`);
    assert(row.event_type === 'tool_call', `Expected tool_call, got ${row.event_type}`);
    assert(row.content.includes('shell_execute'), 'content should include tool name');

    tkg.close();
  });

  await test('(b) logToolCall: file_write success is written to DB', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);

    const ev = mem.logToolCall(
      'file_write',
      { path: '/tmp/test.txt' },
      { outcome: 'success', detail: undefined }
    );

    assert(ev.eventId.length > 0, 'file_write event should have an ID');
    const row = tkg.db.prepare('SELECT * FROM events WHERE id = ?').get(ev.eventId);
    assert(row.content.includes('file_write'), 'content should include tool name');
    assert(row.source === 'tool');

    tkg.close();
  });

  await test('(b) logToolCall: file_read denied is written to DB', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);

    const ev = mem.logToolCall(
      'file_read',
      { path: '/etc/shadow' },
      { outcome: 'denied', detail: 'file_read is disabled by config/tools.yaml.' }
    );

    assert(ev.eventId.length > 0);
    const row = tkg.db.prepare('SELECT * FROM events WHERE id = ?').get(ev.eventId);
    assert(row.content.includes('file_read'));

    tkg.close();
  });

  await test('(b) logToolCall: shell timeout exitCode -2 stored in tool event content', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);

    const ev = mem.logToolCall(
      'shell_execute',
      { command: 'sleep 999', cwd: '/tmp' },
      // logToolCall serialises result via String(result), so we pass a string
      // that clearly contains the exit code to assert on
      'exitCode: -2, status: failed, error: Timeout after 300 seconds.'
    );

    const row = tkg.db.prepare('SELECT content FROM events WHERE id = ?').get(ev.eventId);
    assert(row.content.includes('shell_execute'), 'content should include tool name');
    assert(
      row.content.includes('-2') || row.content.includes('Timeout'),
      `Expected timeout info in content, got: ${row.content.substring(0, 200)}`
    );

    tkg.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // (d) _detectSelfLabel / _formatAnchor — dynamic anchor prefix
  // ══════════════════════════════════════════════════════════════════════════

  await test('(d) _detectSelfLabel: Bengali text → আমি', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);
    const label = mem._detectSelfLabel('আমার কাজ চলছে');
    assert(label === '\u0986\u09ae\u09bf', `Expected আমি, got "${label}"`);
    tkg.close();
  });

  await test('(d) _detectSelfLabel: English text → I', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);
    const label = mem._detectSelfLabel('Working on a TypeScript project');
    assert(label === 'I', `Expected I, got "${label}"`);
    tkg.close();
  });

  await test('(d) _detectSelfLabel: Arabic text → أنا', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);
    const label = mem._detectSelfLabel('أنا أعمل على مشروع');
    assert(label === '\u0623\u0646\u0627', `Expected أنا, got "${label}"`);
    tkg.close();
  });

  await test('(d) _detectSelfLabel: empty string → আমি (default)', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);
    const label = mem._detectSelfLabel('');
    assert(label === '\u0986\u09ae\u09bf', `Expected আমি (default), got "${label}"`);
    tkg.close();
  });

  await test('(d) _formatAnchor: English situation → "I [" prefix', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);

    setAnchorSituation(tkg, 'Working on a Node.js integration test');
    const anchor = tkg.getWorkingAnchor();
    const formatted = mem._formatAnchor(anchor);

    assert(
      formatted.startsWith('I ['),
      `Expected anchor to start with "I [", got: "${formatted.substring(0, 40)}"`
    );
    assert(formatted.includes('Working on a Node.js integration test'), 'Should include situation text');

    tkg.close();
  });

  await test('(d) _formatAnchor: Bengali situation → আমি prefix', async () => {
    const tkg = await freshTkg();
    const mem = new AgentMemoryIntegration(tkg);

    setAnchorSituation(tkg, 'বাংলা প্রসঙ্গে কাজ হচ্ছে');
    const anchor = tkg.getWorkingAnchor();
    const formatted = mem._formatAnchor(anchor);

    assert(
      formatted.startsWith('\u0986\u09ae\u09bf ['),
      `Expected আমি prefix, got: "${formatted.substring(0, 40)}"`
    );

    tkg.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // (e) getConnectedDailySummaries() injected into getContextWindow()
  // ══════════════════════════════════════════════════════════════════════════

  await test('(e) getContextWindow: includes Related Past Days section when edges exist', async () => {
    const tkg = await freshTkg();

    insertDailyEdge(tkg, '2025-01-15', 0.85, 'Worked on memory consolidation and Phase 3 implementation.');

    const ctx = tkg.getContextWindow('memory integration');

    assert(ctx.includes('Related Past Days'), `Expected "Related Past Days" section`);
    assert(ctx.includes('2025-01-15'), `Expected past date key in context`);
    assert(ctx.includes('0.85'), `Expected edge weight 0.85 in context`);
    assert(ctx.includes('Phase 3'), `Expected summary snippet in context`);

    tkg.close();
  });

  await test('(e) getContextWindow: no crash when no edges exist (empty state)', async () => {
    const tkg = await freshTkg();

    let ctx;
    try {
      ctx = tkg.getContextWindow('anything');
    } catch (err) {
      throw new Error(`getContextWindow threw on empty DB: ${err.message}`);
    }

    assert(typeof ctx === 'string', 'Should return a string even with no edges');
    assert(!ctx.includes('Related Past Days'), 'Should not show section with no edges');

    tkg.close();
  });

  await test('(e) getConnectedDailySummaries: weight ordering is respected', async () => {
    const tkg = await freshTkg();

    insertDailyEdge(tkg, '2025-01-10', 0.9, 'High relevance day');
    insertDailyEdge(tkg, '2025-01-05', 0.4, 'Low relevance day');

    const todayKey = tkg._getDateKey(new Date());
    const connected = tkg.getConnectedDailySummaries(todayKey, 10);

    assert(connected.length === 2, `Expected 2 connected days, got ${connected.length}`);
    assert(
      connected[0].weight > connected[1].weight,
      `Expected weight-descending order: ${connected[0].weight} > ${connected[1].weight}`
    );

    tkg.close();
  });

  await test('(e) getContextWindow: multiple edges — all appear in output', async () => {
    const tkg = await freshTkg();

    insertDailyEdge(tkg, '2025-03-10', 0.88, 'Phase 4 inter-day neural connection work');
    insertDailyEdge(tkg, '2025-03-05', 0.72, 'Phase 2 empty chunk bug fix session');

    const ctx = tkg.getContextWindow('phase');

    assert(ctx.includes('2025-03-10'), 'First connected day should appear');
    assert(ctx.includes('2025-03-05'), 'Second connected day should appear');

    tkg.close();
  });

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const status = failures === 0 ? '✅ ALL PASSED' : `❌ ${failures} FAILED`;
  console.log(`\n🏁 Phase 1 Integration — ${status} (${elapsed}s)\n`);

  await cleanTestDb().catch(() => {});
  if (failures > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('[CRITICAL] Unhandled test exception:', err);
  process.exit(1);
});
