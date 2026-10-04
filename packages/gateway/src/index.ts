import express from "express"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync, statSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync as makeDirSync, rmSync, renameSync, copyFileSync } from "node:fs"
import os from "node:os"
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto"
import Database from "better-sqlite3"
import { WebSocketServer, type WebSocket } from "ws"
import { createAgentRuntime, createWsEventMapper } from "./agent-runtime.js"
import { createFileManagerRouter, FileManagerError } from "@miki/core/file-manager"
import { FileRunError, runWorkspaceFile, summarizeRun } from "@miki/core/engine"
import { normalizeRuntimePaths } from "@miki/core/paths"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, "../../..")
const app = express()
const server = http.createServer(app)
const host = process.env.GATEWAY_HOST || "127.0.0.1"
const port = Number(process.env.GATEWAY_PORT || 18800)
const dashboardRoot = path.join(projectRoot, "packages/ui/frontend/dist")
const dataRoot = process.env.MIKI_DATA_DIR ? path.resolve(process.env.MIKI_DATA_DIR) : path.join(projectRoot, "data")
mkdirSync(dataRoot, { recursive: true })
const db = new Database(path.join(dataRoot, "miki-runtime.sqlite"))
db.pragma("journal_mode = WAL")
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS auth_sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS file_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_at TEXT NOT NULL, file TEXT NOT NULL, args TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, exit_code INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', model_name TEXT, FOREIGN KEY(session_id) REFERENCES chat_sessions(id));
  CREATE TABLE IF NOT EXISTS model_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memory_chunks (id TEXT PRIMARY KEY, region TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL, provenance TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1, importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`)

app.use(express.json({ limit: "25mb" }))
const now = () => new Date().toISOString()
const setting = (key: string) => db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined
const putSetting = (key: string, value: string) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value)
const hashPassword = (password: string) => {
  const salt = randomBytes(16).toString("hex")
  return `${salt}:${scryptSync(password, salt, 32).toString("hex")}`
}
const verifyPassword = (password: string, stored: string) => {
  const [salt, digest] = stored.split(":")
  if (!salt || !digest) return false
  const actual = scryptSync(password, salt, 32)
  const expected = Buffer.from(digest, "hex")
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}
const cookie = (req: express.Request, name: string) => req.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] ?? null
const issueAuth = (res: express.Response) => {
  const token = randomBytes(32).toString("hex")
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString()
  db.prepare("INSERT INTO auth_sessions(token,created_at,expires_at) VALUES(?,?,?)").run(token, now(), expires)
  res.setHeader("Set-Cookie", `miki_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`)
}
const authenticated = (req: express.Request) => {
  const token = cookie(req, "miki_session")
  if (!token) return false
  return Boolean(db.prepare("SELECT token FROM auth_sessions WHERE token=? AND expires_at>? ").get(token, now()))
}
const ensureSession = (id: string) => {
  const existing = db.prepare("SELECT id FROM chat_sessions WHERE id=?").get(id)
  if (!existing) db.prepare("INSERT INTO chat_sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)").run(id, "Miki chat", now(), now())
}
const sessionSummary = (id: string) => {
  ensureSession(id)
  const row = db.prepare(`SELECT s.id,s.title,s.created_at created,s.updated_at updated,COUNT(m.id) message_count,COALESCE((SELECT content FROM chat_messages WHERE session_id=s.id ORDER BY created_at DESC LIMIT 1),'') preview,s.pinned FROM chat_sessions s LEFT JOIN chat_messages m ON m.session_id=s.id WHERE s.id=? GROUP BY s.id`).get(id) as Record<string, unknown>
  return row
}
const workspaceRoot = path.resolve(process.env.MIKI_WORKSPACE_DIR || projectRoot)
const memoryRows = (region?: string) => db.prepare(region ? "SELECT * FROM memory_chunks WHERE region=? ORDER BY updated_at DESC" : "SELECT * FROM memory_chunks ORDER BY updated_at DESC").all(...(region ? [region] : [])) as Record<string, unknown>[]

app.get("/gateway/health", (_req, res) => res.json({ status: "ok", ok: true, coreHealthy: true, gateway: "persistent-node-backend" }))
app.get("/api/auth/status", (req, res) => res.json({ authenticated: authenticated(req), initialized: Boolean(setting("dashboard_password")), session_timeout_minutes: 0 }))
app.post("/api/auth/setup", (req, res) => {
  if (setting("dashboard_password")) return res.status(409).json({ error: "Dashboard is already configured." })
  const password = typeof req.body?.password === "string" ? req.body.password.trim() : ""
  const confirm = typeof req.body?.confirm === "string" ? req.body.confirm.trim() : ""
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." })
  if (password !== confirm) return res.status(400).json({ error: "Passwords do not match." })
  putSetting("dashboard_password", hashPassword(password)); issueAuth(res); res.json({ ok: true })
})
app.post("/api/auth/login", (req, res) => {
  const password = typeof req.body?.password === "string" ? req.body.password.trim() : ""
  const stored = setting("dashboard_password")?.value
  if (!stored) return res.status(409).json({ error: "Dashboard setup is required first." })
  if (!verifyPassword(password, stored)) return res.status(401).json({ error: "Invalid dashboard password." })
  issueAuth(res); res.json({ ok: true, default_model_configured: Boolean(process.env.OPENAI_API_KEY && (process.env.MIKI_MODEL || process.env.OPENAI_MODEL)) })
})
app.post("/api/auth/logout", (req, res) => { const token = cookie(req, "miki_session"); if (token) db.prepare("DELETE FROM auth_sessions WHERE token=?").run(token); res.setHeader("Set-Cookie", "miki_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"); res.json({ ok: true }) })

app.get("/api/gateway/status", (_req, res) => res.json({ gateway_status: "running", gateway_start_allowed: true, pid: process.pid }))
app.get("/api/gateway/logs", (_req, res) => res.json({ logs: [], log_total: 0, log_run_id: 0 }))
app.post("/api/gateway/start", (_req, res) => res.json({ status: "running", pid: process.pid }))
app.post("/api/gateway/restart", (_req, res) => res.json({ status: "reloaded", pid: process.pid }))
app.post("/api/gateway/logs/clear", (_req, res) => res.json({ status: "ok" }))
app.post("/api/runtime/reload", (_req, res) => res.json({ status: "applied", applied: true, pending_restart: false, gateway_restart_required: false }))

app.get("/api/sessions", (_req, res) => {
  const rows = db.prepare("SELECT id FROM chat_sessions ORDER BY updated_at DESC").all() as { id: string }[]
  if (!rows.length) ensureSession("miki-main-chat")
  res.json((rows.length ? rows : [{ id: "miki-main-chat" }]).map((row) => sessionSummary(row.id)))
})
app.get("/api/sessions/:id", (req, res) => {
  const id = req.params.id; ensureSession(id)
  const summary = sessionSummary(id)
  const messages = db.prepare("SELECT id,role,content,created_at,kind,model_name FROM chat_messages WHERE session_id=? ORDER BY created_at ASC").all(id)
  res.json({ ...summary, messages, summary: "" })
})
app.patch("/api/sessions/:id", (req, res) => { ensureSession(req.params.id); if (typeof req.body?.title === "string") db.prepare("UPDATE chat_sessions SET title=?,updated_at=? WHERE id=?").run(req.body.title, now(), req.params.id); res.json(sessionSummary(req.params.id)) })
app.delete("/api/sessions/:id", (req, res) => { db.prepare("DELETE FROM chat_messages WHERE session_id=?").run(req.params.id); db.prepare("DELETE FROM chat_sessions WHERE id=?").run(req.params.id); res.status(204).end() })

const configuredModel = () => process.env.MIKI_MODEL || process.env.OPENAI_MODEL || (process.env.OPENAI_API_KEY ? "gpt-5-mini" : "")
const modelPayload = (row: { id: number; payload: string; is_default: number }) => {
  const raw = JSON.parse(row.payload) as Record<string, unknown>
  const model = String(raw.model || raw.model_name || "")
  const keySet = Boolean(raw.api_key || process.env.OPENAI_API_KEY)
  return { index: row.id, ...raw, model_name: String(raw.model_name || model), model, api_key: "", api_key_set: keySet, enabled: raw.enabled !== false, available: keySet, status: keySet ? "available" : "unconfigured", is_default: row.is_default === 1, is_virtual: false }
}
const storedModels = () => db.prepare("SELECT id,payload,is_default FROM model_configs ORDER BY id").all() as { id: number; payload: string; is_default: number }[]
const envModel = () => ({ model_name: configuredModel(), model: configuredModel(), provider: process.env.MIKI_PROVIDER || "openai-compatible", api_key_set: Boolean(process.env.OPENAI_API_KEY), enabled: true })
const effectiveModel = () => {
  const rows = storedModels()
  if (rows.length) return modelPayload(rows.find((row) => row.is_default === 1) || rows[0])
  const model = configuredModel()
  return model ? { index: 0, ...envModel(), api_key: "", available: Boolean(process.env.OPENAI_API_KEY), status: process.env.OPENAI_API_KEY ? "available" : "unconfigured", is_default: true, is_virtual: true } : null
}
app.get("/api/models", (_req, res) => {
  const rows = storedModels()
  const models = rows.length ? rows.map(modelPayload) : (effectiveModel() ? [effectiveModel()] : [])
  res.json({ models, total: models.length, default_model: (models.find((item) => item.is_default) as { model?: string } | undefined)?.model || "", provider_options: [] })
})
app.post("/api/models", (req, res) => {
  const payload = { ...(req.body as Record<string, unknown>) }
  const model = String(payload.model || payload.model_name || "").trim()
  if (!model) return res.status(400).json({ error: "model is required" })
  payload.model = model; payload.model_name = String(payload.model_name || model)
  const existing = storedModels().length > 0
  const result = db.prepare("INSERT INTO model_configs(payload,is_default,created_at,updated_at) VALUES(?,?,?,?)").run(JSON.stringify(payload), existing ? 0 : 1, now(), now())
  return res.json({ status: "created", index: Number(result.lastInsertRowid), default_model: existing ? undefined : model })
})
app.put("/api/models/:index", (req, res) => {
  const id = Number(req.params.index); const row = db.prepare("SELECT payload FROM model_configs WHERE id=?").get(id) as { payload: string } | undefined
  if (!row) return res.status(404).json({ error: "Model not found" })
  const payload = { ...(JSON.parse(row.payload) as Record<string, unknown>), ...(req.body as Record<string, unknown>) }
  db.prepare("UPDATE model_configs SET payload=?,updated_at=? WHERE id=?").run(JSON.stringify(payload), now(), id)
  return res.json({ status: "updated", index: id })
})
app.delete("/api/models/:index", (req, res) => {
  const id = Number(req.params.index); const result = db.prepare("DELETE FROM model_configs WHERE id=?").run(id)
  if (!result.changes) return res.status(404).json({ error: "Model not found" })
  const remaining = storedModels(); if (remaining.length && !remaining.some((row) => row.is_default)) db.prepare("UPDATE model_configs SET is_default=1 WHERE id=?").run(remaining[0].id)
  return res.json({ status: "deleted", index: id })
})
app.post("/api/models/default", (req, res) => {
  const target = String(req.body?.model_name || ""); const row = storedModels().find((item) => { const value = JSON.parse(item.payload) as Record<string, unknown>; return value.model === target || value.model_name === target })
  if (!row) return res.status(404).json({ error: "Model not found" })
  db.transaction(() => { db.prepare("UPDATE model_configs SET is_default=0").run(); db.prepare("UPDATE model_configs SET is_default=1,updated_at=? WHERE id=?").run(now(), row.id) })()
  return res.json({ status: "ok", default_model: target })
})
const modelForIndex = (index: number) => { const row = storedModels().find((item) => item.id === index); return row ? JSON.parse(row.payload) as Record<string, unknown> : effectiveModel() }
app.post("/api/models/:index/test", async (req, res) => {
  const started = Date.now(); const model = modelForIndex(Number(req.params.index)) as Record<string, unknown> | null; const name = String(model?.model || model?.model_name || configuredModel())
  try { const content = await completeWithProvider([{ role: "user", content: "Reply with exactly OK" }], name, typeof model?.api_key === "string" ? model.api_key : undefined, typeof model?.api_base === "string" ? model.api_base : undefined); return res.json({ success: Boolean(content), latency_ms: Date.now() - started, status: content ? "ok" : "failed", verification_level: "completion", completion_tested: true, final_response_received: Boolean(content), provider: String(model?.provider || "openai-compatible"), model: name, response_shape: { choiceCount: content ? 1 : 0, contentPresent: Boolean(content) } }) } catch (error) { return res.json({ success: false, latency_ms: Date.now() - started, status: "failed", error: error instanceof Error ? error.message : String(error), model: name }) }
})
app.post("/api/models/test-inline", async (req, res) => { const model = String(req.body?.model || ""); try { const content = await completeWithProvider([{ role: "user", content: "Reply with exactly OK" }], model, req.body?.api_key, req.body?.api_base); res.json({ success: Boolean(content), latency_ms: 0, status: "ok", completion_tested: true, final_response_received: Boolean(content), model }) } catch (error) { res.json({ success: false, latency_ms: 0, status: "failed", error: error instanceof Error ? error.message : String(error), model }) } })
app.post("/api/models/fetch", async (req, res) => { const base = String(req.body?.api_base || process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/$/, ""); const key = String(req.body?.api_key || process.env.OPENAI_API_KEY || ""); try { const response = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {} }); const body = await response.json() as { data?: Array<{ id: string; owned_by?: string }> }; const models = body.data || []; res.json({ models, total: models.length }) } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }) } })
app.get("/api/models/catalog", (_req, res) => res.json({ entries: [], total: 0 }))
const getAppConfig = () => { const raw = setting("app_config")?.value; if (!raw) return {}; try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} } }
app.get("/api/config", (_req, res) => res.json(getAppConfig()))
app.patch("/api/config", (req, res) => { const next = { ...getAppConfig(), ...(req.body as Record<string, unknown>) }; putSetting("app_config", JSON.stringify(next)); res.json({ status: "ok", config: next }) })
app.post("/api/config/reset", (_req, res) => { db.prepare("DELETE FROM settings WHERE key='app_config'").run(); res.json({ status: "ok", config: {} }) })
app.get("/api/system/autostart", (_req, res) => res.json({ enabled: false, supported: false, platform: process.platform, message: "Configure autostart through the host environment." }))
app.get("/api/system/launcher-config", (_req, res) => res.json({ port, public: host !== "127.0.0.1", allowed_cidrs: [], session_timeout_minutes: 0 }))
app.get("/api/system/version", (_req, res) => res.json({ version: "1.3.14", go_version: "not used by Node backend" }))
app.get("/api/channels/catalog", (_req, res) => res.json({ channels: [] }))
app.get("/api/skills", (_req, res) => {
  const root = path.join(projectRoot, "packages/skills/src")
  const skills = existsSync(root) ? readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, path: path.join(root, entry.name), source: "builtin", description: `Built-in Miki skill: ${entry.name}`, origin_kind: "builtin" })) : []
  res.json({ skills, total: skills.length })
})
app.get("/api/skills/search", (req, res) => res.json({ results: [], limit: Number(req.query.limit || 20), offset: Number(req.query.offset || 0), has_more: false }))
app.get("/api/skills/:name", (req, res) => {
  const name = path.basename(req.params.name); const skillPath = path.join(projectRoot, "packages/skills/src", name); if (!existsSync(skillPath)) return res.status(404).json({ error: "Skill not found" })
  return res.json({ name, path: skillPath, source: "builtin", description: `Built-in Miki skill: ${name}`, origin_kind: "builtin", content: "" })
})
/** File execution is on by default. MIKI_FILE_EXECUTION=false or app_config.files.execution_enabled=false turns it off at runtime. */
const fileExecutionEnabled = () => {
  if (String(process.env.MIKI_FILE_EXECUTION ?? "").toLowerCase() === "false") return false
  const files = getAppConfig().files as { execution_enabled?: unknown } | undefined
  return files?.execution_enabled !== false
}
const recordFileRun = (entry: { file: string; args: string[]; status: string; exitCode: number | null; durationMs: number; source: string }) => {
  try { db.prepare("INSERT INTO file_runs(run_at,file,args,status,exit_code,duration_ms,source) VALUES(?,?,?,?,?,?,?)").run(now(), entry.file, JSON.stringify(entry.args), entry.status, entry.exitCode, entry.durationMs, entry.source) } catch (error) { console.warn("[miki] could not record file run", error) }
}
const requireAuth: express.RequestHandler = (req, res, next) => (authenticated(req) ? next() : res.status(401).json({ error: "Authentication required." }))
const agent = createAgentRuntime({
  db,
  dataRoot,
  workspaceRoot,
  getAppConfig,
  setAppConfig: (next) => putSetting("app_config", JSON.stringify(next)),
  storedModels: () => storedModels().map((row) => ({ payload: JSON.parse(row.payload) as Record<string, unknown>, isDefault: row.is_default === 1 })),
  requireAuth,
  fileExecutionEnabled,
  recordFileRun,
  log: (message, details) => console.warn(`[miki] ${message}`, details ?? {}),
})
agent.mount(app)

// Files / Drive: the full file manager (list, read, write, create, rename, move, copy, delete,
// upload, download, archive, preview, run). Everything here needs the dashboard session.
app.use("/api/files", requireAuth, createFileManagerRouter({
  runtimePaths: { ...normalizeRuntimePaths(workspaceRoot), sourceDir: workspaceRoot, dataDir: dataRoot },
  allowRun: fileExecutionEnabled,
  protectedPaths: [dataRoot],
  allowSensitive: () => String(process.env.MIKI_FILES_ALLOW_SENSITIVE ?? "").toLowerCase() === "true",
  runFile: async (target) => {
    try {
      const result = await runWorkspaceFile({ root: workspaceRoot, file: target })
      recordFileRun({ file: result.file, args: [], status: result.status, exitCode: result.exitCode, durationMs: result.durationMs, source: "dashboard" })
      return { ok: result.status === "ok", message: summarizeRun(result), result }
    } catch (error) {
      if (error instanceof FileRunError) throw new FileManagerError(error.status, error.message)
      throw error
    }
  },
}))
app.get("/api/tools", (_req, res) => {
  const state = (getAppConfig().tools as { tool_state?: Record<string, boolean> } | undefined)?.tool_state ?? {}
  const registered = new Set(agent.registry.names())
  const group = (key: string, name: string, description: string, category: string, defaultEnabled: boolean, members: string[]) => {
    const enabled = typeof state[key] === "boolean" ? state[key] : defaultEnabled
    return { name, description, category, config_key: key, status: enabled ? "enabled" : "disabled", config_enabled: enabled, tools: members.filter((m) => registered.has(m)) }
  }
  res.json({ tools: [
    group("filesystem", "filesystem", "Read, search, organize and (with approval) write, delete or run files inside the workspace.", "workspace", true, ["workspace_list", "file_read", "workspace_search", "file_write", "file_info", "file_mkdir", "file_rename", "file_move", "file_copy", "file_delete", "file_run"]),
    group("memory", "memory", "Search and store long-term memory notes.", "memory", true, ["memory_search", "memory_add"]),
    group("control", "agent-control", "Typed, approval-gated agent configuration operations.", "system", true, ["agent_control_capabilities", "agent_control_state", "agent_control_plan", "agent_control_request", "agent_control_execute"]),
    group("web_search", "web-search", "Search the web through a configured provider (not available yet).", "network", false, []),
  ] })
})
app.get("/api/tools/web-search-config", (_req, res) => res.json({ execution_mode: "local", provider: "", current_service: "", prefer_native: false, providers: [], settings: {} }))
app.get("/api/memory/stats", (_req, res) => { const rows = memoryRows(); const byRegion = [...new Set(rows.map((row) => String(row.region)))].map((region) => ({ region, count: rows.filter((row) => row.region === region).length })); res.json({ scope: {}, stats: { chunks: rows.length, edges: 0, postings: rows.length, retrievals: 0, byRegion } }) })
app.get("/api/memory/chunks", (req, res) => { const chunks = memoryRows(req.query.region ? String(req.query.region) : undefined).slice(0, Number(req.query.limit || 80)).map((row) => ({ ...row, access_count: 0, status: "active", metadata: {} })); res.json({ scope: {}, chunks }) })
app.post("/api/memory/chunks", (req, res) => { const content = String(req.body?.content || "").trim(); if (!content) return res.status(400).json({ error: "content is required" }); const id = randomUUID(); const timestamp = now(); db.prepare("INSERT INTO memory_chunks(id,region,content,summary,provenance,confidence,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, String(req.body?.region || "long_term"), content, String(req.body?.summary || content.slice(0, 160)), String(req.body?.provenance || "manual"), Number(req.body?.confidence ?? 1), Number(req.body?.importance ?? 0.5), timestamp, timestamp); res.json({ status: "created", id }) })
app.get("/api/memory/search", (req, res) => { const query = String(req.query.q || "").trim().toLowerCase(); const items = memoryRows().filter((row) => String(row.content).toLowerCase().includes(query)).slice(0, Number(req.query.maxSelected || 12)).map((row) => ({ id: row.id, text: row.content, summary: row.summary, region: row.region, provenance: row.provenance, confidence: row.confidence, importance: row.importance, score: 1, lexical: 1, semantic: 0, depth: 0, sourceType: "sqlite" })); res.json({ query, scope: {}, result: { items, text: items.map((item) => item.text).join("\n"), trace: {}, stats: { candidateCount: items.length, selectedCount: items.length, tokensUsed: 0, maxTokens: Number(req.query.maxTokens || 1200), latencyMs: 0 } } })
})
app.post("/api/memory/reindex", (_req, res) => res.json({ result: { reindexed: memoryRows().length } }))
app.get("/api/memory/chunks/:id", (req, res) => { const row = db.prepare("SELECT * FROM memory_chunks WHERE id=?").get(req.params.id) as Record<string, unknown> | undefined; if (!row) return res.status(404).json({ error: "Memory chunk not found" }); return res.json({ scope: {}, chunk: { ...row, edges: [] } }) })
app.post("/api/memory/chunks/:id/forget", (req, res) => { const result = db.prepare("DELETE FROM memory_chunks WHERE id=?").run(req.params.id); res.json({ result: { forgotten: result.changes > 0, chunkId: req.params.id } }) })
app.get("/api/enhancements/health/full", (_req, res) => res.json({ status: "degraded", checkedAt: now(), doctor: { status: "warn", checkedAt: now(), workspaceDir: projectRoot, checks: [] }, memory: { available: false }, safeMode: { enabled: false, reasons: [] }, backups: [], migrations: [], watchdog: { enabled: false, services: [] }, jobs: { items: [], stats: {} }, performance: [], audit: [], secretScan: { scannedFiles: 0, fixedFiles: [], findings: [] }, components: [] }))
app.get("/api/enhancements/runtime/deliveries", (_req, res) => res.json({ receipts: [], stats: {} }))
app.get("/api/miki/info", (_req, res) => res.json({ name: "Miki", version: "1.3.14", backend: "persistent-node" }))
app.get("/api/agents", (_req, res) => res.json({ agents: [], total: 0 }))
app.get("/api/swarm/status", (_req, res) => res.json({ status: "idle", agents: [] }))
app.get("/api/automations/platforms", (_req, res) => res.json({ platforms: [] }))

async function completeWithProvider(messages: { role: string; content: string }[], model: string, requestKey?: string, requestBase?: string) {
  const key = requestKey || process.env.OPENAI_API_KEY
  const base = (requestBase || process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/$/, "")
  if (!key) return null
  const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages, temperature: 0.7, max_completion_tokens: 1024, reasoning: { effort: "minimal" } }) })
  const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
  if (!response.ok) throw new Error(body.error?.message || `Model provider returned HTTP ${response.status}`)
  return body.choices?.[0]?.message?.content || ""
}

const wss = new WebSocketServer({ noServer: true })
const sendEvent = (ws: WebSocket, type: string, sessionId: string, payload: Record<string, unknown> = {}) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, session_id: sessionId, timestamp: Date.now(), payload })) }
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`)
  if (url.pathname !== "/miki/ws") return socket.destroy()
  // Once the dashboard has a password, the agent socket requires the session cookie.
  if (setting("dashboard_password") && !authenticated({ headers: request.headers } as express.Request)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n")
    return socket.destroy()
  }
  wss.handleUpgrade(request, socket, head, (client) => wss.emit("connection", client, request, url))
})
wss.on("connection", (ws: WebSocket, _request: http.IncomingMessage, url: URL) => {
  const sessionId = url.searchParams.get("session_id") || "miki-main-chat"
  ensureSession(sessionId)
  const socketRuns = new Set<string>()
  sendEvent(ws, "connection.ready", sessionId, { session_id: sessionId, backend: "persistent-node" })
  ws.on("close", () => { for (const runId of socketRuns) agent.cancelRun(runId) })
  ws.on("message", async (raw) => {
    let message: { type?: string; id?: string; task_id?: string; payload?: { content?: string; requested_model?: string } }
    try { message = JSON.parse(raw.toString()) } catch { sendEvent(ws, "error", sessionId, { message: "Invalid WebSocket JSON payload." }); return }
    if (message.type === "cancel_task") { if (message.task_id) agent.cancelRun(message.task_id); return }
    if (message.type !== "message.send") return
    const content = String(message.payload?.content || "").trim()
    if (!content) return
    const runId = `run_${randomUUID()}`
    const requested = message.payload?.requested_model?.trim() || undefined
    db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at) VALUES(?,?,?,?,?)").run(randomUUID(), sessionId, "user", content, now())
    db.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").run(now(), sessionId)
    // Conversation history for the model: persisted normal messages only (thoughts/tool traces stay out).
    const history = (db.prepare("SELECT role,content FROM chat_messages WHERE session_id=? AND kind='normal' ORDER BY created_at DESC LIMIT 50").all(sessionId) as { role: string; content: string }[])
      .reverse().filter((row) => row.role === "user" || row.role === "assistant").map((row) => ({ role: row.role as "user" | "assistant", content: row.content }))
    const model = agent.llmFor(requested)?.model || requested
    const mapper = createWsEventMapper((type, payload) => sendEvent(ws, type, sessionId, payload), model)
    socketRuns.add(runId)
    try {
      const result = await agent.startRun({ runId, sessionId, history, model: requested, source: "websocket", onEvent: mapper.handle })
      if (result.finalText) {
        db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,model_name) VALUES(?,?,?,?,?,?)").run(mapper.finalId, sessionId, "assistant", result.finalText, now(), result.model || null)
        db.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").run(now(), sessionId)
      }
    } catch (error) {
      // Not an agent reply: a system error state (e.g. a run is already active for this session).
      const detail = error instanceof Error ? error.message : String(error)
      sendEvent(ws, "error", sessionId, { message: detail, run_id: runId })
      sendEvent(ws, "typing.stop", sessionId, { run_id: runId })
      sendEvent(ws, "node.run_end", sessionId, { run_id: runId, status: "failed", error: detail })
    } finally {
      socketRuns.delete(runId)
    }
  })
})

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint is not implemented in this backend yet." }))
app.use(express.static(dashboardRoot))
app.get("*", (_req, res) => res.sendFile(path.join(dashboardRoot, "index.html")))
server.listen(port, host, () => console.log(`[miki] persistent backend listening at http://${host}:${port}`))
function shutdown() { try { db.close() } finally { server.close(() => process.exit(0)) } }
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
