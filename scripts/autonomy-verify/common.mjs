import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url'
import { openDb } from './db.mjs'
export const SRC = process.env.MIKI_SRC || fileURLToPath(new URL('../../', import.meta.url))
const P = (p) => `file://${SRC}/${p}`
const { AgentEngine } = await import(P('packages/core/src/engine/agent-engine.ts'))
const { ToolRegistry } = await import(P('packages/core/src/engine/tool-registry.ts'))
const { createFetchLLMClient } = await import(P('packages/core/src/engine/llm-client.ts'))
const { createWorkspaceTools, createMemoryTools } = await import(P('packages/core/src/engine/builtin-tools.ts'))
const { createFileManagementTools } = await import(P('packages/core/src/engine/file-tools.ts'))
const { GoalStore, createGoalTools } = await import(P('packages/core/src/api/goals-router.ts'))
const sup = await import(P('packages/core/src/autonomy/autonomous-supervisor.ts'))
const mr = await import(P('packages/gateway/src/model-resolution.ts'))
export const { AutonomousSupervisor, classifyFailure } = sup
export const { resolveModel, describeResolution } = mr
export { GoalStore }

export const GATEWAY_SQL = `
CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', model_name TEXT, context_id TEXT, image_urls TEXT, attachments_json TEXT);
CREATE TABLE IF NOT EXISTS model_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memory_chunks (id TEXT PRIMARY KEY, region TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL, provenance TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1, importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);`

/** Builds the real engine + real supervisor, wired like gateway/index.ts + agent-runtime.ts. Only the model endpoint is injectable. */
export function buildWorld({ models = [], config, env = {}, fetchImpl, emptyMemory = false } = {}) {
  for (const k of Object.keys(process.env)) if (/^(MIKI_(MODEL|PROVIDER|LLAMA)|OPENAI|GEMINI|OPENROUTER|GOOGLE_API)/.test(k)) delete process.env[k]
  Object.assign(process.env, env)
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'miki-h-')))
  fs.cpSync(path.join(SRC, 'identity'), path.join(workspace, 'identity'), { recursive: true })
  fs.mkdirSync(path.join(workspace, 'autonomy'), { recursive: true })
  const db = openDb(); db.exec(GATEWAY_SQL)
  // An install in use already has memory; only a brand-new install (emptyMemory) triggers the first-run bootstrap goal.
  if (!emptyMemory) { const t = new Date().toISOString(); db.prepare("INSERT INTO memory_chunks(id,region,content,summary,provenance,created_at,updated_at) VALUES('seed','long_term','seed','seed','user',?,?)").run(t, t) }
  const ins = db.prepare('INSERT INTO model_configs(payload,is_default,created_at,updated_at) VALUES(?,?,?,?)')
  for (const m of models) ins.run(JSON.stringify(m.payload), m.isDefault ? 1 : 0, new Date().toISOString(), new Date().toISOString())
  const storedModels = () => db.prepare('SELECT id,payload,is_default FROM model_configs ORDER BY id').all().map((r) => ({ payload: JSON.parse(r.payload), isDefault: r.is_default === 1 }))
  const llmCalls = []
  // identical to agent-runtime.ts llmFor (minus extra_body)
  const llmFor = (requested) => {
    const r = resolveModel(storedModels(), requested)
    if (!r.configured) return undefined
    return createFetchLLMClient({ baseUrl: r.baseUrl, model: r.model, apiKey: r.apiKey || undefined, retries: 0, ...(fetchImpl ? { fetchImpl: (...a) => { llmCalls.push(a[0]); return fetchImpl(...a) } } : {}) })
  }
  const goals = new GoalStore(db)
  const registry = new ToolRegistry()
  const memoryPort = {
    search: (q, limit) => db.prepare('SELECT id,summary,content,region FROM memory_chunks ORDER BY importance DESC LIMIT ?').all(limit).map((r) => ({ id: r.id, text: r.summary || r.content, region: r.region, score: 1 })),
    add: (e) => { const id = 'm' + Date.now() + Math.random().toString(16).slice(2, 6); const t = new Date().toISOString(); db.prepare('INSERT INTO memory_chunks(id,region,content,summary,provenance,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, e.region || 'long_term', e.content, e.summary || e.content.slice(0, 160), 'agent', t, t); return { id } },
  }
  for (const t of [...createWorkspaceTools({ root: () => workspace, restrictToWorkspace: () => true }), ...createFileManagementTools({ root: () => workspace, restrictToWorkspace: () => true }), ...createMemoryTools(memoryPort), ...createGoalTools(goals)]) registry.register(t, { replace: true })
  const engine = new AgentEngine({ llm: llmFor, describeNoModel: (m) => resolveModel(storedModels(), m).reason, tools: registry, turboMode: true })
  const logs = [], notes = []
  const cfg = structuredClone(config || JSON.parse(fs.readFileSync(new URL('./agent-config.json', import.meta.url), 'utf8')))
  const supervisor = new AutonomousSupervisor({
    db, agent: engine, tools: registry, getConfig: () => cfg, log: (m) => logs.push(m), workspaceRoot: workspace,
    notify: (n) => { notes.push(n) },
    heartbeatProbe: () => { const m = llmFor(); return m ? { ok: true, detail: `LLM provider ready: ${m.model}` } : { ok: false, detail: 'No LLM provider is currently ready.' } },
  })
  return { db, engine, supervisor, registry, goals, logs, notes, cfg, workspace, llmFor, storedModels, llmCalls }
}
export const j = (v) => JSON.stringify(v, null, 1)
export const row = (db, sql, ...a) => db.prepare(sql).all(...a)
