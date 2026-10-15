import assert from 'node:assert/strict'
import fs from 'node:fs'; import path from 'node:path'
import { buildWorld, j, row } from './common.mjs'
import { startStub, kind, goalBrain, firstUser } from './stub-llm.mjs'
const label = process.env.MIKI_SRC?.includes('orig') ? 'BASELINE (unmodified source)' : 'FIXED source'
let pass = 0, fail = 0
const check = (name, fn) => { try { fn(); pass++; console.log('PASS', name) } catch (e) { fail++; console.log('FAIL', name, '\n   ->', e.message.split('\n')[0]) } }
const ACCEPT = { mode: 'all', checks: [{ type: 'file_contains', path: 'autonomy/out/report.txt', text: 'status: ok' }] }
const model = (url) => [{ isDefault: true, payload: { provider: 'openai-compatible', model: 'stub-model', model_name: 'stub-model', api_base: url, enabled: true } }]
console.log(`##### ${label}\n`)

// ---- T2a: queued goal with deterministic acceptance contract needs 5 tool calls
{
  console.log('### T2a goal needing 5 tool calls (acceptance: report.txt contains "status: ok")')
  const stub = await startStub(goalBrain())
  const w = buildWorld({ models: model(stub.url) })
  w.goals.create({ title: 'Write verified report', description: 'Create autonomy/out/report.txt', acceptance: ACCEPT, replaceExisting: false })
  w.db.prepare("UPDATE pursue_goals SET status='pending'").run()
  const out = await w.supervisor.tick('manual')
  const st = w.supervisor.status()
  console.log('tick:', j(out)); console.log('latest_run:', j({ status: st.latest_run?.status, attempt: st.latest_run?.attempt, error: st.latest_run?.error, acceptance: st.latest_run?.acceptance_result })); console.log('goal:', j(row(w.db, 'SELECT id,status,progress,status_reason FROM pursue_goals')))
  console.log('model calls:', stub.requests.length, '| file exists:', fs.existsSync(path.join(w.workspace, 'autonomy/out/report.txt')))
  check('T2a goal completed in ONE cycle with acceptance verified', () => { assert.equal(out.status, 'completed'); assert.equal(row(w.db, 'SELECT status FROM pursue_goals')[0].status, 'completed') })
  await stub.close()
}

// ---- T2b: no goal at all -> ambient decision. Can the model turn its idea into a goal?
{
  console.log('\n### T2b no active goal: ambient decision proposes work')
  const stub = await startStub((req) => kind(req) === 'ambient' ? { content: 'I found useful work: write autonomy/out/report.txt with a status line.' } : { content: 'NO_ACTION' })
  const w = buildWorld({ models: model(stub.url) })
  const acted = await w.supervisor.runAmbientDecision('startup')
  const ambientReq = stub.requests.find((r) => r.tools.length)
  console.log('ambient returned actionable:', acted, '| tools offered to model:', ambientReq?.tools.join(','))
  console.log('pursue_goals rows:', row(w.db, 'SELECT COUNT(*) c FROM pursue_goals')[0].c, '| proactive notifications:', w.notes.length)
  const t = await w.supervisor.tick('heartbeat')
  console.log('next tick:', j(t))
  check('T2b model was offered a way to create a goal (goal_create or equivalent)', () => assert.ok(ambientReq?.tools.some((n) => /goal_create|propose_goal/.test(n)), `tools offered: ${ambientReq?.tools.join(',')}`))
  // NOTE: this stub answers in plain text and never calls the tool, so no goal is expected here; goal creation through the tool is covered end-to-end in t4.
  await stub.close()
}

// ---- T2c: operator-queued task through the task queue
{
  console.log('\n### T2c task_queue entry -> goal -> execution')
  const stub = await startStub(goalBrain())
  const w = buildWorld({ models: model(stub.url) })
  const task = w.supervisor.enqueueTask({ title: 'Queued report task', description: 'Create autonomy/out/report.txt', acceptance: ACCEPT })
  const out = await w.supervisor.tick('manual')
  const st = w.supervisor.status()
  console.log('tick:', j(out)); console.log('task_queue:', j(st.task_queue.map((t) => ({ id: t.task_id, status: t.status, retry_count: t.retry_count, last_error: t.last_error }))))
  check('T2c queued task completed with acceptance verified', () => { assert.equal(out.status, 'completed'); assert.equal(st.task_queue[0].status, 'completed') })
  await stub.close()
}
console.log(`\nSUMMARY ${label}: pass=${pass} fail=${fail}`)
