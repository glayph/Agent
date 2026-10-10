'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const SelectiveMemoryEngine = require('../selective-memory-engine');
const TemporalKnowledgeGraph = require('../temporal-knowledge-graph');
const { splitParagraphs } = require('../paragraph-chunker');

const scope = { agentId: 'miki', ownerId: 'owner', workspaceId: 'ws' };
const filler = (n, word = 'detail') => Array.from({ length: n }, (_, i) => `${word}${i % 7}`).join(' ');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'miki-para-')); }
function makeEngine() {
  const dir = tmp();
  const db = new Database(path.join(dir, 'm.db'));
  const engine = new SelectiveMemoryEngine(db, { maxTokens: 600, maxSelected: 8 });
  engine.initializeSync();
  return { engine, db, dir };
}
let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ [PASS] ${name}`); }
  catch (error) { failed += 1; console.error(`❌ [FAIL] ${name}\n`, error); }
}

const MESSAGE = [
  `The deployment plan: Miki runs inside Oracle VirtualBox on Ubuntu. ${filler(30)}.`,
  `The memory layer stores passages about falconreactor launchprotocol decisions. ${filler(30)}.`,
  `Weekly groceries and the garden schedule are unrelated housekeeping notes. ${filler(30)}.`,
].join('\n\n');

(async () => {
  await test('chunker: paragraphs stay whole, short ones merge, long ones split at sentence ends', () => {
    const parts = splitParagraphs(MESSAGE);
    assert.strictEqual(parts.length, 3);
    assert.ok(parts.every((p) => p.wordCount >= 20 && p.wordCount <= 200));

    assert.strictEqual(splitParagraphs('Hello there. Short message.').length, 1);
    assert.strictEqual(splitParagraphs('# Title\n\n' + filler(40)).length, 1, 'a heading joins its paragraph');

    const sentence = `এটি একটি বাক্য ${filler(25, 'শব্দ')}। `;
    const long = splitParagraphs(sentence.repeat(12));
    assert.ok(long.length >= 3 && long.every((p) => p.wordCount <= 200), 'Bengali danda ends sentences');

    const code = splitParagraphs(`Intro line here.\n\n\`\`\`js\nconst a = 1;\nconst b = 2;\n\`\`\`\n\n${filler(30)}`);
    assert.ok(code.some((p) => p.text.includes('```js') && p.text.includes('const b = 2;')), 'code block is never split');
    assert.deepStrictEqual(splitParagraphs(MESSAGE), splitParagraphs(MESSAGE), 'deterministic');
    assert.deepStrictEqual(splitParagraphs('  \n\n '), []);
  });

  await test('a message is stored as one memory per paragraph, chained in order', () => {
    const { engine, db, dir } = makeEngine();
    try {
      const result = engine.ingestParagraphs({ scope, region: 'long_term', content: MESSAGE, importance: 0.7, metadata: { eventId: 'evt-1' } });
      assert.strictEqual(result.paragraphs, 3);
      assert.strictEqual(result.chunkIds.length, 3);
      const rows = db.prepare("SELECT metadata FROM memory_chunk_index WHERE status = 'active'").all().map((r) => JSON.parse(r.metadata));
      assert.deepStrictEqual(rows.map((m) => m.paragraphIndex).sort(), [0, 1, 2]);
      assert.ok(rows.every((m) => m.paragraphCount === 3 && m.eventId === 'evt-1'));
      const chain = db.prepare("SELECT COUNT(*) AS n FROM memory_chunk_edges WHERE relation_type = 'next_paragraph'").get().n;
      assert.strictEqual(chain, 2, 'paragraphs 1-2 and 2-3 are linked');
      // Storing the same message again adds nothing.
      engine.ingestParagraphs({ scope, region: 'long_term', content: MESSAGE, importance: 0.7, metadata: { eventId: 'evt-1' } });
      assert.strictEqual(db.prepare("SELECT COUNT(*) AS n FROM memory_chunk_index WHERE status = 'active'").get().n, 3);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('recall returns the relevant paragraph, not the whole conversation, and can step to its neighbour', () => {
    const { engine, dir } = makeEngine();
    try {
      const other = (topic) => [
        `Notes about ${topic} planning and scheduling for the quarter. ${filler(40, topic)}.`,
        `More ${topic} details covering budgets and owners. ${filler(40, topic)}.`,
        `Final ${topic} remarks and follow ups. ${filler(40, topic)}.`,
      ].join('\n\n');
      engine.ingestParagraphs({ scope, region: 'long_term', content: other('astronomy'), importance: 0.7 });
      engine.ingestParagraphs({ scope, region: 'long_term', content: MESSAGE, importance: 0.7 });
      engine.ingestParagraphs({ scope, region: 'long_term', content: other('cooking'), importance: 0.7 });
      const stored = [other('astronomy'), MESSAGE, other('cooking')].join('\n\n');

      const result = engine.retrieve('falconreactor launchprotocol decisions', { scope });
      const direct = result.items.filter((item) => item.depth === 0);
      assert.ok(direct.length >= 1 && direct[0].text.includes('falconreactor'), 'the matching paragraph is recalled');
      assert.ok(!direct.some((item) => item.text.includes('groceries')), 'an unrelated paragraph is never a direct hit');
      const neighbour = result.items.find((item) => item.text.includes('Oracle VirtualBox'));
      assert.ok(neighbour && neighbour.depth >= 1, 'the adjacent paragraph arrives through the graph');
      assert.ok(!result.items.some((item) => item.text.includes('astronomy') || item.text.includes('cooking')), 'other conversations stay out');
      assert.ok(result.text.length < stored.length * 0.4, `recall (${result.text.length} chars) must be a small part of what is stored (${stored.length})`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('old whole-message memories are re-cut into paragraphs once, keeping the original', () => {
    const { engine, db, dir } = makeEngine();
    try {
      // A legacy chunk: the whole message stored as one blob (as the previous version did).
      const legacy = engine.ingest({ scope, region: 'long_term', content: MESSAGE.replace(/\n\n/g, ' ') + ' ' + filler(60), importance: 0.7 });
      // This blob has no paragraph breaks, so build one that does:
      const legacy2 = engine.ingest({ scope, region: 'long_term', content: MESSAGE, importance: 0.7, metadata: {} });
      const longMessage = [0, 1, 2].map((i) => `Paragraph ${i} about falconreactor launchprotocol review. ${filler(70, 'legacy')}.`).join('\n\n');
      db.prepare("UPDATE memory_chunk_index SET content = ? WHERE id = ?").run(longMessage, legacy2.chunkId);
      db.prepare("UPDATE memory_chunk_index SET metadata = ? WHERE id = ?").run('{}', legacy2.chunkId);
      db.prepare("DELETE FROM memory_engine_meta WHERE key = 'chunking_version'").run();

      const reopened = new SelectiveMemoryEngine(db, { maxTokens: 600 });
      reopened.initializeSync();
      const old = db.prepare('SELECT status FROM memory_chunk_index WHERE id = ?').get(legacy2.chunkId);
      assert.strictEqual(old.status, 'superseded', 'the original is kept, not deleted');
      const fresh = db.prepare("SELECT COUNT(*) AS n FROM memory_chunk_index WHERE status = 'active' AND metadata LIKE '%rechunkedFrom%'").get().n;
      assert.ok(fresh >= 3, 'paragraph chunks replace it');
      const marker = db.prepare("SELECT value FROM memory_engine_meta WHERE key = 'chunking_version'").get();
      assert.ok(marker && marker.value);
      assert.ok(reopened.retrieve('falconreactor launchprotocol', { scope }).items.length >= 1);
      assert.ok(legacy.chunkId);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test('events are stored as paragraphs and plain words are not turned into entities', async () => {
    const dir = tmp();
    const tkg = new TemporalKnowledgeGraph(path.join(dir, 'tkg.db'));
    await tkg.initialize();
    try {
      const bengali = `আজ আকাশ পরিষ্কার থাকবে এবং বৃষ্টির সম্ভাবনা নেই। ${filler(25, 'আবহাওয়া')}\n\nআমি Miki কে VirtualBox এর মধ্যে ইনস্টল করছি, প্রজেক্টের কোডনেম "ফ্যালকন"। ${filler(25, 'ইনস্টল')}`;
      tkg.writeEvent({ content: bengali, source: 'user', event_type: 'message' });
      const stats = tkg.selectiveMemory.stats();
      assert.ok(stats.chunks >= 2, `paragraph chunks expected, got ${stats.chunks}`);
      const names = tkg.db.prepare('SELECT name FROM entities').all().map((row) => row.name);
      assert.ok(names.includes('Miki') && names.includes('VirtualBox'), `names are kept: ${names}`);
      for (const word of ['আজ', 'আকাশ', 'পরিষ্কার', 'বৃষ্টির', 'এবং', 'মধ্যে']) {
        assert.ok(!names.includes(word), `plain word "${word}" must not be an entity`);
      }
    } finally {
      try { tkg.close && tkg.close(); } catch (_) { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (failed) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
  console.log('🏁 Paragraph memory — ✅ ALL PASSED');
})();
