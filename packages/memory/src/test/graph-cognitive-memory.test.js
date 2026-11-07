'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const GraphCognitiveMemory = require('../graph-cognitive-memory');

const dbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'miki-graph-memory-')), 'memory.db');
const scopeA = { agentId: 'miki', ownerId: 'owner-a', workspaceId: 'workspace-a' };
const scopeB = { agentId: 'miki', ownerId: 'owner-b', workspaceId: 'workspace-a' };
const memory = new GraphCognitiveMemory(dbPath, { defaultScope: scopeA, maxInjectedMemories: 10 });
memory.initializeSync();

const preference = memory.ingest({ scope: scopeA, content: 'The user prefers concise Bengali answers.', category: 'personality', memoryType: 'preference', explicit: true, trustLevel: 'owner', confidence: 0.95, explicitImportance: 0.9, sourceReference: 'test:preference' });
assert.equal(preference.stored, true);
assert.equal(memory.ingest({ scope: scopeA, content: 'The user prefers concise Bengali answers.', category: 'personality', memoryType: 'preference', explicit: true, trustLevel: 'owner' }).duplicate, true);
assert.equal(memory.ingest({ scope: scopeA, content: 'The user prefers concise Bengali answers.', category: 'personality', memoryType: 'preference', explicit: true, trustLevel: 'owner' }).nodeId, preference.nodeId);


const importedGraphFact = memory.ingest({ scope: scopeA, content: 'Imported text claims the secret phrase is copper skyline.', category: 'conversation', memoryType: 'fact', explicit: true, sourceType: 'external_import', sourceReference: 'import:graph-1' });
assert.equal(importedGraphFact.stored, true);
assert.equal(memory.getContext('secret phrase copper skyline', { scope: scopeA, limit: 5 }).items.some((item) => item.id === importedGraphFact.nodeId), false);
const repeatedByAgent = memory.ingest({ scope: scopeA, content: 'Imported text claims the secret phrase is copper skyline.', category: 'conversation', memoryType: 'fact', explicit: true, sourceType: 'agent', trustLevel: 'agent' });
assert.equal(repeatedByAgent.duplicate, true);
assert.equal(memory.db.prepare('SELECT trust_level FROM memory_nodes WHERE id=?').get(importedGraphFact.nodeId).trust_level, 'untrusted');
const approvedByOwner = memory.ingest({ scope: scopeA, content: 'Imported text claims the secret phrase is copper skyline.', category: 'conversation', memoryType: 'fact', explicit: true, sourceType: 'user', trustLevel: 'owner' });
assert.equal(approvedByOwner.duplicate, true);
assert.equal(memory.getContext('secret phrase copper skyline', { scope: scopeA, limit: 5 }).items.some((item) => item.id === importedGraphFact.nodeId), true);

const projectFact = memory.ingest({ scope: scopeA, projectId: 'agent-miki', content: 'Agent Miki uses Gemini as the default model.', category: 'project_context', memoryType: 'decision', explicit: true, trustLevel: 'owner', sourceReference: 'test:model' });
const procedure = memory.ingest({ scope: scopeA, projectId: 'agent-miki', content: 'Build the frontend before deploying the runtime dist directory.', category: 'procedural', memoryType: 'workflow', explicit: true, trustLevel: 'owner', sourceReference: 'test:workflow' });
assert.equal(projectFact.stored, true);
assert.equal(procedure.stored, true);
assert.equal(memory.connect(scopeA, projectFact.nodeId, procedure.nodeId, 'RELATED_TO', { weight: 0.8 }), memory.connect(scopeA, projectFact.nodeId, procedure.nodeId, 'RELATED_TO', { weight: 0.8 }));

const context = memory.getContext('Gemini default model', { scope: scopeA, limit: 5, maxTokens: 100 });
assert.ok(context.text.includes('Gemini'));
assert.ok(context.items.length >= 1);
assert.ok(context.items.every((item) => !/api[_ -]?key|password|secret/i.test(item.text)));

const isolated = memory.getContext('Gemini default model', { scope: scopeB, limit: 5 });
assert.equal(isolated.items.length, 0);

const redacted = memory.ingest({ scope: scopeA, content: 'Temporary credential api_key=sk-test-secret-value must never persist.', category: 'conversation', explicit: true, trustLevel: 'owner', sourceReference: 'test:redaction' });
const storedRedacted = new Database(dbPath).prepare('SELECT content FROM memory_nodes WHERE id = ?').get(redacted.nodeId);
assert.ok(storedRedacted.content.includes('[REDACTED]'));


// Imported/external content stays excluded from retrieval even when an agent
// later repeats the same text. Only an explicit owner approval can promote it.
const untrusted = memory.ingest({ scope: scopeA, content: 'External note says the recovery phrase is amber compass.', category: 'conversation', memoryType: 'fact', explicit: true, sourceType: 'external', sourceReference: 'import:external-1' });
assert.equal(untrusted.stored, true);
assert.equal(memory.getContext('recovery phrase amber compass', { scope: scopeA, limit: 5 }).items.some((item) => item.id === untrusted.nodeId), false);
const duplicateAgent = memory.ingest({ scope: scopeA, content: 'External note says the recovery phrase is amber compass.', category: 'conversation', memoryType: 'fact', explicit: true, sourceType: 'agent', trustLevel: 'agent' });
assert.equal(duplicateAgent.duplicate, true);
assert.equal(memory.db.prepare('SELECT trust_level FROM memory_nodes WHERE id=?').get(untrusted.nodeId).trust_level, 'untrusted');
assert.equal(memory.getContext('recovery phrase amber compass', { scope: scopeA, limit: 5 }).items.some((item) => item.id === untrusted.nodeId), false);
const ownerApproval = memory.ingest({ scope: scopeA, content: 'External note says the recovery phrase is amber compass.', category: 'conversation', memoryType: 'fact', explicit: true, sourceType: 'user', trustLevel: 'owner', sourceReference: 'owner:approval' });
assert.equal(ownerApproval.duplicate, true);
assert.equal(memory.db.prepare('SELECT trust_level FROM memory_nodes WHERE id=?').get(untrusted.nodeId).trust_level, 'owner');
assert.equal(memory.getContext('recovery phrase amber compass', { scope: scopeA, limit: 5 }).items.some((item) => item.id === untrusted.nodeId), true);

memory.touchProject(scopeA, 'agent-miki');
assert.equal(memory.stats(scopeA).nodes >= 3, true);
assert.equal(memory.maintenance().dormantProjects, 0);
memory.closeProject(scopeA, 'agent-miki');
assert.equal(memory.maintenance().dormantProjects, 0);
assert.equal(memory.stats(scopeA).archived >= 0, true);


// Legacy graph schemas without trust_level migrate conservatively: user rows
// remain untrusted unless an owner approval marker exists, while agent rows are
// attributed to the internal agent. This exercises the migration on real SQLite.
const legacyDb = new Database(':memory:');
legacyDb.exec(`CREATE TABLE memory_nodes (
  id TEXT PRIMARY KEY, scope_key TEXT NOT NULL, agent_id TEXT NOT NULL, owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL, project_id TEXT, category_id TEXT NOT NULL, memory_type TEXT NOT NULL,
  content TEXT NOT NULL, structured_value TEXT, source_type TEXT, source_reference TEXT,
  fingerprint TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_accessed_at TEXT, access_count INTEGER NOT NULL DEFAULT 0,
  explicit_importance REAL NOT NULL DEFAULT 0.5, confidence REAL NOT NULL DEFAULT 0.7,
  semantic_relevance REAL NOT NULL DEFAULT 0, graph_relevance REAL NOT NULL DEFAULT 0,
  recency_score REAL NOT NULL DEFAULT 1, frequency_score REAL NOT NULL DEFAULT 0,
  relationship_strength REAL NOT NULL DEFAULT 0, activation_score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active', review_at TEXT, expires_at TEXT,
  is_pinned INTEGER NOT NULL DEFAULT 0, is_archived INTEGER NOT NULL DEFAULT 0,
  metadata TEXT NOT NULL DEFAULT '{}', embedding TEXT,
  UNIQUE(scope_key, fingerprint)
)`);
const legacyScopeKey = [scopeA.agentId, scopeA.ownerId, scopeA.workspaceId].map(encodeURIComponent).join(':');
legacyDb.prepare(`INSERT INTO memory_nodes(id,scope_key,agent_id,owner_id,workspace_id,category_id,memory_type,content,source_type,fingerprint,created_at,updated_at,metadata)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-user', legacyScopeKey, scopeA.agentId, scopeA.ownerId, scopeA.workspaceId, 'legacy-category', 'fact', 'Old user memory', 'user', 'legacy-user-fingerprint', new Date().toISOString(), new Date().toISOString(), '{}');
legacyDb.prepare(`INSERT INTO memory_nodes(id,scope_key,agent_id,owner_id,workspace_id,category_id,memory_type,content,source_type,fingerprint,created_at,updated_at,metadata)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-agent', legacyScopeKey, scopeA.agentId, scopeA.ownerId, scopeA.workspaceId, 'legacy-category', 'fact', 'Old agent memory', 'agent', 'legacy-agent-fingerprint', new Date().toISOString(), new Date().toISOString(), '{}');
legacyDb.prepare(`INSERT INTO memory_nodes(id,scope_key,agent_id,owner_id,workspace_id,category_id,memory_type,content,source_type,fingerprint,created_at,updated_at,metadata)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('legacy-malformed', legacyScopeKey, scopeA.agentId, scopeA.ownerId, scopeA.workspaceId, 'legacy-category', 'fact', 'Malformed metadata memory', 'user', 'legacy-malformed-fingerprint', new Date().toISOString(), new Date().toISOString(), '{invalid');
const migratedGraph = new GraphCognitiveMemory(legacyDb, { defaultScope: scopeA });
migratedGraph.initializeSync();
assert.equal(legacyDb.prepare('SELECT trust_level FROM memory_nodes WHERE id=?').get('legacy-user').trust_level, 'untrusted');
assert.equal(legacyDb.prepare('SELECT trust_level FROM memory_nodes WHERE id=?').get('legacy-agent').trust_level, 'agent');
assert.equal(legacyDb.prepare('SELECT trust_level FROM memory_nodes WHERE id=?').get('legacy-malformed').trust_level, 'untrusted');
// Existing trust values must survive subsequent startup. In particular, an
// explicitly-untrusted agent-sourced record must not be promoted by the legacy
// source-type backfill after trust_level has already been migrated.
const explicitlyUntrustedAgent = migratedGraph.ingest({
  scope: scopeA,
  content: 'Agent repeated an external instruction but it remains untrusted.',
  category: 'conversation',
  memoryType: 'fact',
  explicit: true,
  sourceType: 'agent',
  trustLevel: 'untrusted',
  sourceReference: 'test:explicitly-untrusted-agent',
});
assert.equal(explicitlyUntrustedAgent.stored, true);
assert.equal(legacyDb.prepare('SELECT trust_level FROM memory_nodes WHERE id=?').get(explicitlyUntrustedAgent.nodeId).trust_level, 'untrusted');
migratedGraph.initializeSync();
assert.equal(legacyDb.prepare('SELECT trust_level FROM memory_nodes WHERE id=?').get(explicitlyUntrustedAgent.nodeId).trust_level, 'untrusted');
assert.equal(migratedGraph.getContext('external instruction remains untrusted', { scope: scopeA, limit: 5 }).items.some((item) => item.id === explicitlyUntrustedAgent.nodeId), false);
legacyDb.close();

console.log(JSON.stringify({ ok: true, stats: memory.stats(scopeA), contextItems: context.items.length }));
