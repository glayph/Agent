import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const supervisor = fs.readFileSync(`${root}/packages/core/src/autonomy/autonomous-supervisor.ts`, 'utf8');
const gw = fs.readFileSync(`${root}/packages/gateway/src/index.ts`, 'utf8');
const runtime = fs.readFileSync(`${root}/packages/gateway/src/agent-runtime.ts`, 'utf8');
const config = fs.readFileSync(`${root}/config/agent.yaml`, 'utf8');

const legacyFastChat = ['FAST', '_CHAT'].join('');
const legacyLayered = ['Layered', 'Orchestrator'].join('');
const legacyRoute = ['route', 'Message'].join('');
const legacyEvent = ['Layered', 'Event'].join('');
const legacyNamespace = ['orchestrator', '.'].join('');
assert.equal(gw.includes(legacyFastChat), false);
assert.equal(gw.includes(legacyLayered), false);
assert.equal(gw.includes(legacyRoute), false);
assert.equal(runtime.includes(legacyEvent), false);
assert.equal(supervisor.includes(legacyLayered), false);
assert.equal(supervisor.includes(legacyNamespace), false);
assert.match(gw, /agent\.startRun\(/);
assert.match(gw, /const autonomy = new AutonomousSupervisor\(/);
assert.match(gw, /agent: agent\.engine/);
assert.match(supervisor, /this\.options\.agent\.run\(/);
assert.match(supervisor, /plan: false/);
assert.match(supervisor, /start\(\): void/);
assert.match(supervisor, /while \(this\.running/);
assert.match(supervisor, /idleBackoffMultiplier/);
assert.match(supervisor, /notify\?\./);
assert.match(gw, /proactive\.message/);
assert.match(config, /startup_decision: true/);
assert.match(config, /capability_profile: operator/);
assert.match(config, /terminal_run/);
assert.doesNotMatch(config, /agents:\n(?:[\s\S]*?)router:/);

console.log('STATIC_ARCHITECTURE_AUDIT_OK');
