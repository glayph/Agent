import assert from 'node:assert/strict'
import { buildWorld, resolveModel, describeResolution, classifyFailure, j, row } from './common.mjs'
let pass = 0, fail = 0
const check = (name, fn) => { try { fn(); pass++; console.log('PASS', name) } catch (e) { fail++; console.log('FAIL', name, '\n   ', e.message.split('\n')[0]) } }

console.log('### A. Pure resolver, empty model_configs + empty env (what a fresh/unconfigured install has)')
const r = describeResolution(resolveModel([], undefined, {}))
console.log(j(r))
check('A1 resolver reports not configured with a concrete reason', () => { assert.equal(r.configured, false); assert.match(r.reason, /No model name is configured/) })

console.log('\n### B. Real engine + real supervisor, no model configured, one pending goal, shipped config/agent.yaml')
const w = buildWorld({})
w.goals.create({ title: 'Repro goal', description: 'write autonomy/hello.txt', priority: 5, replaceExisting: false })
w.db.prepare("UPDATE pursue_goals SET status='pending'").run()
const out = await w.supervisor.tick('manual')
console.log('tick outcome:', j(out))
const st = w.supervisor.status()
console.log('active_goal:', j(st.active_goal)); console.log('latest_run:', j(st.latest_run)); console.log('last_outcome:', j(st.last_outcome))
console.log('goal rows:', j(row(w.db, 'SELECT id,status,status_reason FROM pursue_goals')))
console.log('log tail:', w.logs.slice(-3))
check('B1 real run fails with the exact reported text', () => assert.match(String(st.latest_run?.error ?? ''), /No model is configured/))
check('B2 supervisor classifies it as no_provider (infra failure, retry budget not burned)', () => { assert.equal(classifyFailure(st.latest_run.error), 'no_provider'); assert.equal(st.latest_run.attempt, 1) })
check('B3 goal is NOT marked completed', () => assert.notEqual(row(w.db, 'SELECT status FROM pursue_goals')[0].status, 'completed'))

console.log('\n### C. Ambient (no-goal) decision with no model')
const w2 = buildWorld({})
const amb = await w2.supervisor.runAmbientDecision('startup')
console.log('ambient returned:', amb, '| failureStreak:', w2.supervisor.failureStreak, '| lastFailure:', j(w2.supervisor.lastFailure))
check('C1 ambient decision records no_provider failure instead of acting', () => { assert.equal(amb, false); assert.equal(w2.supervisor.lastFailure?.kind, 'no_provider') })
console.log(`\nSUMMARY pass=${pass} fail=${fail}`)
