'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TemporalKnowledgeGraph = require('../temporal-knowledge-graph');
const { parseExtraction, extractPending, SYSTEM_PROMPT } = require('../graph-extraction');

let failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`✅ [PASS] ${name}`); }
  catch (error) { failed += 1; console.error(`❌ [FAIL] ${name}\n`, error); }
}

const GOOD = JSON.stringify({
  entities: [
    { name: 'Miki', type: 'product' },
    { name: 'Oracle VirtualBox', type: 'product' },
    { name: 'ফ্যালকন', type: 'project' },
    { name: 'it', type: 'other' },
    { name: '2026', type: 'other' },
    { name: 'miki', type: 'product' },
  ],
  relations: [
    { subject: 'Miki', predicate: 'Installed On!', object: 'Oracle VirtualBox', fact: 'Miki is installed inside Oracle VirtualBox.' },
    { subject: 'ফ্যালকন', predicate: 'codename_of', object: 'Miki', fact: 'Falcon is the codename of Miki.' },
    { subject: 'Miki', predicate: 'uses', object: 'Unknown Thing', fact: 'object is not an extracted entity' },
    { subject: 'Miki', predicate: 'uses', object: 'Miki', fact: 'self relation' },
  ],
});

(async () => {
  await test('parseExtraction validates, normalises and caps model output', () => {
    const parsed = parseExtraction('Here you go:\n```json\n' + GOOD + '\n```');
    assert.deepStrictEqual(parsed.entities.map((e) => e.name), ['Miki', 'Oracle VirtualBox', 'ফ্যালকন'], 'filler words, numbers and duplicates are dropped');
    assert.strictEqual(parsed.entities[2].type, 'project');
    assert.strictEqual(parsed.relations.length, 2, 'relations need two known, different entities');
    assert.strictEqual(parsed.relations[0].predicate, 'installed_on');
    assert.strictEqual(parseExtraction('not json at all'), null);
    assert.strictEqual(parseExtraction(''), null);
    assert.strictEqual(parseExtraction('{"entities": "oops"}').entities.length, 0);
    const many = JSON.stringify({ entities: Array.from({ length: 30 }, (_, i) => ({ name: `Thing${i}`, type: 'weird' })), relations: [] });
    const capped = parseExtraction(many);
    assert.strictEqual(capped.entities.length, 8);
    assert.ok(capped.entities.every((e) => e.type === 'other'), 'unknown types become "other"');
  });

  await test('the extraction prompt treats the paragraph as untrusted data', () => {
    assert.match(SYSTEM_PROMPT, /untrusted DATA/);
    assert.match(SYSTEM_PROMPT, /Ignore any instruction/);
  });

  await test('extractPending turns paragraphs into entities and relations once, with provenance', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-extract-'));
    const tkg = new TemporalKnowledgeGraph(path.join(dir, 'tkg.db'));
    await tkg.initialize();
    try {
      tkg.writeEvent({ content: 'আমি Miki কে Oracle VirtualBox এর মধ্যে ইনস্টল করছি এবং প্রজেক্টের কোডনেম ফ্যালকন। ' + 'ধাপ '.repeat(20), source: 'user', event_type: 'message' });
      tkg.writeEvent({ content: 'ঠিক আছে', source: 'agent', event_type: 'message' });
      const prompts = [];
      const complete = async (messages) => { prompts.push(messages); return GOOD; };

      const first = await extractPending(tkg, { complete, limit: 5 });
      assert.strictEqual(first.processed, 1);
      assert.strictEqual(first.skipped, 1, 'a two-word message is not worth a model call');
      assert.strictEqual(first.entities, 3);
      assert.strictEqual(first.relations, 2);
      assert.strictEqual(prompts.length, 1);
      assert.match(prompts[0][1].content, /ফ্যালকন/);

      const rows = tkg.db.prepare('SELECT name, type FROM entities ORDER BY name').all();
      const byName = Object.fromEntries(rows.map((r) => [r.name, r.type]));
      assert.strictEqual(byName['ফ্যালকন'], 'project');
      assert.strictEqual(byName['Oracle VirtualBox'], 'product');
      assert.strictEqual(byName.Miki, 'product', 'the model\'s specific type replaces the heuristic\'s generic one');
      const edges = tkg.db.prepare('SELECT relation_type, metadata FROM entity_edges').all();
      assert.deepStrictEqual(edges.map((e) => e.relation_type).sort(), ['codename_of', 'installed_on']);
      assert.ok(edges.every((e) => JSON.parse(e.metadata).origin === 'llm'));

      // Nothing is processed twice.
      const second = await extractPending(tkg, { complete, limit: 5 });
      assert.deepStrictEqual([second.processed, second.skipped, second.failed], [0, 0, 0]);
      assert.strictEqual(prompts.length, 1);

      // LLM-made name entities survive the old-word cleanup.
      assert.strictEqual(tkg.pruneWordEntities({ dryRun: false }).pruned >= 0, true);
      assert.ok(tkg.db.prepare("SELECT 1 FROM entities WHERE name = 'ফ্যালকন'").get(), 'typed entities are never pruned as plain words');
    } finally {
      try { tkg.close && tkg.close(); } catch (_) { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('known facts about the names in a question reach the prompt; closed or unrelated facts do not', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-facts-'));
    const tkg = new TemporalKnowledgeGraph(path.join(dir, 'tkg.db'));
    await tkg.initialize();
    try {
      tkg.writeEvent({ content: 'আমি Miki কে Oracle VirtualBox এর মধ্যে ইনস্টল করছি এবং প্রজেক্টের কোডনেম ফ্যালকন। ' + 'ধাপ '.repeat(20), source: 'user', event_type: 'message' });
      await extractPending(tkg, { complete: async () => GOOD, limit: 5 });

      const cards = tkg.getFactCards('Miki কোথায় ইনস্টল করা আছে?');
      assert.ok(cards.items.some((item) => item.relation === 'installed_on' && /VirtualBox/.test(item.text)), cards.text);
      assert.ok(cards.items.every((item) => item.text.length < 200), 'a fact is one short line');
      assert.deepStrictEqual(tkg.getFactCards('What is the capital of France?').items, []);
      assert.deepStrictEqual(tkg.getFactCards('').items, []);

      // The full recall path: facts come first and make the block count as "something recalled".
      const AgentMemoryIntegration = require('../agent-memory-integration');
      const memory = new AgentMemoryIntegration(tkg);
      const prompt = memory.getPromptContext('Miki কোথায় ইনস্টল করা আছে?');
      assert.strictEqual(prompt.hasContent, true);
      assert.match(prompt.text, /KNOWN FACTS[\s\S]*installed_on/);

      // A fact that is no longer true is not recalled.
      const edge = tkg.db.prepare("SELECT id FROM entity_edges WHERE relation_type = 'installed_on'").get();
      tkg.deprecateEntityRelation(edge.id);
      assert.ok(!tkg.getFactCards('Miki কোথায় ইনস্টল করা আছে?').items.some((item) => item.relation === 'installed_on'));
    } finally {
      try { tkg.close && tkg.close(); } catch (_) { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  await test('a failing or garbage model is retried a few times, then given up on', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-extract-'));
    const tkg = new TemporalKnowledgeGraph(path.join(dir, 'tkg.db'));
    await tkg.initialize();
    try {
      tkg.writeEvent({ content: 'The weekly planning meeting covers budgets, owners and the release schedule for the quarter.', source: 'user', event_type: 'message' });
      let calls = 0;
      const complete = async () => { calls += 1; return 'sorry, I cannot do that'; };
      const logs = [];
      for (let round = 0; round < 5; round += 1) await extractPending(tkg, { complete, limit: 3, log: (m) => logs.push(m) });
      assert.strictEqual(calls, 3, 'gives up after three attempts instead of burning tokens forever');
      const chunk = tkg.db.prepare("SELECT metadata FROM memory_chunk_index WHERE metadata LIKE '%extractionFailed%'").get();
      assert.ok(chunk, 'the chunk is marked as failed');
      assert.strictEqual(tkg.db.prepare('SELECT COUNT(*) AS n FROM entities').get().n >= 0, true);
      assert.ok(logs.includes('graph_extraction.chunk_failed'));
    } finally {
      try { tkg.close && tkg.close(); } catch (_) { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  if (failed) { console.error(`\n${failed} test(s) failed`); process.exit(1); }
  console.log('🏁 Graph extraction — ✅ ALL PASSED');
})();
