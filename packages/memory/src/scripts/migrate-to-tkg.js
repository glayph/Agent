'use strict';

const path = require('path');
const fs = require('fs').promises;
const config = require('../config');
const MemoryManager = require('../core/memory-manager');
const TemporalKnowledgeGraph = require('../temporal-knowledge-graph');

async function migrate() {
  console.log('=== Migration: Classic GraphRAG -> Temporal Knowledge Graph ===\n');

  const classicDataDir = path.resolve(config.dataDir);
  const tkgDbPath = path.join(classicDataDir, 'temporal-knowledge-graph.db');

  const mm = new MemoryManager(config);
  await mm.initialize(classicDataDir);
  console.log('[1/3] Classic MemoryManager loaded');

  const tkg = new TemporalKnowledgeGraph(tkgDbPath);
  await tkg.initialize();
  console.log('[2/3] TKG SQLite initialized');

  let migratedCount = 0;
  const allNodes = mm.graph.getAllNodes();
  const memories = allNodes.filter(n => n.type === 'memory');
  const entities = allNodes.filter(n => n.type === 'entity');

  console.log(`  Found ${memories.length} memories, ${entities.length} entities, ${allNodes.length} total nodes`);

  for (const mem of memories) {
    const content = mem.data.content || '';
    const category = mem.data.category || 'general';
    tkg.writeEvent({
      content: content.substring(0, 2000),
      source: 'system',
      event_type: 'migrated_memory',
      metadata: {
        legacyId: mem.id,
        category,
        createdAt: mem.createdAt,
        tags: mem.data.tags
      }
    });
    migratedCount++;
  }

  for (const ent of entities) {
    const attrs = ent.data || {};
    try {
      tkg._ensureEntity({
        name: attrs.label || ent.id,
        type: ent.type,
        attributes: { migratedFrom: 'classic', legacyId: ent.id, ...attrs }
      });
    } catch (e) {
      console.warn(`  Entity migration warning for ${ent.id}: ${e.message}`);
    }
  }

  console.log(`[3/3] Migrated ${migratedCount} memories and ${entities.length} entities to TKG`);

  tkg.close();
  await mm.shutdown();

  console.log('\n=== Migration Complete ===');
  console.log(`TKG database: ${tkgDbPath}`);
  console.log('You can now start the v2 server.');
}

migrate().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
