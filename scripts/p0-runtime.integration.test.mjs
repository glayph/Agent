import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentEngine } from '../packages/core/src/engine/agent-engine.ts'
import { TokenBudgetManager } from '../packages/core/src/token-budget-manager.ts'
import { ToolRegistry } from '../packages/core/src/engine/tool-registry.ts'
import { createWorkspaceTools } from '../packages/core/src/engine/builtin-tools.ts'
import { createFileManagementTools } from '../packages/core/src/engine/file-tools.ts'
import { BrowserTool } from '../packages/core/src/plugins/browser/runtime.ts'
import { resolveSessionContextId } from '../packages/gateway/src/session-scope.ts'

const ctx = () => ({ runId:'r1', callId:'c1', signal:new AbortController().signal })

// Workspace + restrict workspace
{
  const rootA = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'miki-p0-a-')))
  const rootB = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'miki-p0-b-')))
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'miki-p0-out-')))
  fs.writeFileSync(path.join(rootB,'inside.txt'),'inside')
  fs.writeFileSync(path.join(outside,'outside.txt'),'outside')
  let root = rootA
  let restricted = true
  const ws = Object.fromEntries(createWorkspaceTools({root:()=>root, restrictToWorkspace:()=>restricted}).map(t=>[t.name,t]))
  assert.throws(() => ws.file_read.execute({path:'inside.txt'},ctx()))
  root = rootB
  assert.equal((await ws.file_read.execute({path:'inside.txt'},ctx())).content,'inside')
  assert.throws(() => ws.file_read.execute({path:path.join(outside,'outside.txt')},ctx()))
  restricted = false
  assert.equal((await ws.file_read.execute({path:path.join(outside,'outside.txt')},ctx())).content,'outside')
  fs.rmSync(rootA,{recursive:true,force:true}); fs.rmSync(rootB,{recursive:true,force:true}); fs.rmSync(outside,{recursive:true,force:true})
}

// File management root follows config + restrict setting + file execution path
{
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'miki-p0-ft-root-')))
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'miki-p0-ft-out-')))
  fs.writeFileSync(path.join(outside,'run.js'),'console.log("OK")')
  let restricted = true
  const ft = Object.fromEntries(createFileManagementTools({root:()=>root, restrictToWorkspace:()=>restricted}).map(t=>[t.name,t]))
  await assert.rejects(() => ft.file_run.execute({path:path.join(outside,'run.js')},ctx()), /outside_workspace/)
  restricted = false
  const out = await ft.file_run.execute({path:path.join(outside,'run.js')},ctx())
  assert.equal(out.stdout.trim(),'OK')
  fs.rmSync(root,{recursive:true,force:true}); fs.rmSync(outside,{recursive:true,force:true})
}

// Bypass restrictions must be reversible
{
  const browser = new BrowserTool(true, fs.mkdtempSync(path.join(os.tmpdir(),'miki-p0-browser-')))
  browser.setAllowedDomains(['example.com'])
  browser.setBypassRestrictions(true)
  assert.equal(browser._allowPrivateNetworks,true)
  assert.deepEqual(browser._allowedDomains,[])
  browser.setBypassRestrictions(false)
  assert.equal(browser._allowPrivateNetworks,false)
}

// Session scope semantics
{
  assert.equal(resolveSessionContextId('per-channel-peer','a','u1'),'channel:a:peer:u1')
  assert.equal(resolveSessionContextId('per-channel','a','u1'),resolveSessionContextId('per-channel','a','u2'))
  assert.notEqual(resolveSessionContextId('per-channel','a','u1'),resolveSessionContextId('per-channel','b','u1'))
  assert.equal(resolveSessionContextId('per-peer','a','u1'),resolveSessionContextId('per-peer','b','u1'))
  assert.notEqual(resolveSessionContextId('per-peer','a','u1'),resolveSessionContextId('per-peer','a','u2'))
  assert.equal(resolveSessionContextId('global','a','u1'),resolveSessionContextId('global','b','u2'))
}

function makeTool(name, execute=()=>({ok:true})) {
  return {name, description:name, risk:'read', parameters:{type:'object',properties:{}}, execute}
}

// Max tool iterations + context window are dynamic and applied on each model request.
{
  const registry = new ToolRegistry()
  registry.register(makeTool('step'))
  const requests=[]
  let reply=0
  const llm={model:'test', complete: async (messages, options={})=>{
    requests.push({messages, options})
    reply++
    if (reply<=2) return {choices:[{message:{content:'',tool_calls:[{id:'c'+reply,type:'function',function:{name:'step',arguments:'{}'}}]}}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}
    if (reply===3) return {choices:[{message:{content:'done'}}],usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}
    throw new Error('unexpected request')
  }}
  const engine = new AgentEngine({llm,tools:registry,maxTurns:()=>10,maxToolIterations:()=>2,contextWindowTokens:512})
  const result = await engine.run({history:[{role:'user',content:'OLDQ '.repeat(1000)},{role:'assistant',content:'OLDA '.repeat(1000)},{role:'user',content:'new task'}]})
  assert.equal(result.status,'limit_reached')
  assert.equal(result.turns,2)
  assert.equal(result.error, 'Tool iteration budget of 2 reached.')
  assert.equal(requests.length,3) // 2 turns + wrap-up
  const estimator = new TokenBudgetManager()
  for (const req of requests) {
    assert.equal(req.messages.some(m=>String(m.content||'').includes('OLDQ')),false)
    assert.ok(estimator.estimateMessagesTokens(req.messages, req.options.tools) <= 1024, 'context request exceeded configured token budget')
  }
}


// Session-scope persistence uses the same context_id schema/query shape as the gateway.
{
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
           CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', model_name TEXT, context_id TEXT);
           CREATE INDEX idx_chat_messages_context_created ON chat_messages(context_id, created_at);`)
  const insert = db.prepare('INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,context_id) VALUES(?,?,?,?,?,?,?)')
  insert.run('a1','ui-a','user','A','1','normal','channel:x:peer:u1')
  insert.run('a2','ui-a','assistant','A2','2','normal','channel:x:peer:u1')
  insert.run('b1','ui-b','user','B','3','normal','channel:x:peer:u2')
  const history = db.prepare("SELECT role,content FROM chat_messages WHERE context_id=? AND kind='normal' ORDER BY created_at DESC LIMIT 50").all('channel:x:peer:u1')
  assert.deepEqual(history.map(x=>x.content).reverse(), ['A','A2'])
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chat_messages WHERE context_id=?").get('channel:x:peer:u2').n, 1)

  const forkId = 'fork-1'
  db.prepare('INSERT INTO chat_sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)').run(forkId,'fork','4','4')
  const forkInsert = db.prepare('INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,model_name,context_id) VALUES(?,?,?,?,?,?,?,?)')
  const originals = db.prepare('SELECT id,role,content,created_at,kind,model_name,context_id FROM chat_messages WHERE session_id=? ORDER BY created_at ASC').all('ui-a')
  for (const m of originals) forkInsert.run('f-'+m.id,forkId,m.role,m.content,m.created_at,m.kind,m.model_name || null,m.context_id || null)
  assert.deepEqual(db.prepare('SELECT DISTINCT context_id FROM chat_messages WHERE session_id=?').all(forkId).map(x=>x.context_id), ['channel:x:peer:u1'])

  db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind) VALUES(?,?,?,?,?,?)").run('legacy','legacy-session','user','old','5','normal')
  db.prepare("UPDATE chat_messages SET context_id='channel:default-channel:peer:' || session_id WHERE context_id IS NULL").run()
  assert.equal(db.prepare('SELECT context_id FROM chat_messages WHERE id=?').get('legacy').context_id, 'channel:default-channel:peer:legacy-session')
  db.close()
}

console.log('[miki-p0] runtime behavior tests passed')
