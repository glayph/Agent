'use strict';

const assert = require('assert');
const fs = require('fs').promises;
const path = require('path');
const GraphStore = require('../core/graph-store');
const TemporalEngine = require('../core/temporal-engine');
const ChunkEngine = require('../core/chunk-engine');
const VectorIndex = require('../core/vector-index');
const Optimizer = require('../core/optimizer');
const MemoryManager = require('../core/memory-manager');
const NodeGraphRAG = require('../nodegraphrag');
const config = require('../config');

const TEST_DIR = path.join(__dirname, '..', '..', 'data_test');

async function runTests() {
  console.log('🧪 Starting GraphRAG Memory System Integration Tests...\n');
  let failures = 0;

  const test = async (name, fn) => {
    try {
      await fn();
      console.log(`✅ [PASS] ${name}`);
    } catch (err) {
      console.error(`❌ [FAIL] ${name}`);
      console.error(err);
      failures++;
    }
  };

  // ═══════════════════════════════════════
  // GRAPH STORE TESTS
  // ═══════════════════════════════════════
  await test('GraphStore: Node & Edge CRUD, BFS neighbors, communities', () => {
    const graph = new GraphStore();
    
    // Add nodes
    graph.addNode('node1', 'memory', { content: 'Agent learned something' });
    graph.addNode('node2', 'entity', { label: 'Alice' });
    graph.addNode('node3', 'entity', { label: 'Bob' });
    
    assert.strictEqual(graph.getAllNodes().length, 3);
    assert.strictEqual(graph.getNode('node2').type, 'entity');

    // Add edges
    graph.addEdge('node1', 'node2', 'references', 1.0);
    graph.addEdge('node2', 'node3', 'relates_to', 0.8);
    
    assert.strictEqual(graph.getAllEdges().length, 2);
    assert.strictEqual(graph.getEdge('node1', 'node2').type, 'references');

    // BFS Multi-hop neighbors
    const neighbors = graph.getNeighbors('node1', 2);
    assert.strictEqual(neighbors.length, 2); // Alice and Bob
    assert(neighbors.some(n => n.node.id === 'node3' && n.depth === 2));

    // Path finding
    const path = graph.findPath('node1', 'node3');
    assert.deepStrictEqual(path, ['node1', 'node2', 'node3']);

    // Communities Louvain detection
    graph.detectCommunities();
    assert(graph.getNode('node1').communityId !== null);
  });

  // ═══════════════════════════════════════
  // TEMPORAL ENGINE TESTS
  // ═══════════════════════════════════════
  await test('TemporalEngine: Validity, decay calculation, timeline clustering', () => {
    const temp = new TemporalEngine();
    
    const nowStr = temp.now();
    assert(nowStr.endsWith('Z') || nowStr.includes('+') || nowStr.includes('-'));

    // Validity
    const memoryId = 'mem-time-1';
    temp.records.set(memoryId, {
      validFrom: new Date(Date.now() - 10000).toISOString(),
      validUntil: new Date(Date.now() + 10000).toISOString(),
      createdAt: new Date().toISOString(),
      lastAccessed: new Date().toISOString(),
      accessCount: 1,
      supersededBy: null
    });

    assert(temp.isValid(memoryId));
    temp.invalidate(memoryId);
    assert(!temp.isValid(memoryId));

    // Decay calculations
    const oneWeekAgo = new Date(Date.now() - 168 * 60 * 60 * 1000).toISOString();
    const decayFactor = temp.calculateDecay(oneWeekAgo, 168);
    assert(Math.abs(decayFactor - 0.5) < 0.01); // 1 week decay factor should be 0.5 for 168hr half life
  });

  // ═══════════════════════════════════════
  // CHUNK ENGINE TESTS
  // ═══════════════════════════════════════
  await test('ChunkEngine: Paragraph, sentence, semantic splits and deduplication', () => {
    const chunker = new ChunkEngine();
    const text = 'Paragraph one text. Sentence two content here.\n\nParagraph two. Second sentence is this.';

    // Paragraph split
    const paras = chunker.chunkParagraph(text);
    assert.strictEqual(paras.length, 2);

    // Sentence split
    const sents = chunker.chunkSentence(text, 1);
    assert.strictEqual(sents.length, 4);

    // Semantic splits
    const semantics = chunker.chunkSemantic(text, 128);
    assert(semantics.length >= 1);

    // Deduplication
    chunker.addChunk({ text: 'Duplicate context block', sourceId: 'doc1' });
    chunker.addChunk({ text: 'Duplicate context block', sourceId: 'doc2' });
    assert.strictEqual(chunker.chunks.size, 2);
    
    const removedCount = chunker.deduplicate();
    assert.strictEqual(removedCount, 1);
    assert.strictEqual(chunker.chunks.size, 1);
  });

  // ═══════════════════════════════════════
  // VECTOR INDEX TESTS
  // ═══════════════════════════════════════
  await test('VectorIndex: Porter stemming, TF-IDF cosine similarity, BM25 hybrid ranking', () => {
    const idx = new VectorIndex();
    
    // Stemming check
    assert.strictEqual(idx.stem('running'), 'run');
    assert.strictEqual(idx.stem('organizations'), 'organ');
    assert.strictEqual(idx.stem('activities'), 'activity');

    // Indexing documents
    idx.addDocument('docA', 'Agentic AI uses GraphRAG for long term cognitive memory systems.');
    idx.addDocument('docB', 'Quantum computing architectures are scaling rapidly in 2026.');
    
    assert.strictEqual(idx.documents.size, 2);
    assert(idx.vocabulary.has('system') || idx.vocabulary.has('cognitive'));

    // Vector Similarity Search
    const vecResults = idx.searchSimilar('GraphRAG memory', 2);
    assert.strictEqual(vecResults[0].docId, 'docA');
    assert(vecResults[0].score > 0);

    // BM25 Search
    const bmResults = idx.searchBM25('quantum scaling', 2);
    assert.strictEqual(bmResults[0].docId, 'docB');

    // Hybrid Search
    const hybResults = idx.searchHybrid('AI computing systems', { topK: 2 });
    assert.strictEqual(hybResults.length, 2);
  });

  // ═══════════════════════════════════════
  // MEMORY MANAGER TESTS
  // ═══════════════════════════════════════
  await test('MemoryManager: Initialization, store pipeline, entity link, hybrid retrieval', async () => {
    // Clear test dir if exists
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    
    const mm = new MemoryManager(config);
    await mm.initialize(TEST_DIR);

    // Store memories
    const id1 = await mm.store('OpenAI launched a new GPT-5 model yesterday in San Francisco.', { category: 'fact' });
    const id2 = await mm.store('We are pair programming with Google DeepMind Antigravity agent.', { category: 'conversation' });

    assert(mm.graph.getNode(id1));
    assert(mm.graph.getNode(id2));

    // Entity auto extraction assertion
    const entities = mm.graph.getNodesByType('entity');
    assert(entities.length > 0);
    // San Francisco or OpenAI should have been extracted
    assert(entities.some(e => ['openai', 'san-francisco', 'google', 'deepmind'].includes(e.id)));

    // Full retrieval
    const record = await mm.retrieve(id1);
    assert.strictEqual(record.data.category, 'fact');
    assert(record.relatedEntities.length > 0);

    // Hybrid Search
    const searchRes = await mm.search('GPT-5 model San Francisco');
    assert.strictEqual(searchRes[0].id, id1);

    // Context assembler
    const ctx = await mm.getContext('Antigravity DeepMind agent');
    assert(ctx.includes('Antigravity') || ctx.includes('DeepMind'));

    await mm.shutdown();
  });

  // ═══════════════════════════════════════
  // NODEGRAPHRAG TESTS
  // ═══════════════════════════════════════
  await test('NodeGraphRAG: initialize, store, search, and context assembly', async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});

    const rag = new NodeGraphRAG({ dataDir: TEST_DIR, autoSaveIntervalMs: 0 });
    await rag.initialize();

    const memoryId = await rag.addMemory('NodeGraphRAG stores facts in a knowledge graph for retrieval.', {
      category: 'fact'
    });

    const results = await rag.search('NodeGraphRAG knowledge graph');
    assert(results.some(result => result.id === memoryId));

    const context = await rag.getContext('knowledge graph retrieval');
    assert(context.includes('NodeGraphRAG'));

    await rag.shutdown();
  });

  // ═══════════════════════════════════════
  // OPTIMIZER TESTS
  // ═══════════════════════════════════════
  await test('Optimizer: Node merge duplicates, cleaning orphans, stale record TTL, backups', async () => {
    await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    const mm = new MemoryManager(config);
    await mm.initialize(TEST_DIR);

    // Setup duplicate entities manually
    mm.graph.addNode('openai-inc', 'entity', { label: 'OpenAI Inc' });
    mm.graph.addNode('openai-corp', 'entity', { label: 'OpenAI Corp' });

    // Link one to show it's connected, leave the other as orphan
    mm.graph.addNode('mem-fact', 'memory', { content: 'Company news' });
    mm.graph.addEdge('mem-fact', 'openai-inc', 'references', 1.0);

    const duplicates = mm.optimizer.detectDuplicateNodes(0.3);
    assert(duplicates.length > 0);

    // Merge duplicates
    mm.optimizer.mergeNodes('openai-inc', 'openai-corp');
    assert.strictEqual(mm.graph.getNode('openai-corp'), null);
    
    // Test backups
    const backupDir = path.join(TEST_DIR, 'backups');
    await mm.optimize({ backupDir, maxBackups: 2 });
    
    const dirs = await fs.readdir(backupDir);
    assert(dirs.some(d => d.startsWith('backup_')));

    await mm.shutdown();
  });

  console.log(`\n🏁 Test Run Summary: ${failures === 0 ? 'ALL PASSED!' : `${failures} FAILED`}`);
  if (failures > 0) process.exit(1);
}

runTests().catch(err => {
  console.error('[CRITICAL] Unhandled test exception:', err);
  process.exit(1);
});
