import assert from 'node:assert/strict'
import fs from 'node:fs'; import path from 'node:path'
import { buildWorld, j, row } from './common.mjs'
import { startStub, kind, goalBrain, FIVE_STEP } from './stub-llm.mjs'
let pass = 0, fail = 0
const check = (name, fn) => { try { fn(); pass++; console.log('PASS', name) } catch (e) { fail++; console.log('FAIL', name, '\n   ->', (e.message || String(e)).split('\n')[0]) } }
const model = (url) => [{ isDefault: true, payload: { provider: 'openai-compatible', model: 'stub-model', model_name: 'stub-model', api_base: url, enabled: true } }]
const CONTRACT = { mode: 'all', checks: [{ type: 'file_contains', path: 'autonomy/out/report.txt', text: 'status: ok' }] }
const cfgWith = (w, autonomyPatch, heartbeatPatch) => { const c = structuredClone(w.cfg); Object.assign(c.autonomy, autonomyPatch); if (heartbeatPatch) Object.assign(c.heartbeat.auto_actions, heartbeatPatch); return c }
async function scenario(name, { brain, autonomy = {}, auto = undefined, contract = CONTRACT, spy = false }) {
  const stub = await startStub(brain)
  const w = buildWorld({ models: model(stub.url) })
  Object.assign(w.cfg.autonomy, autonomy); if (auto) Object.assign(w.cfg.heartbeat.auto_actions, auto)
  const seen = []; if (spy) { const orig = w.engine.run.bind(w.engine); w.engine.run = (req, ...r) => { seen.push(req); return orig(req, ...r) } }
  w.goals.create({ title: name, description: 'Create autonomy/out/report.txt', ...(contract ? { acceptance: contract } : {}), replaceExisting: false })
  const out = await w.supervisor.tick('manual'); const st = w.supervisor.status()
  const res = { out, goal: row(w.db, 'SELECT status FROM pursue_goals')[0].status, run: st.latest_run, seen, stub, w }
  console.log(`-- ${name}: tick=${out.status} goal=${res.goal} run=${st.latest_run?.status} err=${st.latest_run?.error ?? '-'} acceptance=${st.latest_run?.acceptance_result ? JSON.parse(st.latest_run.acceptance_result).passed : '-'}`)
  await stub.close(); return res
}
console.log('### T5a per-goal-cycle tool budget wiring')
{
  const a = await scenario('budget default (max_actions_per_cycle=1)', { brain: goalBrain(), auto: { max_actions_per_cycle: 1 }, spy: true })
  check('T5a default goal-cycle budget is 12, independent of max_actions_per_cycle=1', () => assert.equal(a.seen[0].maxToolCalls, 12))
  const b = await scenario('budget explicit 5', { brain: goalBrain(), autonomy: { max_tool_calls_per_goal_cycle: 5 }, spy: true })
  check('T5a explicit max_tool_calls_per_goal_cycle=5 is honoured', () => assert.equal(b.seen[0].maxToolCalls, 5))
  const c = await scenario('unlimited_budgets', { brain: goalBrain(), autonomy: { unlimited_budgets: true }, spy: true })
  check('T5a legacy unlimited_budgets cannot remove the tool-call cap', () => assert.equal(c.seen[0].maxToolCalls, 12))
}
console.log('\n### T5b completion verification at the budget limit (cap = 3 tool calls, goal needs 5)')
{
  const A = await scenario('limit + contract PASSES', { brain: goalBrain(), autonomy: { max_tool_calls_per_goal_cycle: 3 }, contract: { mode: 'all', checks: [{ type: 'file_contains', path: 'autonomy/out/report.txt', text: 'status: ok' }] } })
  check('T5b cap hit but independent acceptance passed (file written) -> completed', () => { assert.equal(A.run.error, 'Tool call budget of 3 reached.'); assert.equal(A.goal, 'completed') })
  const readOnly = goalBrain([{ name: 'workspace_list', args: {} }, { name: 'file_info', args: { path: 'identity' } }, { name: 'workspace_list', args: {} }, { name: 'workspace_list', args: {} }])
  const B = await scenario('limit + contract FAILS (nothing written)', { brain: readOnly, autonomy: { max_tool_calls_per_goal_cycle: 3 } })
  check('T5b cap hit and acceptance fails -> NOT completed', () => assert.notEqual(B.goal, 'completed'))
  const C = await scenario('limit + NO contract (legacy mode)', { brain: goalBrain(), autonomy: { max_tool_calls_per_goal_cycle: 3 }, contract: null })
  check('T5b cap hit without any contract -> NOT completed (no evidence)', () => assert.notEqual(C.goal, 'completed'))
}
console.log('\n### T5c the model claims DONE but did nothing')
{
  const D = await scenario('liar model', { brain: () => ({ content: 'DONE: report written.' }) })
  check('T5c model text alone cannot complete a goal that has a deterministic contract', () => { assert.notEqual(D.goal, 'completed'); assert.equal(JSON.parse(D.run.acceptance_result).passed, false) })
  check('T5c nothing is on disk', () => assert.equal(fs.existsSync(path.join(D.w.workspace, 'autonomy/out/report.txt')), false))
}
console.log('\n### T5d idle decision where the model answers in plain text (does not call the tool)')
{
  const stub = await startStub((req) => kind(req) === 'ambient' ? { content: 'I would write a report.' } : { content: 'Acknowledged.' })
  const w = buildWorld({ models: model(stub.url) })
  await w.supervisor.runAmbientDecision('startup')
  console.log('goals:', row(w.db, 'SELECT COUNT(*) c FROM pursue_goals')[0].c, '| log:', w.logs.filter((l) => /finished inline work/.test(l)))
  check('T5d no goal is invented and the gap is logged explicitly', () => { assert.equal(row(w.db, 'SELECT COUNT(*) c FROM pursue_goals')[0].c, 0); assert.ok(w.logs.some((l) => /finished inline work/.test(l))) })
  await stub.close()
}
console.log('\n### T5e first run on an empty install: the startup decision creates the environment-exploration goal itself')
{
  const stub = await startStub(() => ({ content: 'Acknowledged.' }))
  const w = buildWorld({ models: model(stub.url), emptyMemory: true })
  const queued = await w.supervisor.runAmbientDecision('startup')
  const goal = row(w.db, 'SELECT title, source, priority, acceptance_contract FROM pursue_goals')[0]
  console.log('queued:', queued, '| goal:', goal && { title: goal.title, source: goal.source, priority: goal.priority })
  check('T5e bootstrap goal created server-side (no model call needed)', () => { assert.equal(queued, true); assert.equal(goal.source, 'drive'); assert.equal(goal.priority, 9); assert.ok(JSON.parse(goal.acceptance_contract).checks.some((c) => c.type === 'file_exists' && c.path === 'identity/memory/environment.md')) })
  await stub.close()
}
console.log(`\nSUMMARY T5: pass=${pass} fail=${fail}`)
