import assert from 'node:assert/strict'
import fs from 'node:fs'; import path from 'node:path'
import { buildWorld, j, row } from './common.mjs'
import { startStub, kind, goalBrain, toolCount, FIVE_STEP } from './stub-llm.mjs'
let pass = 0, fail = 0
const check = (name, fn) => { try { fn(); pass++; console.log('PASS', name) } catch (e) { fail++; console.log('FAIL', name, '\n   ->', (e.message || String(e)).split('\n')[0]) } }
const model = (url) => [{ isDefault: true, payload: { provider: 'openai-compatible', model: 'stub-model', model_name: 'stub-model', api_base: url, enabled: true } }]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PROPOSAL = { title: 'Write verified status report', description: 'Create autonomy/out/report.txt containing "status: ok" and read it back.', priority: 5,
  acceptance: { mode: 'all', checks: [{ type: 'file_contains', path: 'autonomy/out/report.txt', text: 'status: ok' }] } }

// ======================= T4a: the real 24/7 loop, NO user message anywhere =======================
console.log('### T4a live loop (supervisor.start()): no user message, no goal, no task at the start')
{
  let proposed = false
  const brain = goalBrain()
  const stub = await startStub((req) => {
    const k = kind(req)
    if (k === 'ambient') {
      if (toolCount(req) === 0) { if (proposed) return { content: 'NO_ACTION' }; proposed = true; return { tool_calls: [{ name: 'autonomy_propose_goal', args: PROPOSAL }] } }
      return { content: 'Queued a verified report goal.' }
    }
    if (k === 'goal') return brain(req)
    return { content: 'NO_ACTION' }
  })
  const w = buildWorld({ models: model(stub.url) })
  const before = { goals: row(w.db, 'SELECT COUNT(*) c FROM pursue_goals')[0].c, tasks: row(w.db, 'SELECT COUNT(*) c FROM autonomy_task_queue')[0].c, userMsgs: row(w.db, "SELECT COUNT(*) c FROM chat_messages WHERE role='user'")[0].c }
  console.log('before:', j(before))
  w.supervisor.start()
  const t0 = Date.now(); let st
  while (Date.now() - t0 < 45_000) { await sleep(500); st = w.supervisor.status(); if (st.last_outcome?.status === 'completed') break }
  await w.supervisor.stop()
  console.log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  console.log('active_goal:', j(st.active_goal)); console.log('task_queue:', j(st.task_queue)); console.log('last_outcome:', j(st.last_outcome))
  console.log('latest_run:', j({ run_id: st.latest_run?.run_id, status: st.latest_run?.status, attempt: st.latest_run?.attempt, error: st.latest_run?.error, acceptance_result: st.latest_run?.acceptance_result }))
  console.log('goal row:', j(row(w.db, 'SELECT id,title,status,progress,source FROM pursue_goals')))
  const kinds = stub.requests.reduce((a, r) => (a[r.tools.includes('autonomy_propose_goal') ? 'ambient' : r.tools.length ? 'goal' : 'other'] = (a[r.tools.includes('autonomy_propose_goal') ? 'ambient' : r.tools.length ? 'goal' : 'other'] || 0) + 1, a), {})
  console.log('model calls by phase:', j(kinds), '| total', stub.requests.length)
  console.log('heartbeat cycle:', j(row(w.db, 'SELECT probe_ok,probe_detail FROM autonomy_heartbeat_cycles ORDER BY rowid DESC LIMIT 1')))
  console.log('notifications:', w.notes.map((n) => `[${n.kind}] ${n.text.slice(0, 90)}`))
  const report = path.join(w.workspace, 'autonomy/out/report.txt')
  console.log('artifact on disk:', fs.existsSync(report) ? JSON.stringify(fs.readFileSync(report, 'utf8')) : 'MISSING')
  console.log('runtime log:', w.logs.filter((l) => /Autonomy cycle|Proactive|provider failure|Ambient/.test(l)))
  check('T4a loop created its own goal with no user input', () => { assert.equal(before.userMsgs, 0); assert.equal(row(w.db, 'SELECT source FROM pursue_goals')[0].source, 'ambient_proposal') })
  check('T4a goal executed with real tool calls (artifact exists on disk)', () => assert.equal(fs.readFileSync(report, 'utf8'), 'status: ok\n'))
  check('T4a completion was acceptance-verified (not just model text)', () => { assert.equal(row(w.db, 'SELECT status FROM pursue_goals')[0].status, 'completed'); assert.equal(JSON.parse(st.latest_run.acceptance_result).passed, true) })
  check('T4a last_outcome = completed, attempt = 1, no error', () => { assert.equal(st.last_outcome.status, 'completed'); assert.equal(st.latest_run.attempt, 1); assert.equal(st.latest_run.error, null) })
  check('T4a heartbeat probe saw a ready model', () => assert.equal(row(w.db, 'SELECT probe_ok FROM autonomy_heartbeat_cycles ORDER BY rowid DESC LIMIT 1')[0].probe_ok, 1))
  await stub.close()
}

// ======================= T4b: proposal tool guard rails + policy =======================
console.log('\n### T4b proposal tool: validation, de-dup, caps; policy not weakened')
{
  const stub = await startStub(() => ({ content: 'NO_ACTION' }))
  const w = buildWorld({ models: model(stub.url) })
  const cfg = w.supervisor.config()
  const mk = () => { const proposals = []; return { proposals, tool: w.supervisor.buildProposeGoalTool(cfg, proposals) } }
  const ok = (p) => ({ ...PROPOSAL, ...p })
  const bad = (name, input, re) => check(name, () => assert.throws(() => mk().tool.execute(input), re))
  bad('T4b rejects acceptance path outside safe roots (../)', ok({ acceptance: { checks: [{ type: 'file_exists', path: '../etc/passwd' }] } }), /safe write roots/)
  bad('T4b rejects absolute acceptance path', ok({ acceptance: { checks: [{ type: 'file_exists', path: '/etc/passwd' }] } }), /safe write roots/)
  bad('T4b rejects path in workspace but outside safe roots', ok({ acceptance: { checks: [{ type: 'file_exists', path: 'packages/core/x.ts' }] } }), /safe write roots/)
  bad('T4b rejects empty acceptance (no unverifiable goals)', ok({ acceptance: { checks: [] } }), /at least one/)
  bad('T4b rejects http_status check type (no network checks from idle decisions)', ok({ acceptance: { checks: [{ type: 'http_status', url: 'http://x' }] } }), /Unsupported/)
  bad('T4b rejects tool_called for unknown tool', ok({ acceptance: { checks: [{ type: 'tool_called', name: 'nope' }] } }), /registered tool/)
  const first = mk(); const r1 = first.tool.execute(ok({}))
  check('T4b valid proposal creates an ACTIVE goal with the contract stored', () => { assert.equal(r1.created, true); const g = row(w.db, 'SELECT status,acceptance_contract,source FROM pursue_goals WHERE id=?', r1.goal_id)[0]; assert.equal(g.source, 'ambient_proposal'); assert.equal(JSON.parse(g.acceptance_contract).checks[0].type, 'file_contains') })
  check('T4b duplicate title is ignored (no flood)', () => { const r = mk().tool.execute(ok({ title: '  WRITE verified   status REPORT ' })); assert.equal(r.created, false) })
  mk().tool.execute(ok({ title: 'Second distinct goal' })); mk().tool.execute(ok({ title: 'Third distinct goal' }))
  check('T4b 4th open proposal is refused (cap 3)', () => assert.throws(() => mk().tool.execute(ok({ title: 'Fourth distinct goal' })), /limit 3/))
  w.db.prepare("UPDATE pursue_goals SET status='completed'").run()
  for (let i = 0; i < 7; i++) w.db.prepare("INSERT INTO pursue_goals(title,status,source,created_at,updated_at) VALUES(?,?,?,?,?)").run('old ' + i, 'completed', 'ambient_proposal', new Date().toISOString(), new Date().toISOString())
  check('T4b daily cap (10/24h) is enforced', () => assert.throws(() => mk().tool.execute(ok({ title: 'Eleventh goal today' })), /Daily proposal limit/))
  const { AutonomyPolicy } = await import(`file://${process.env.MIKI_SRC || new URL('../../', import.meta.url).pathname}/packages/core/src/autonomy/autonomy-policy.ts`)
  const pol = new AutonomyPolicy({ capabilityProfile: 'safe', safeWriteRoots: ['autonomy', 'identity/memory'] })
  check('T4b policy: generic goal_create STILL blocked in the safe profile', () => assert.equal(pol.decide({ name: 'goal_create', risk: 'config_write', approval: 'required' }, {}).mode, 'block'))
  check('T4b policy: terminal_run STILL blocked in the safe profile', () => assert.equal(pol.decide({ name: 'terminal_run', risk: 'destructive' }, {}).mode, 'block'))
  check('T4b policy: file_write outside safe roots STILL blocked', () => assert.equal(pol.decide({ name: 'file_write', risk: 'config_write' }, { path: 'src/evil.ts', content: 'x' }).mode, 'block'))
  await stub.close()
}

// ======================= T4c: provider failure is not a goal failure; recovery completes it =======================
console.log('\n### T4c provider outage (401, then 500) must not burn retries or fake success; recovery then completes')
{
  let mode = 401; const ok = goalBrain()
  const stub = await startStub((req) => mode === 200 ? ok(req) : { status: mode, error: mode === 401 ? 'Incorrect API key provided' : 'upstream overloaded' })
  const w = buildWorld({ models: model(stub.url) })
  w.goals.create({ title: 'Outage goal', description: 'Create autonomy/out/report.txt', acceptance: { mode: 'all', checks: [{ type: 'file_contains', path: 'autonomy/out/report.txt', text: 'status: ok' }] }, replaceExisting: false })
  const clearBackoff = () => { w.db.prepare('UPDATE autonomy_goal_runs SET next_retry_at=NULL').run(); w.supervisor.circuitOpen = false }
  const o1 = await w.supervisor.tick('manual'); const s1 = w.supervisor.status()
  console.log('401 ->', j({ tick: o1.status, run: s1.latest_run.status, attempt: s1.latest_run.attempt, lastFailure: w.supervisor.lastFailure?.kind }))
  check('T4c 401 classified as auth; goal not completed; attempt not burned', () => { assert.equal(w.supervisor.lastFailure.kind, 'auth'); assert.notEqual(row(w.db, 'SELECT status FROM pursue_goals')[0].status, 'completed'); assert.equal(s1.latest_run.attempt, 1) })
  mode = 500; clearBackoff(); await w.supervisor.tick('manual'); const s2 = w.supervisor.status()
  console.log('500 ->', j({ run: s2.latest_run.status, attempt: s2.latest_run.attempt, lastFailure: w.supervisor.lastFailure?.kind, error: s2.latest_run.error }))
  check('T4c 500 classified provider_error (infra), attempt still not burned', () => { assert.equal(w.supervisor.lastFailure.kind, 'provider_error'); assert.ok(s2.latest_run.attempt <= 1) })
  mode = 200; clearBackoff(); const o3 = await w.supervisor.tick('manual'); const s3 = w.supervisor.status()
  console.log('recovered ->', j({ tick: o3.status, goal: row(w.db, 'SELECT status FROM pursue_goals')[0].status, acceptance: JSON.parse(s3.latest_run.acceptance_result).passed }))
  check('T4c after the provider recovers the SAME goal completes, acceptance-verified', () => { assert.equal(o3.status, 'completed'); assert.equal(JSON.parse(s3.latest_run.acceptance_result).passed, true) })
  await stub.close()
}
console.log(`\nSUMMARY T4: pass=${pass} fail=${fail}`)
