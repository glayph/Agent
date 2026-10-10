#!/usr/bin/env node
'use strict';

/**
 * Remove the one-word "entities" the old extraction rule left in the memory graph.
 *
 *   node packages/memory/scripts/prune-word-entities.js <dataDir>           # dry run: only reports
 *   node packages/memory/scripts/prune-word-entities.js <dataDir> --apply   # really deletes
 *
 * <dataDir> is the directory that contains memory/tkg.db. Stop the gateway first and
 * keep a copy of tkg.db: this edits the database.
 */

const fs = require('fs');
const path = require('path');
const TemporalKnowledgeGraph = require('../src/temporal-knowledge-graph');

(async () => {
  const dataDir = process.argv[2];
  const apply = process.argv.includes('--apply');
  if (!dataDir) {
    console.error('Usage: prune-word-entities.js <dataDir> [--apply]');
    process.exit(2);
  }
  const dbPath = path.join(dataDir, 'memory', 'tkg.db');
  if (!fs.existsSync(dbPath)) {
    console.error(`No database at ${dbPath}`);
    process.exit(2);
  }
  const tkg = new TemporalKnowledgeGraph(dbPath);
  await tkg.initialize();
  try {
    const result = tkg.pruneWordEntities({ dryRun: !apply });
    console.log(JSON.stringify(result, null, 2));
    if (!apply) console.log('\nDry run: nothing was deleted. Re-run with --apply to remove these entities.');
  } finally {
    if (typeof tkg.close === 'function') tkg.close();
  }
})();
