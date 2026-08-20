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

const preference = memory.ingest({ scope: scopeA, content: 'The user prefers concise Bengali answers.', category: 'personality', memoryType: 'preference', explicit: true, confidence: 0.95, explicitImportance: 0.9, sourceReference: 'test:preference' });
assert.equal(preference.stored, true);
assert.equal(memory.ingest({ scope: scopeA, content: 'The user prefers concise Bengali answers.', category: 'personality', memoryType: 'preference', explicit: true }).duplicate, true);
assert.equal(memory.ingest({ scope: scopeA, content: 'The user prefers concise Bengali answers.', category: 'personality', memoryType: 'preference', explicit: true }).nodeId, preference.nodeId);

const projectFact = memory.ingest({ scope: scopeA, projectId: 'agent-miki', content: 'Agent Miki uses Gemini as the default model.', category: 'project_context', memoryType: 'decision', explicit: true, sourceReference: 'test:model' });
const procedure = memory.ingest({ scope: scopeA, projectId: 'agent-miki', content: 'Build the frontend before deploying the runtime dist directory.', category: 'procedural', memoryType: 'workflow', explicit: true, sourceReference: 'test:workflow' });
assert.equal(projectFact.stored, true);
assert.equal(procedure.stored, true);
assert.equal(memory.connect(scopeA, projectFact.nodeId, procedure.nodeId, 'RELATED_TO', { weight: 0.8 }), memory.connect(scopeA, projectFact.nodeId, procedure.nodeId, 'RELATED_TO', { weight: 0.8 }));

const context = memory.getContext('Gemini default model', { scope: scopeA, limit: 5, maxTokens: 100 });
assert.ok(context.text.includes('Gemini'));
assert.ok(context.items.length >= 1);
assert.ok(context.items.every((item) => !/api[_ -]?key|password|secret/i.test(item.text)));

const isolated = memory.getContext('Gemini default model', { scope: scopeB, limit: 5 });
assert.equal(isolated.items.length, 0);

const redacted = memory.ingest({ scope: scopeA, content: 'Temporary credential api_key=sk-test-secret-value must never persist.', category: 'conversation', explicit: true, sourceReference: 'test:redaction' });
const storedRedacted = new Database(dbPath).prepare('SELECT content FROM memory_nodes WHERE id = ?').get(redacted.nodeId);
assert.ok(storedRedacted.content.includes('[REDACTED]'));

memory.touchProject(scopeA, 'agent-miki');
assert.equal(memory.stats(scopeA).nodes >= 3, true);
assert.equal(memory.maintenance().dormantProjects, 0);
memory.closeProject(scopeA, 'agent-miki');
assert.equal(memory.maintenance().dormantProjects, 0);
assert.equal(memory.stats(scopeA).archived >= 0, true);

console.log(JSON.stringify({ ok: true, stats: memory.stats(scopeA), contextItems: context.items.length }));
