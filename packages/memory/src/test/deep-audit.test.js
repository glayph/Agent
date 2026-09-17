'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const TemporalKnowledgeGraph = require('../temporal-knowledge-graph');

function freshDbPath() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-memory-audit-'));
  return { root, dbPath: path.join(root, 'memory.db') };
}

async function withTkg(fn) {
  const { root, dbPath } = freshDbPath();
  const tkg = new TemporalKnowledgeGraph(dbPath);
  try {
    await tkg.initialize();
    return await fn(tkg);
  } finally {
    tkg.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function run() {
  const tests = [
    ['NodeGraph rejects id/key identity collisions', async () => {
      await withTkg(async (tkg) => {
        const graph = tkg.getNodeGraph();
        graph.upsertNode({ id: 'node-a', key: 'key-a', label: 'A' });
        graph.upsertNode({ id: 'node-b', key: 'key-b', label: 'B' });
        assert.throws(
          () => graph.upsertNode({ id: 'node-a', key: 'key-b', label: 'collision' }),
          /id\/key conflict/,
        );
        assert.strictEqual(
          tkg.db.prepare('SELECT node_key FROM node_graph_nodes WHERE id = ?').get('node-a').node_key,
          'key-a',
        );
      });
    }],
    ['TemporaryMemory only rolls summaries into durable regions and returns the event id', async () => {
      await withTkg(async (tkg) => {
        const temporary = tkg.getTemporaryMemory();
        assert.throws(
          () => temporary.openSession('task:bad', { durableRegion: 'temporary' }),
          /must be durable/,
        );
        const session = temporary.openSession('task:good', { durableRegion: 'long_term' });
        temporary.writeNode(session.sessionId, 'implemented the durable summary');
        const eventId = temporary.closeSession(session.sessionId, { summary: 'Implemented durable summary.' });
        assert.match(eventId, /^[0-9a-f-]{36}$/);
        const event = tkg.db.prepare('SELECT memory_category, event_type FROM events WHERE id = ?').get(eventId);
        assert.deepStrictEqual(
          { memory_category: event.memory_category, event_type: event.event_type },
          { memory_category: 'long_term', event_type: 'temp_summary' },
        );
      });
    }],
    ['Multi-hop retrieval excludes expired edges and honors zero-hop requests', async () => {
      await withTkg(async (tkg) => {
        tkg.writeEvent({
          content: 'Alpha connects to Beta',
          event_type: 'fact',
          entities: [{ name: 'Alpha' }, { name: 'Beta' }],
          skipNoiseFilter: true,
        });
        const alphaId = tkg._entityIdFromName('Alpha');
        const betaId = tkg._entityIdFromName('Beta');
        const edgeId = tkg.addEntityRelation(alphaId, betaId, 'connects', {
          factText: 'Alpha connects to Beta',
          weight: 1,
        }).id;
        tkg.db.prepare('UPDATE entity_edges SET valid_until = ? WHERE id = ?')
          .run(new Date(Date.now() - 60_000).toISOString(), edgeId);

        const expired = tkg.multiHopRetrieve({ seedEntityIds: [alphaId], maxHops: 1 });
        assert.deepStrictEqual(expired.nodes.map((node) => node.id), [alphaId]);
        assert.strictEqual(expired.edges.length, 0);

        const zeroHop = tkg.multiHopRetrieve({ seedEntityIds: [alphaId], maxHops: 0 });
        assert.strictEqual(zeroHop.hops.length, 1);
        assert.deepStrictEqual(zeroHop.nodes.map((node) => node.id), [alphaId]);
      });
    }],
  ];

  let failures = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`✅ [PASS] ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`❌ [FAIL] ${name}`);
      console.error(`  ${error.message}`);
    }
  }
  if (failures > 0) {
    process.exitCode = 1;
    throw new Error(`${failures} deep memory audit test(s) failed`);
  }
}

run().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

