'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const SelectiveMemoryEngine = require('../selective-memory-engine');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miki-memory-benchmark-'));
const db = new Database(path.join(dir, 'benchmark.db'));
const engine = new SelectiveMemoryEngine(db, {
  candidateLimit: 96,
  maxSelected: 12,
  maxDepth: 2,
  maxNeighbors: 6,
  maxTokens: 1200,
});
engine.initializeSync();
const scope = { agentId: 'miki', ownerId: 'benchmark', workspaceId: 'scale-test' };

try {
  const started = Date.now();
  for (let index = 0; index < 1200; index += 1) {
    const region = index % 5 === 0 ? 'static' : index % 3 === 0 ? 'skill' : 'long_term';
    engine.ingest({
      scope,
      region,
      content: `Deterministic memory fixture ${index}: migration policy, retrieval ranking, and Agent Miki operational context for benchmark ${index % 17}.`,
      sourceType: index % 2 === 0 ? 'user' : 'system',
      provenance: index % 2 === 0 ? 'user_stated' : 'derived',
      confidence: 0.6 + ((index % 4) * 0.1),
      importance: 0.4 + ((index % 5) * 0.1),
      sourceReference: `fixture-${index}`,
    });
  }
  const ingestMs = Date.now() - started;
  const queryStarted = Date.now();
  const result = engine.retrieve('migration policy benchmark 731', {
    scope,
    regions: ['static', 'long_term', 'skill'],
    maxSelected: 12,
    maxDepth: 2,
    maxTokens: 120,
  });
  const queryMs = Date.now() - queryStarted;
  assert.ok(result.items.length > 0);
  assert.ok(result.items.length <= 12);
  assert.ok(result.stats.tokensUsed <= 120);
  assert.ok(result.trace.path.every((step) => step.depth <= 2));
  assert.strictEqual(engine.retrieve('benchmark 731', { scope: { ...scope, ownerId: 'other-owner' } }).items.length, 0);
  const reindex = engine.reindex(scope);
  assert.strictEqual(reindex.reindexed, 1200);
  const stats = engine.stats(scope);
  const output = {
    fixtureChunks: stats.chunks,
    postings: stats.postings,
    edges: stats.edges,
    ingestMs,
    queryMs,
    selected: result.items.length,
    candidates: result.stats.candidateCount,
    tokensUsed: result.stats.tokensUsed,
    maxTokens: result.stats.maxTokens,
    maxDepth: result.trace.maxDepth,
    isolatedScopeItems: 0,
    reindexed: reindex.reindexed,
  };
  console.log(JSON.stringify(output, null, 2));
} finally {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
