'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const SelectiveMemoryEngine = require('../selective-memory-engine');
const { canonicalRegion, CANONICAL_REGIONS } = require('../regions');

function makeEngine() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-selective-'));
  const db = new Database(path.join(dir, 'memory.db'));
  const engine = new SelectiveMemoryEngine(db, {
    candidateLimit: 32,
    maxSelected: 8,
    maxDepth: 2,
    maxTokens: 80,
  });
  engine.initializeSync();
  return { engine, db, dir };
}

function scope(ownerId = 'owner-a') {
  return { agentId: 'miki', ownerId, workspaceId: 'workspace-1' };
}

function test(name, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
  } catch (error) {
    console.error(`❌ [FAIL] ${name}`);
    throw error;
  }
}

const { engine, db, dir } = makeEngine();

try {
  test('canonical regions normalize legacy daily and aliases', () => {
    assert.deepStrictEqual(CANONICAL_REGIONS, ['long_term', 'day_to_day', 'static', 'skill', 'rule_emotion']);
    assert.strictEqual(canonicalRegion('daily'), 'day_to_day');
    assert.strictEqual(canonicalRegion('scheduling'), 'day_to_day');
    assert.strictEqual(canonicalRegion('behaviour'), 'rule_emotion');
  });

  test('ingestion creates scoped chunk and inverted postings', () => {
    const result = engine.ingest({
      scope: scope(),
      region: 'daily',
      content: 'Tomorrow schedule: review the Agent Miki memory design.',
      sourceType: 'user',
      sourceReference: 'message-1',
      provenance: 'user_stated',
      confidence: 0.95,
      importance: 0.8,
    });
    assert.strictEqual(result.stored, true);
    assert.strictEqual(result.region, 'day_to_day');
    const stats = engine.stats(scope());
    assert.strictEqual(stats.chunks, 1);
    assert.ok(stats.postings >= 4);
    assert.deepStrictEqual(stats.byRegion, [{ region: 'day_to_day', count: 1 }]);
  });

  test('duplicate ingestion is idempotent', () => {
    const first = engine.ingest({ scope: scope(), region: 'long_term', content: 'User prefers concise Bengali replies.' });
    const second = engine.ingest({ scope: scope(), region: 'long_term', content: 'User prefers concise Bengali replies.' });
    assert.strictEqual(first.stored, true);
    assert.strictEqual(second.duplicate, true);
    assert.strictEqual(engine.stats(scope()).chunks, 2);
  });

  test('retrieval selects exact lexical matches and records trace', () => {
    engine.ingest({ scope: scope(), region: 'skill', content: 'The memory indexing workflow uses token postings and bounded retrieval.' });
    engine.ingest({ scope: scope(), region: 'rule_emotion', content: 'Always explain uncertainty when a memory fact conflicts.' });
    const result = engine.retrieve('memory indexing workflow', { scope: scope(), maxSelected: 3, maxTokens: 40 });
    assert.ok(result.items.length >= 1);
    assert.ok(result.items[0].text.includes('memory indexing workflow'));
    assert.strictEqual(result.trace.maxDepth, 2);
    assert.ok(result.stats.tokensUsed <= 40);
    const event = db.prepare('SELECT selected_count, tokens_used, trace FROM memory_retrieval_events ORDER BY created_at DESC LIMIT 1').get();
    assert.strictEqual(event.selected_count, result.items.length);
    assert.ok(JSON.parse(event.trace).candidateCount >= 1);
  });

  test('graph traversal returns a related chunk only within the configured scope', () => {
    const source = engine.ingest({ scope: scope(), region: 'long_term', content: 'Agent Miki uses a durable SQLite memory database.' });
    const related = engine.ingest({ scope: scope(), region: 'static', content: 'The storage layer remains persistent across restarts.' });
    engine.connect(scope(), source.chunkId, related.chunkId, 'supports', { weight: 0.9 });
    const result = engine.retrieve('Agent Miki', { scope: scope(), regions: ['long_term', 'static'], maxDepth: 1, maxSelected: 5 });
    assert.ok(result.items.some(item => item.id === related.chunkId));
    assert.ok(result.items.find(item => item.id === related.chunkId).depth >= 1);

    const other = engine.ingest({ scope: scope('owner-b'), region: 'long_term', content: 'Agent Miki uses a private other-owner memory.' });
    const isolated = engine.retrieve('private other-owner memory', { scope: scope('owner-a') });
    assert.ok(!isolated.items.some(item => item.id === other.chunkId));
  });

  test('forget and reindex are bounded administrative operations', () => {
    const candidate = engine.ingest({ scope: scope(), region: 'skill', content: 'Forget-me chunk for index maintenance.' });
    assert.deepStrictEqual(engine.forget(scope(), candidate.chunkId), { forgotten: true, chunkId: candidate.chunkId });
    assert.strictEqual(engine.inspect(scope(), candidate.chunkId).status, 'forgotten');
    const reindexed = engine.reindex(scope());
    assert.ok(reindexed.reindexed >= 1);
  });

  console.log('🏁 Selective Memory Engine — ✅ ALL PASSED');
} finally {
  try { db.close(); } catch (_) {}
  fs.rmSync(dir, { recursive: true, force: true });
}
