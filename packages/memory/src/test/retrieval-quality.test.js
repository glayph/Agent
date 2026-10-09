'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const SelectiveMemoryEngine = require('../selective-memory-engine');
const { tokenize } = require('../text-tokens');

const scope = { agentId: 'miki', ownerId: 'owner', workspaceId: 'ws' };

function makeEngine(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-quality-'));
  const db = new Database(path.join(dir, 'memory.db'));
  const engine = new SelectiveMemoryEngine(db, { candidateLimit: 64, maxSelected: 8, maxDepth: 2, maxTokens: 400, ...options });
  engine.initializeSync();
  return { engine, db, dir };
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

test('tokenizer keeps Bengali words whole and strips common suffixes', () => {
  assert.deepStrictEqual(tokenize('মেমোরি সিস্টেম আপগ্রেড করো'), ['মেমোরি', 'সিস্টেম', 'আপগ্রেড']);
  assert.ok(tokenize('মেমোরিতে কী আছে?').includes('মেমোরি'));
  assert.deepStrictEqual(tokenize('আমি Miki কে VirtualBox এর মধ্যে install করবো'), ['miki', 'virtualbox', 'install']);
  // Latin and accented text is unchanged.
  assert.deepStrictEqual(tokenize('memory system upgrade'), ['memory', 'system', 'upgrade']);
  assert.ok(tokenize('Café résumé').includes('café'));
});

test('Bengali memories are recalled, including inflected forms of the same word', () => {
  const { engine, dir } = makeEngine();
  try {
    engine.ingest({ scope, region: 'long_term', content: 'প্রজেক্টের কোডনেম হলো ফ্যালকন এবং এটি VirtualBox এর মধ্যে চলবে।', importance: 0.6 });
    engine.ingest({ scope, region: 'long_term', content: 'মেমোরি সিস্টেম গ্রাফ ভিত্তিক হবে।', importance: 0.6 });
    // More important and fresher, but about something else: must not be recalled.
    engine.ingest({ scope, region: 'long_term', content: 'আজকের আবহাওয়া খুব সুন্দর এবং বৃষ্টি হবে না।', importance: 1, confidence: 1 });
    const direct = engine.retrieve('কোডনেম কী?', { scope });
    assert.ok(direct.items.some((item) => item.text.includes('ফ্যালকন')), 'direct Bengali query should recall');
    assert.ok(!direct.items.some((item) => item.text.includes('আবহাওয়া')), 'unrelated Bengali memory must not be recalled');
    const inflected = engine.retrieve('মেমোরিতে কী পরিবর্তন হবে?', { scope });
    assert.ok(inflected.items.some((item) => item.text.includes('গ্রাফ')), 'inflected form should still match');
    assert.ok(!inflected.items.some((item) => item.text.includes('আবহাওয়া')), 'unrelated Bengali memory must not be recalled');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('priors alone never make an unrelated memory relevant', () => {
  const { engine, dir } = makeEngine();
  try {
    // Highly important, fresh, confident, in the right region - but about something else.
    engine.ingest({ scope, region: 'long_term', content: 'The deployment uses Ubuntu inside Oracle VirtualBox.', importance: 1, confidence: 1 });
    const result = engine.retrieve('What is the capital of France?', { scope });
    assert.strictEqual(result.items.length, 0, 'unrelated query must recall nothing');
    // A single generic word out of a long query is not enough evidence either.
    const weak = engine.retrieve('describe elaborate medieval dragons castles knights kingdoms battles legends near Ubuntu', { scope, regions: ['long_term'] });
    assert.strictEqual(weak.items.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('graph hop reaches a related chunk the query itself does not match', () => {
  const { engine, db, dir } = makeEngine();
  try {
    engine.ingest({ scope, region: 'long_term', content: 'Agent Miki memory uses a temporal knowledge graph.', importance: 0.7 });
    engine.ingest({ scope, region: 'long_term', content: 'The temporal knowledge graph keeps history across restarts.', importance: 0.7 });
    const result = engine.retrieve('Agent Miki memory', { scope });
    const hop = result.items.find((item) => item.text.includes('across restarts'));
    assert.ok(hop, 'neighbor should be reached through the graph');
    assert.ok(hop.depth >= 1, 'it must arrive through an edge, not as a query match');
    // The trace names the real edge, not a chunk id.
    const edge = db.prepare('SELECT id FROM memory_chunk_edges WHERE id = ?').get(hop.via.edgeId);
    assert.ok(edge, 'trace must reference an existing edge id');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new chunk is linked to OLD related chunks, not only the most recent ones', () => {
  const { engine, db, dir } = makeEngine();
  try {
    const old = engine.ingest({ scope, region: 'long_term', content: 'Falconreactor launchprotocol was approved by the board.', importance: 0.6 });
    for (let index = 0; index < 40; index += 1) {
      engine.ingest({ scope, region: 'day_to_day', content: `Unrelated note number ${index} about weather and groceries item${index}.`, importance: 0.3 });
    }
    const fresh = engine.ingest({ scope, region: 'long_term', content: 'Today the falconreactor launchprotocol review was scheduled.', importance: 0.6 });
    const linked = db.prepare(`SELECT COUNT(*) AS n FROM memory_chunk_edges
      WHERE (source_chunk_id = ? AND target_chunk_id = ?) OR (source_chunk_id = ? AND target_chunk_id = ?)`)
      .get(fresh.chunkId, old.chunkId, old.chunkId, fresh.chunkId).n;
    assert.ok(linked >= 1, 'fresh chunk must connect to the old chunk sharing rare tokens');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('chunks stored with the old tokenizer are rebuilt once on startup', () => {
  const { engine, db, dir } = makeEngine();
  try {
    const stored = engine.ingest({ scope, region: 'long_term', content: 'মেমোরি সিস্টেম আপগ্রেড করা হবে।', importance: 0.6 });
    // Simulate data written before the fix: mangled tokens, no version marker.
    db.prepare('UPDATE memory_chunk_index SET metadata = ? WHERE id = ?').run(JSON.stringify({ tokens: ['আপগ', 'কর'] }), stored.chunkId);
    db.prepare('DELETE FROM memory_chunk_postings WHERE chunk_id = ?').run(stored.chunkId);
    db.prepare("DELETE FROM memory_engine_meta WHERE key = 'tokenizer_version'").run();

    const reopened = new SelectiveMemoryEngine(db, { maxTokens: 400 });
    reopened.initializeSync();
    const row = db.prepare('SELECT metadata FROM memory_chunk_index WHERE id = ?').get(stored.chunkId);
    const tokens = JSON.parse(row.metadata).tokens;
    assert.ok(tokens.includes('মেমোরি') && tokens.includes('সিস্টেম'));
    const postings = db.prepare('SELECT token FROM memory_chunk_postings WHERE chunk_id = ?').all(stored.chunkId).map((r) => r.token);
    assert.ok(postings.includes('মেমোরি'));
    assert.ok(reopened.retrieve('মেমোরি সিস্টেম', { scope }).items.length >= 1);
    // The marker is written, so it does not run again.
    const marker = db.prepare("SELECT value FROM memory_engine_meta WHERE key = 'tokenizer_version'").get();
    assert.ok(marker && marker.value);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log('🏁 Retrieval quality — ✅ ALL PASSED');
