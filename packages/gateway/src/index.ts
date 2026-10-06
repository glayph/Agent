import express from "express"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { mkdirSync, statSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync as makeDirSync, rmSync, renameSync, copyFileSync } from "node:fs"
import os from "node:os"
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto"
import { isIP } from "node:net"
import Database from "better-sqlite3"
import { WebSocketServer, type WebSocket } from "ws"
import { createAgentRuntime, createWsEventMapper } from "./agent-runtime.js"
import { createFileManagerRouter, FileManagerError } from "@miki/core/file-manager"
import { FileRunError, runWorkspaceFile, summarizeRun } from "@miki/core/engine"
import { normalizeRuntimePaths } from "@miki/core/paths"
import { createSkillsRouter, createSkillsService } from "@miki/core/skills"
import { createEmbeddingProvider, cosineSimilarity } from "@miki/memory"
import { LearningStore } from "@miki/memory"
import { getLifecycleBus } from "@miki/core/hooks"
import { planAdaptiveOutput } from "@miki/core"
import { createDashboardExtendedRouter } from "./dashboard-extended.js"
import { validateRuntimeConfig, migrateRuntimeConfig } from "@miki/config"
import { AutonomousSupervisor } from "@miki/core/autonomy"
import { normalizeSessionScope, resolveSessionContextId } from "./session-scope.js"
import { resolveToolGroupKey } from "./tool-groups.js"
import { resolveContextWindowTokens } from "./runtime-settings.js"
import { FileMemoryService } from "@miki/core/memory-files"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, "../../..")
const app = express()
const server = http.createServer(app)
let currentHost = process.env.GATEWAY_HOST || "127.0.0.1"
let currentPort = Number(process.env.GATEWAY_PORT || 18800)
const dashboardRoot = path.join(projectRoot, "packages/ui/frontend/dist")
const workspaceRootHint = process.env.MIKI_WORKSPACE_DIR ? path.resolve(process.env.MIKI_WORKSPACE_DIR) : projectRoot
const dataRoot = process.env.MIKI_DATA_DIR
  ? path.resolve(process.env.MIKI_DATA_DIR)
  : path.join(workspaceRootHint, "data")
mkdirSync(dataRoot, { recursive: true })
const db = new Database(path.join(dataRoot, "miki-runtime.sqlite"))
db.pragma("journal_mode = WAL")
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS auth_sessions (token TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS file_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_at TEXT NOT NULL, file TEXT NOT NULL, args TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL, exit_code INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS skill_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, status TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '{}');
  CREATE TABLE IF NOT EXISTS chat_sessions (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', model_name TEXT, context_id TEXT, image_urls TEXT, attachments_json TEXT, FOREIGN KEY(session_id) REFERENCES chat_sessions(id));
  CREATE TABLE IF NOT EXISTS model_configs (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS model_catalogs (id TEXT PRIMARY KEY, provider TEXT NOT NULL, api_base TEXT NOT NULL, api_key_mask TEXT NOT NULL DEFAULT '', models_json TEXT NOT NULL, fetched_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memory_chunks (id TEXT PRIMARY KEY, region TEXT NOT NULL, content TEXT NOT NULL, summary TEXT NOT NULL, provenance TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1, importance REAL NOT NULL DEFAULT 0.5, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS memory_vectors (chunk_id TEXT PRIMARY KEY, embedding TEXT NOT NULL, dimensions INTEGER NOT NULL, updated_at TEXT NOT NULL, FOREIGN KEY(chunk_id) REFERENCES memory_chunks(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS orchestrator_runs (run_id TEXT PRIMARY KEY, session_id TEXT, phase TEXT NOT NULL, route_json TEXT, plan_json TEXT, node_status_json TEXT NOT NULL, updated_at TEXT NOT NULL);
`)
const autonomyLearningStore = new LearningStore(db)
autonomyLearningStore.initializeSync()

const ensureColumn = (table: string, column: string, definition: string) => {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
  if (!columns.some((item) => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
}
ensureColumn("orchestrator_runs", "status", "TEXT")
ensureColumn("orchestrator_runs", "error", "TEXT")
ensureColumn("orchestrator_runs", "started_at", "TEXT")
ensureColumn("orchestrator_runs", "finished_at", "TEXT")
ensureColumn("chat_messages", "context_id", "TEXT")
ensureColumn("chat_messages", "image_urls", "TEXT")
ensureColumn("chat_messages", "attachments_json", "TEXT")
db.prepare("UPDATE chat_messages SET context_id='channel:default-channel:peer:' || session_id WHERE context_id IS NULL").run()
db.exec("CREATE INDEX IF NOT EXISTS idx_chat_messages_context_created ON chat_messages(context_id, created_at)")
// A process restart cannot safely resume a partially executed DAG because transient
// sub-task outputs are not persisted. Mark such runs interrupted instead of exposing
// them as indefinitely active.
db.prepare(`UPDATE orchestrator_runs SET status='failed', phase='EVAL', error=COALESCE(error, ?), updated_at=? WHERE COALESCE(status, '')='running'`).run("Gateway restarted before orchestration completed.", new Date().toISOString())

app.use(express.json({ limit: "25mb" }))

const now = () => new Date().toISOString()
const setting = (key: string) => db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined
const putSetting = (key: string, value: string) => db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value)

function normalizeClientAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice(7) : address
}
function ipInCidr(ip: string, cidr: string): boolean {
  const [network, prefixText] = cidr.trim().split("/")
  if (!network) return false
  const version = isIP(ip)
  if (version === 0 || version !== isIP(network)) return false
  if (!prefixText) return ip === network
  const prefix = Number(prefixText)
  const bits = version === 4 ? 32 : 128
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return false
  const toBig = (value: string, v: number) => v === 4
    ? value.split(".").reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n)
    : (() => {
        const [left, right] = value.split("::")
        const l = left ? left.split(":") : []
        const r = right ? right.split(":") : []
        const groups = value.includes("::") ? [...l, ...Array(8 - l.length - r.length).fill("0"), ...r] : value.split(":")
        return groups.reduce((acc, part) => (acc << 16n) | BigInt(parseInt(part || "0", 16)), 0n)
      })()
  const mask = prefix === 0 ? 0n : (((1n << BigInt(bits)) - 1n) ^ ((1n << BigInt(bits - prefix)) - 1n))
  return (toBig(ip, version) & mask) === (toBig(network, version) & mask)
}
function allowedClient(req: express.Request): boolean {
  let launcher: Record<string, unknown> = {}
  try { launcher = JSON.parse(String(setting("launcher_config")?.value || "{}")) as Record<string, unknown> } catch {}
  if (launcher.public !== true) return true
  const cidrs = Array.isArray(launcher.allowed_cidrs)
    ? launcher.allowed_cidrs.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean)
    : []
  if (!cidrs.length) return true
  const remote = normalizeClientAddress(req.ip || req.socket.remoteAddress || "")
  return cidrs.some((cidr) => ipInCidr(remote, cidr))
}
app.use((req, res, next) => {
  if (!req.path.startsWith("/api") && req.path !== "/gateway/health") return next()
  if (!allowedClient(req)) return res.status(403).json({ error: "Client address is not allowed by launcher CIDR policy." })
  return next()
})

// All dashboard REST APIs use the same miki_session session model as WebSocket auth.
// Public exceptions are limited to health/version and the auth bootstrap endpoints.
app.use("/api", (req, res, next) => {
  const publicPath =
    req.path === "/health" ||
    req.path === "/version" ||
    req.path === "/system/version" ||
    req.path.startsWith("/auth/")
  return publicPath ? next() : requireAuth(req, res, next)
})
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
const authSessionConfig = () => {
  try {
    const raw = db.prepare("SELECT value FROM settings WHERE key='launcher_config'").get() as { value?: string } | undefined
    const value = raw?.value ? JSON.parse(raw.value) : {}
    const minutes = Number(value?.session_timeout_minutes || 0)
    return Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.floor(minutes), 31 * 24 * 60) : 30 * 24 * 60
  } catch {
    return 30 * 24 * 60
  }
}
const issueAuth = (res: express.Response) => {
  const token = randomBytes(32).toString("hex")
  const maxAgeMinutes = authSessionConfig()
  const expires = new Date(Date.now() + 1000 * 60 * maxAgeMinutes).toISOString()
  db.prepare("INSERT INTO auth_sessions(token,created_at,expires_at) VALUES(?,?,?)").run(token, now(), expires)
  res.setHeader("Set-Cookie", `miki_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeMinutes * 60}`)
}
const authenticated = (req: express.Request) => {
  const token = cookie(req, "miki_session")
  if (!token) return false
  return Boolean(db.prepare("SELECT token FROM auth_sessions WHERE token=? AND expires_at>? ").get(token, now()))
}
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (authenticated(req)) return next()
  return res.status(401).json({ error: "Authentication required." })
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
const configDir = path.resolve(process.env.MIKI_CONFIG_DIR || path.join(workspaceRoot, "config"))
const memoryRows = (region?: string) => db.prepare(region ? "SELECT * FROM memory_chunks WHERE region=? ORDER BY updated_at DESC" : "SELECT * FROM memory_chunks ORDER BY updated_at DESC").all(...(region ? [region] : [])) as Record<string, unknown>[]
const embeddingProvider = createEmbeddingProvider()
const readStoredEmbedding = (chunkId: string): number[] | undefined => {
  const row = db.prepare("SELECT embedding FROM memory_vectors WHERE chunk_id=?").get(chunkId) as { embedding?: string } | undefined
  if (!row?.embedding) return undefined
  try { return JSON.parse(row.embedding) as number[] } catch { return undefined }
}
const ensureStoredEmbedding = async (row: Record<string, unknown>): Promise<number[]> => {
  const existing = readStoredEmbedding(String(row.id))
  if (existing?.length) return existing
  const vector = Array.from(await embeddingProvider.embed(`${String(row.summary || "")}\n${String(row.content || "")}`)) as number[]
  db.prepare("INSERT INTO memory_vectors(chunk_id,embedding,dimensions,updated_at) VALUES(?,?,?,?) ON CONFLICT(chunk_id) DO UPDATE SET embedding=excluded.embedding,dimensions=excluded.dimensions,updated_at=excluded.updated_at").run(String(row.id), JSON.stringify(vector), vector.length, now())
  return vector
}
const lexicalMemorySearch = (query: string, limit: number) => {
  const terms = query.toLowerCase().split(/\s+/).map((value) => value.trim()).filter((value) => value.length >= 2).slice(0, 12)
  const rows = memoryRows()
  const scored = rows.map((row) => {
    const haystack = `${String(row.summary || "")} ${String(row.content || "")}`.toLowerCase()
    const matches = terms.reduce((count, term) => count + (haystack.includes(term) ? 1 : 0), 0)
    return { row, score: terms.length ? matches / terms.length : 0 }
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || String(b.row.updated_at).localeCompare(String(a.row.updated_at)))
  return scored.slice(0, Math.max(1, limit)).map(({ row, score }) => ({ id: String(row.id), text: String(row.content), summary: String(row.summary), region: String(row.region), score }))
}

const vectorMemorySearch = async (query: string, limit: number) => {
  // Hash/no-op vectors are plumbing fallbacks, not semantic embeddings. Do not
  // pretend their cosine distance provides semantic recall; use lexical search.
  if (embeddingProvider.name === "hash-offline" || embeddingProvider.name === "noop") return lexicalMemorySearch(query, limit)
  const q = Array.from(await embeddingProvider.embed(query))
  const rows = memoryRows()
  const scored: Array<Record<string, unknown> & { score: number }> = []
  for (const row of rows) {
    const stored = readStoredEmbedding(String(row.id))
    if (!stored?.length) continue
    const score = cosineSimilarity(q, stored)
    scored.push({ ...row, score })
  }
  if (!scored.length) return lexicalMemorySearch(query, limit)
  return scored.sort((a, b) => Number(b.score) - Number(a.score)).slice(0, Math.max(1, limit)).map((row) => ({ id: String(row.id), text: String(row.content), summary: String(row.summary), region: String(row.region), score: Number(row.score) }))
}

const gatewayRole = "primary-node-gateway"
let shutdownRequested = false
const lifecycleOwner = process.env.MIKI_24_7_RUNTIME === "1" ? "24-7-supervisor" : "launcher"

const gatewayHealthPayload = () => ({
  status: "ok",
  ok: true,
  coreHealthy: true,
  gateway: "persistent-node-backend",
  backend_role: gatewayRole,
  lifecycle_owner: lifecycleOwner,
  pid: process.pid,
})
app.get("/gateway/health", (_req, res) => {
  res.setHeader("X-Miki-Backend-Role", gatewayRole)
  return res.json(gatewayHealthPayload())
})
app.get("/api/health", (_req, res) => {
  res.setHeader("X-Miki-Backend-Role", gatewayRole)
  return res.json(gatewayHealthPayload())
})
app.get("/api/auth/status", (req, res) => {
  const token = cookie(req, "miki_session")
  const isAuthenticated = authenticated(req)
  let row = token ? db.prepare("SELECT expires_at FROM auth_sessions WHERE token=? AND expires_at>? ").get(token, now()) as { expires_at?: string } | undefined : undefined
  if (isAuthenticated && token) {
    const minutes = authSessionConfig()
    const expires = new Date(Date.now() + 1000 * 60 * minutes).toISOString()
    db.prepare("UPDATE auth_sessions SET expires_at=? WHERE token=?").run(expires, token)
    res.setHeader("Set-Cookie", `miki_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${minutes * 60}`)
    row = { expires_at: expires }
  }
  res.json({ authenticated: isAuthenticated, initialized: Boolean(setting("dashboard_password")), session_timeout_minutes: authSessionConfig(), session_expires_at: row?.expires_at ? Date.parse(row.expires_at) : undefined })
})
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
  issueAuth(res); res.json({ ok: true, default_model_configured: Boolean(configuredModel() && (providerEnvironmentApiKey(process.env.MIKI_PROVIDER) || providerKeyOptional(process.env.MIKI_PROVIDER))) })
})
app.post("/api/auth/logout", (req, res) => { const token = cookie(req, "miki_session"); if (token) db.prepare("DELETE FROM auth_sessions WHERE token=?").run(token); res.setHeader("Set-Cookie", "miki_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"); res.json({ ok: true }) })

app.get("/api/gateway/status", (_req, res) => res.json({
  gateway_status: shutdownRequested ? "stopping" : "running",
  gateway_start_allowed: !shutdownRequested,
  pid: process.pid,
  lifecycle_owner: lifecycleOwner,
  gateway_restart_required: false,
  runtime_apply_status: "applied",
}))
app.get("/api/gateway/logs", (req, res) => {
  const requestedRunIdRaw = req.query.run_id
  const requestedRunId = requestedRunIdRaw === undefined || requestedRunIdRaw === "" ? undefined : Number(requestedRunIdRaw)
  const offsetValue = Number(req.query.offset ?? 0)
  const offset = Number.isFinite(offsetValue) ? Math.max(0, Math.floor(offsetValue)) : 0
  const filtered = gatewayLogs.filter((entry) => requestedRunId === undefined || entry.runId === requestedRunId)
  res.json({
    logs: filtered.slice(offset).map((entry) => `[${entry.at}] ${entry.message}`),
    log_total: filtered.length,
    log_run_id: gatewayRunId,
  })
})
app.post("/api/gateway/start", (_req, res) => {
  if (shutdownRequested) return res.status(409).json({ status: "failed", error: "Gateway shutdown is already in progress." })
  appendGatewayLog("Gateway start requested; current persistent process is already running.")
  return res.json({ status: "running", pid: process.pid, already_running: true, started: false, action: "already_running" })
})
app.post("/api/gateway/restart", (_req, res) => {
  appendGatewayLog("Gateway restart requested; process replacement remains owned by the launcher/supervisor.")
  return res.status(202).json({
    status: "pending_restart",
    pid: process.pid,
    process_restart_required: true,
    gateway_restart_required: true,
    runtime_apply_status: "pending_restart",
    message: "The launcher/supervisor must replace the gateway process. Use runtime reload only for in-process configuration changes.",
  })
})
app.post("/api/gateway/shutdown", (_req, res) => {
  if (shutdownRequested) return res.status(202).json({ status: "pending_shutdown", supported: true, pending: true, pid: process.pid })
  shutdownRequested = true
  appendGatewayLog("Gateway shutdown requested by dashboard.")
  const stopRequestPath = (process.env.MIKI_GATEWAY_STOP_FILE || process.env.MIKI_24_7_STOP_FILE)?.trim()
  if (stopRequestPath) {
    try {
      makeDirSync(path.dirname(stopRequestPath), { recursive: true })
      writeFileSync(stopRequestPath, JSON.stringify({ requested_at: now(), pid: process.pid }) + "\n", { mode: 0o600 })
    } catch (error) {
      return res.status(500).json({ status: "failed", supported: true, error: `Unable to record supervisor shutdown request: ${error instanceof Error ? error.message : String(error)}` })
    }
  }
  res.status(202).json({ status: "pending_shutdown", supported: true, pending: true, pid: process.pid, lifecycle_owner: lifecycleOwner })
  setTimeout(() => { try { process.kill(process.pid, "SIGTERM") } catch {} }, 50).unref()
  return undefined
})
app.post("/api/gateway/logs/clear", (_req, res) => { gatewayLogs.splice(0, gatewayLogs.length); gatewayRunId += 1; appendGatewayLog("Gateway log buffer cleared."); res.json({ status: "ok", log_run_id: gatewayRunId, log_total: gatewayLogs.length }) })
app.post("/api/runtime/reload", (_req, res) => {
  try {
    void configureRuntimeLoop()
    appendGatewayLog("Runtime configuration reloaded in-process.")
    return res.json({ status: "applied", applied: true, pending_restart: false, gateway_restart_required: false, runtime_apply_status: "applied", reloaded_at: now() })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return res.status(500).json({ status: "failed", applied: false, pending_restart: false, gateway_restart_required: false, runtime_apply_status: "failed", runtime_apply_error: detail, error: detail })
  }
})

app.get("/api/sessions", (_req, res) => {
  const rows = db.prepare("SELECT id FROM chat_sessions ORDER BY updated_at DESC").all() as { id: string }[]
  if (!rows.length) ensureSession("miki-main-chat")
  res.json((rows.length ? rows : [{ id: "miki-main-chat" }]).map((row) => sessionSummary(row.id)))
})
app.get("/api/sessions/:id", (req, res) => {
  const id = req.params.id; ensureSession(id)
  const summary = sessionSummary(id)
  const messages = (db.prepare("SELECT id,role,content,created_at,kind,model_name,context_id,image_urls,attachments_json FROM chat_messages WHERE session_id=? ORDER BY created_at ASC").all(id) as Array<Record<string, unknown>>).map((message) => {
    let attachments: unknown
    try { attachments = message.attachments_json ? JSON.parse(String(message.attachments_json)) : undefined } catch { attachments = undefined }
    const { attachments_json: _attachmentsJson, ...rest } = message
    return {
      ...rest,
      ...(Array.isArray(attachments) && attachments.length > 0 ? { attachments } : {}),
    }
  })
  res.json({ ...summary, messages, summary: "" })
})
app.patch("/api/sessions/:id", (req, res) => { ensureSession(req.params.id); if (typeof req.body?.title === "string") db.prepare("UPDATE chat_sessions SET title=?,updated_at=? WHERE id=?").run(req.body.title, now(), req.params.id); res.json(sessionSummary(req.params.id)) })
app.delete("/api/sessions/:id", (req, res) => { db.prepare("DELETE FROM chat_messages WHERE session_id=?").run(req.params.id); db.prepare("DELETE FROM chat_sessions WHERE id=?").run(req.params.id); res.status(204).end() })
const sessionMessage = (sessionId: string, messageId: string) => db.prepare("SELECT id,role,content,created_at,kind,model_name FROM chat_messages WHERE session_id=? AND id=?").get(sessionId, messageId) as Record<string, unknown> | undefined
app.patch("/api/sessions/:id/messages/:messageId", (req, res) => {
  const sessionId = req.params.id
  const messageId = req.params.messageId
  if (!sessionMessage(sessionId, messageId)) return res.status(404).json({ error: "Message not found" })
  const rawAttachments = Array.isArray(req.body?.attachments) ? req.body.attachments : []
  const attachments = rawAttachments.filter((item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === "object" && typeof (item as Record<string, unknown>).url === "string"))
  const imageUrls = attachments.filter((item) => item.type === "image").map((item) => String(item.url))
  if (typeof req.body?.content === "string") db.prepare("UPDATE chat_messages SET content=?,image_urls=?,attachments_json=? WHERE session_id=? AND id=?").run(req.body.content, imageUrls.length > 0 ? JSON.stringify(imageUrls) : null, attachments.length > 0 ? JSON.stringify(attachments.slice(0, 16)) : null, sessionId, messageId)
  db.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").run(now(), sessionId)
  return res.json({ session_id: sessionId, message: sessionMessage(sessionId, messageId) })
})
app.delete("/api/sessions/:id/messages/:messageId", (req, res) => {
  const result = db.prepare("DELETE FROM chat_messages WHERE session_id=? AND id=?").run(req.params.id, req.params.messageId)
  if (!result.changes) return res.status(404).json({ error: "Message not found" })
  db.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").run(now(), req.params.id)
  return res.status(204).end()
})
app.post("/api/sessions/:id/fork", (req, res) => {
  const sessionId = req.params.id
  ensureSession(sessionId)
  const targetId = String(req.body?.message_id || "")
  const messages = db.prepare("SELECT id,role,content,created_at,kind,model_name,context_id FROM chat_messages WHERE session_id=? ORDER BY created_at ASC").all(sessionId) as Array<Record<string, unknown>>
  const targetIndex = messages.findIndex((message) => message.id === targetId)
  if (targetIndex < 0) return res.status(404).json({ error: "Message not found" })
  const forkId = randomUUID()
  const stamp = now()
  const original = sessionSummary(sessionId)
  db.prepare("INSERT INTO chat_sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)").run(forkId, `${String(original.title || "Miki chat")} (fork)`, stamp, stamp)
  const insert = db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,model_name,context_id) VALUES(?,?,?,?,?,?,?,?)")
  for (const message of messages.slice(0, targetIndex + 1)) insert.run(randomUUID(), forkId, message.role, message.content, message.created_at, message.kind || "normal", message.model_name || null, message.context_id || null)
  const copied = db.prepare("SELECT id,role,content,created_at,kind,model_name,context_id FROM chat_messages WHERE session_id=? ORDER BY created_at ASC").all(forkId)
  return res.json({ session_id: forkId, messages: copied })
})
app.post("/api/sessions/:id/retry", (req, res) => {
  const sessionId = req.params.id
  ensureSession(sessionId)
  const targetId = String(req.body?.message_id || "")
  const target = sessionMessage(sessionId, targetId)
  if (!target) return res.status(404).json({ error: "Message not found" })
  const retryId = randomUUID()
  const stamp = now()
  const original = sessionSummary(sessionId)
  db.prepare("INSERT INTO chat_sessions(id,title,created_at,updated_at) VALUES(?,?,?,?)").run(retryId, `${String(original.title || "Miki chat")} (retry)`, stamp, stamp)
  const prior = db.prepare("SELECT id,role,content,created_at,kind,model_name,context_id FROM chat_messages WHERE session_id=? AND created_at<? ORDER BY created_at ASC").all(sessionId, target.created_at) as Array<Record<string, unknown>>
  const insert = db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,model_name,context_id) VALUES(?,?,?,?,?,?,?,?)")
  for (const message of prior) insert.run(randomUUID(), retryId, message.role, message.content, message.created_at, message.kind || "normal", message.model_name || null, message.context_id || null)
  return res.json({ session_id: retryId, message: target })
})

const providerEnvironmentApiKey = (provider: unknown): string => {
  const normalized = String(provider || "").trim().toLowerCase()
  if (normalized === "gemini" || normalized === "google") return process.env.GEMINI_API_KEY || ""
  if (normalized === "openrouter" || normalized === "open-router") return process.env.OPENROUTER_API_KEY || ""
  if (normalized === "openai-compatible" || normalized === "compatible" || normalized === "openai_compatible") return process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY || ""
  return process.env.OPENAI_API_KEY || ""
}
const providerKeyOptional = (provider: unknown): boolean => {
  const normalized = String(provider || "").trim().toLowerCase()
  return ["llama.cpp", "llama-cpp", "llamacpp", "local", "openai-compatible", "compatible", "openai_compatible"].includes(normalized)
}
const configuredModel = () => process.env.MIKI_MODEL || process.env.OPENAI_MODEL || (providerEnvironmentApiKey(process.env.MIKI_PROVIDER) ? "gpt-5-mini" : "")
const providerDefaultApiBase = (provider: unknown) => {
  const normalized = String(provider || "").trim().toLowerCase()
  if (normalized === "gemini" || normalized === "google") return process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta/openai/"
  if (normalized === "openrouter" || normalized === "open-router") return "https://openrouter.ai/api/v1"
  if (normalized === "openai-compatible" || normalized === "compatible" || normalized === "openai_compatible") return process.env.OPENAI_COMPATIBLE_BASE_URL || "http://127.0.0.1:8000/v1"
  if (normalized === "llama.cpp" || normalized === "llama-cpp" || normalized === "llamacpp" || normalized === "local") return process.env.MIKI_LLAMA_BASE_URL || "http://127.0.0.1:39200/v1"
  if (normalized === "openai" || normalized === "gpt" || normalized === "chatgpt") return "https://api.openai.com/v1"
  return ""
}
const modelPayload = (row: { id: number; payload: string; is_default: number }) => {
  const raw = JSON.parse(row.payload) as Record<string, unknown>
  const model = String(raw.model || raw.model_name || "")
  const keySet = Boolean(raw.api_key || providerEnvironmentApiKey(raw.provider))
  const local = isRecord(raw.local) ? raw.local : undefined
  const localConfigured = String(raw.provider || "").toLowerCase().includes("llama") && Boolean(local?.model_path)
  const keyOptional = providerKeyOptional(raw.provider)
  const apiBase = String(raw.api_base || providerDefaultApiBase(raw.provider) || process.env.OPENAI_API_BASE || "")
  const configured = Boolean(model) && (localConfigured || keySet || keyOptional)
  return { index: row.id, ...raw, model_name: String(raw.model_name || model), model, api_base: apiBase, api_key: "", api_key_set: keySet, enabled: raw.enabled !== false, available: configured, status: configured ? (keySet || localConfigured ? "available" : "configured") : "unconfigured", is_default: row.is_default === 1, is_virtual: false }
}
const storedModels = () => db.prepare("SELECT id,payload,is_default FROM model_configs ORDER BY id").all() as { id: number; payload: string; is_default: number }[]
const envModel = () => {
  const provider = process.env.MIKI_PROVIDER || "openai-compatible"
  return {
    model_name: configuredModel(),
    model: configuredModel(),
    provider,
    api_base: providerDefaultApiBase(provider) || process.env.OPENAI_API_BASE || "https://api.openai.com/v1",
    api_key_set: Boolean(providerEnvironmentApiKey(provider)),
    enabled: true,
  }
}
const providerOptions = () => [
  {
    id: "openai",
    display_name: "OpenAI",
    icon_slug: "openai",
    domain: "platform.openai.com",
    default_api_base: "https://api.openai.com/v1",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    common_models: ["gpt-5-mini", "gpt-4.1-mini"],
    aliases: ["gpt", "chatgpt"],
  },
  {
    id: "openai-compatible",
    display_name: "OpenAI Compatible",
    icon_slug: "openai",
    default_api_base: process.env.OPENAI_COMPATIBLE_BASE_URL || "http://127.0.0.1:8000/v1",
    empty_api_key_allowed: true,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    common_models: ["local-model"],
    aliases: ["compatible", "openai_compatible"],
  },
  {
    id: "openrouter",
    display_name: "OpenRouter",
    icon_slug: "openrouter",
    domain: "openrouter.ai",
    default_api_base: "https://openrouter.ai/api/v1",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    common_models: ["openai/gpt-4.1-mini", "anthropic/claude-3.7-sonnet"],
    aliases: ["open-router"],
  },
  {
    id: "gemini",
    display_name: "Google Gemini",
    icon_slug: "google",
    domain: "ai.google.dev",
    default_api_base: "https://generativelanguage.googleapis.com/v1beta/openai/",
    empty_api_key_allowed: false,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: true,
    common_models: ["gemini-3.5-flash-lite", "gemini-3.5-flash", "gemini-3.6-flash"],
    aliases: ["google"],
  },
  {
    id: "llama.cpp",
    display_name: "llama.cpp Local",
    icon_slug: "llama",
    domain: "127.0.0.1",
    default_api_base: process.env.MIKI_LLAMA_BASE_URL || "http://127.0.0.1:39200/v1",
    empty_api_key_allowed: true,
    create_allowed: true,
    default_model_allowed: true,
    supports_fetch: false,
    local: true,
    auth_method_locked: true,
    default_auth_method: "local",
    common_models: ["local-model"],
    aliases: ["llama-cpp", "llamacpp", "local"],
  },
]
const effectiveModel = () => {
  const rows = storedModels()
  if (rows.length) return modelPayload(rows.find((row) => row.is_default === 1) || rows[0])
  const model = configuredModel()
  const provider = process.env.MIKI_PROVIDER || "openai-compatible"
  const keySet = Boolean(providerEnvironmentApiKey(provider))
  const configured = Boolean(model && (keySet || providerKeyOptional(provider)))
  return model
    ? { index: 0, ...envModel(), api_key: "", available: configured, status: configured ? (keySet ? "available" : "configured") : "unconfigured", is_default: true, is_virtual: true }
    : null
}
app.get("/api/models", (_req, res) => {
  const rows = storedModels()
  const models = rows.map(modelPayload)
  res.json({ models, total: models.length, default_model: (models.find((item) => item.is_default) as { model?: string } | undefined)?.model || "", provider_options: providerOptions() })
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
  try { const content = await completeWithProvider([{ role: "user", content: "Reply with exactly OK" }], name, typeof model?.api_key === "string" ? model.api_key : undefined, typeof model?.api_base === "string" ? model.api_base : undefined, typeof model?.provider === "string" ? model.provider : undefined); return res.json({ success: Boolean(content), latency_ms: Date.now() - started, status: content ? "ok" : "failed", verification_level: "completion", completion_tested: true, final_response_received: Boolean(content), provider: String(model?.provider || "openai-compatible"), model: name, response_shape: { choiceCount: content ? 1 : 0, contentPresent: Boolean(content) } }) } catch (error) { return res.json({ success: false, latency_ms: Date.now() - started, status: "failed", ...providerFailure(error, String(model?.provider || "openai-compatible"), String(model?.api_base || providerDefaultApiBase(model?.provider) || "")), model: name }) }
})
app.post("/api/models/test-inline", async (req, res) => { const model = String(req.body?.model || ""); try { const content = await completeWithProvider([{ role: "user", content: "Reply with exactly OK" }], model, req.body?.api_key, req.body?.api_base, req.body?.provider); res.json({ success: Boolean(content), latency_ms: 0, status: content ? "ok" : "failed", completion_tested: true, final_response_received: Boolean(content), model }) } catch (error) { res.json({ success: false, latency_ms: 0, status: "failed", ...providerFailure(error, String(req.body?.provider || "openai-compatible"), String(req.body?.api_base || providerDefaultApiBase(req.body?.provider) || "")), model }) } })
app.post("/api/models/fetch", async (req, res) => {
  const provider = String(req.body?.provider || "openai-compatible")
  const base = String(req.body?.api_base || providerDefaultApiBase(provider) || process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/$/, "")
  const key = String(req.body?.api_key || providerEnvironmentApiKey(provider) || "")
  const keyOptional = providerKeyOptional(provider)
  if (!key && !keyOptional) return res.status(400).json({ error: `API key is required for provider '${provider}'.`, error_category: "provider_api_key", provider })
  try {
    const response = await fetch(`${base}/models`, { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(30_000) })
    const body = await response.json().catch(() => ({})) as { data?: Array<{ id: string; owned_by?: string; [key: string]: unknown }>; error?: { message?: string } }
    if (!response.ok) throw new ProviderRequestError(body.error?.message || `Model provider returned HTTP ${response.status}`, "upstream_provider_error", provider, response.status)
    const models = Array.isArray(body.data) ? body.data : []
    const apiKeyMask = key ? (key.length <= 8 ? "••••" : `${key.slice(0, 4)}…${key.slice(-4)}`) : ""
    const catalogId = Buffer.from(`${provider}:${base}`).toString("base64url")
    db.prepare("INSERT INTO model_catalogs(id,provider,api_base,api_key_mask,models_json,fetched_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET provider=excluded.provider,api_base=excluded.api_base,api_key_mask=excluded.api_key_mask,models_json=excluded.models_json,fetched_at=excluded.fetched_at").run(catalogId, provider, base, apiKeyMask, JSON.stringify(models), now())
    return res.json({ models, total: models.length })
  } catch (error) {
    const detail = providerFailure(error, provider, base)
    return res.status(error instanceof ProviderRequestError && error.status === 401 ? 401 : 502).json(detail)
  }
})
const getAppConfig = () => { const raw = setting("app_config")?.value; if (!raw) return {}; try { return JSON.parse(raw) as Record<string, unknown> } catch { return {} } }
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value))
const deepMerge = (base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> => { const out: Record<string, unknown> = { ...base }; for (const [key, value] of Object.entries(incoming)) { const current = out[key]; if (isRecord(current) && isRecord(value)) out[key] = deepMerge(current, value); else out[key] = value } return out }
const fileMemory = new FileMemoryService({
  identityDir: path.join(configDir, "identity"),
  agentMemoryConfig: (getAppConfig() as any)?.agent?.memory,
  seed: { summarizeTokenPercent: 75, summarizeMessageThreshold: 8 },
})

const validateStoredConfig = (candidate: Record<string, unknown>) => {
  const result = validateRuntimeConfig(candidate)
  return {
    ...result,
    config: result.config as Record<string, unknown>,
    errors: result.errors,
    warnings: result.warnings,
  }
}

app.get("/api/config", (_req, res) =>
  res.json({ ...getAppConfig(), workspace: workspaceRoot }),
)
app.post("/api/config/validate", requireAuth, (req, res) => {
  const candidate = isRecord(req.body) ? req.body : {}
  const result = validateStoredConfig(candidate)
  res.status(result.valid ? 200 : 400).json(result)
})
app.put("/api/config", requireAuth, (req, res) => {
  const candidate = isRecord(req.body) ? req.body : {}
  const result = validateStoredConfig(candidate)
  if (!result.valid) return res.status(400).json({ status: "validation_error", errors: result.errors, warnings: result.warnings })
  const normalized = migrateRuntimeConfig(result.config as Record<string, unknown>) as Record<string, unknown>
  const backupDir = path.join(dataRoot, "backups")
  makeDirSync(backupDir, { recursive: true })
  const backupFile = path.join(backupDir, `config-before-save-${Date.now()}.json`)
  try { writeFileSync(backupFile, JSON.stringify({ createdAt: now(), config: getAppConfig() }, null, 2), { mode: 0o600 }) } catch {}
  putSetting("app_config", JSON.stringify(normalized))
  void configureRuntimeLoop()
  res.json({ status: "ok", config: normalized, warnings: result.warnings, backup_file: backupFile, runtime_apply_status: "applied", gateway_restart_required: false })
})
app.post("/api/config/rollback", requireAuth, (_req, res) => {
  const backupDir = path.join(dataRoot, "backups")
  let files: string[] = []
  try { files = readdirSync(backupDir).filter((name) => (name.startsWith("config-before-save-") || name.startsWith("config-before-patch-")) && name.endsWith(".json")).sort().reverse() } catch {}
  const latest = files[0]
  if (!latest) return res.status(404).json({ error: "No configuration backup is available." })
  try {
    const payload = JSON.parse(readFileSync(path.join(backupDir, latest), "utf8")) as { config?: unknown }
    if (!isRecord(payload.config)) return res.status(422).json({ error: "Configuration backup is invalid." })
    const result = validateStoredConfig(payload.config)
    if (!result.valid) return res.status(422).json({ error: "Configuration backup failed validation.", errors: result.errors })
    putSetting("app_config", JSON.stringify(result.config))
    return res.json({ status: "rolled_back", config: result.config, backup_file: latest, runtime_apply_status: "applied", gateway_restart_required: false })
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})
app.patch("/api/config", requireAuth, (req, res) => {
  const body = isRecord(req.body) ? req.body : {}
  const next = deepMerge(getAppConfig(), body)
  const result = validateStoredConfig(next)
  if (!result.valid) return res.status(400).json({ status: "validation_error", errors: result.errors, warnings: result.warnings })
  const normalized = migrateRuntimeConfig(result.config as Record<string, unknown>) as Record<string, unknown>
  const backupDir = path.join(dataRoot, "backups")
  makeDirSync(backupDir, { recursive: true })
  try { writeFileSync(path.join(backupDir, `config-before-patch-${Date.now()}.json`), JSON.stringify({ createdAt: now(), config: getAppConfig() }, null, 2), { mode: 0o600 }) } catch {}
  putSetting("app_config", JSON.stringify(normalized))
  void configureRuntimeLoop()
  res.json({ status: "ok", config: normalized, warnings: result.warnings, runtime_apply_status: "applied", gateway_restart_required: false })
})
app.post("/api/config/test-command-patterns", requireAuth, (req, res) => {
  const allowPatterns = Array.isArray(req.body?.allow_patterns) ? req.body.allow_patterns.filter((v: unknown): v is string => typeof v === "string") : []
  const denyPatterns = Array.isArray(req.body?.deny_patterns) ? req.body.deny_patterns.filter((v: unknown): v is string => typeof v === "string") : []
  const command = String(req.body?.command || "").trim().toLowerCase()
  if (!command) return res.status(400).json({ error: "command is required" })
  for (const pattern of allowPatterns) {
    try {
      if (new RegExp(pattern).test(command)) return res.json({ allowed: true, blocked: false, matched_whitelist: pattern, matched_blacklist: null })
    } catch { /* invalid regex patterns are ignored */ }
  }
  for (const pattern of denyPatterns) {
    try {
      if (new RegExp(pattern).test(command)) return res.json({ allowed: false, blocked: true, matched_whitelist: null, matched_blacklist: pattern })
    } catch { /* invalid regex patterns are ignored */ }
  }
  return res.json({ allowed: false, blocked: false, matched_whitelist: null, matched_blacklist: null })
})
app.get("/api/system/version", (_req, res) => res.json({ version: "1.3.14", go_version: "not used by Node backend" }))
/** File execution is on by default. MIKI_FILE_EXECUTION=false or app_config.files.execution_enabled=false turns it off at runtime. */
const fileExecutionEnabled = () => {
  if (String(process.env.MIKI_FILE_EXECUTION ?? "").toLowerCase() === "false") return false
  const files = getAppConfig().files as { execution_enabled?: unknown } | undefined
  return files?.execution_enabled !== false
}
const recordFileRun = (entry: { file: string; args: string[]; status: string; exitCode: number | null; durationMs: number; source: string }) => {
  try { db.prepare("INSERT INTO file_runs(run_at,file,args,status,exit_code,duration_ms,source) VALUES(?,?,?,?,?,?,?)").run(now(), entry.file, JSON.stringify(entry.args), entry.status, entry.exitCode, entry.durationMs, entry.source) } catch (error) { console.warn("[miki] could not record file run", error) }
}
const skills = createSkillsService({ dataDir: dataRoot, workspaceDir: workspaceRoot, getAppConfig })
const recordSkillEvent = (event: { action: string; subject: string; status: string; detail?: Record<string, unknown> }) => {
  try { db.prepare("INSERT INTO skill_events(at,action,subject,status,detail) VALUES(?,?,?,?,?)").run(now(), event.action, event.subject, event.status, JSON.stringify(event.detail ?? {})) } catch (error) { console.warn("[miki] could not record skill event", error) }
}
app.post("/api/config/reset", requireAuth, (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupsDir = path.join(dataRoot, "backups")
  makeDirSync(backupsDir, { recursive: true })
  const rows = db.prepare("SELECT key,value FROM settings WHERE key IN ('app_config','launcher_config','autostart_enabled','safe_mode')").all()
  const backupFile = path.join(backupsDir, `factory-reset-${timestamp}.json`)
  try { writeFileSync(backupFile, JSON.stringify({ type: "factory-reset", createdAt: new Date().toISOString(), settings: rows }, null, 2), { mode: 0o600 }) } catch { /* reset can continue even if backup creation fails */ }
  db.prepare("DELETE FROM settings WHERE key IN ('app_config','launcher_config','autostart_enabled','safe_mode')").run()
  res.json({ status: "ok", config: {}, reset: { factory_defaults_applied: true, preserved: ["dashboard_password", "model_configs", "api_keys", "security_credentials"], backup_file: backupFile } })
})
let gatewayRunId = Math.floor(Date.now() / 1000)
const gatewayLogs: Array<{ runId: number; message: string; at: string }> = []
const appendGatewayLog = (message: string) => { gatewayLogs.push({ runId: gatewayRunId, message, at: now() }); if (gatewayLogs.length > 500) gatewayLogs.splice(0, gatewayLogs.length - 500) }
appendGatewayLog("Gateway initialization started.")
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
  skills,
  log: (message, details) => console.warn(`[miki] ${message}`, details ?? {}),
})
const proactiveSockets = new Set<WebSocket>()
const broadcastProactive = async (input: { text: string; runId?: string; goalId?: number; kind?: string }) => {
  const text = input.text.trim()
  if (!text) return
  const createdAt = now()
  const messageId = `proactive-${randomUUID()}`
  const sessionId = "miki-main-chat"
  ensureSession(sessionId)
  db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,model_name,context_id) VALUES(?,?,?,?,?,?,?,?)").run(
    messageId, sessionId, "assistant", text, createdAt, "normal", null, `proactive:${input.runId || messageId}`,
  )
  db.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").run(createdAt, sessionId)
  const payload = {
    message_id: messageId,
    content: text,
    kind: "normal",
    proactive: true,
    source: "full_agent_autonomy",
    ...(input.runId ? { run_id: input.runId } : {}),
    ...(input.goalId !== undefined ? { goal_id: input.goalId } : {}),
    ...(input.kind ? { notification_kind: input.kind } : {}),
  }
  for (const socket of proactiveSockets) {
    if (socket.readyState !== socket.OPEN) continue
    try { socket.send(JSON.stringify({ type: "proactive.message", timestamp: Date.now(), payload })) } catch {}
  }
}
const autonomy = new AutonomousSupervisor({
  db,
  agent: agent.engine,
  tools: agent.registry,
  activeRunCount: agent.activeRunCount,
  getConfig: getAppConfig,
  log: appendGatewayLog,
  workspaceRoot,
  notify: broadcastProactive,
  heartbeatProbe: () => {
    const model = agent.llmFor()
    return model
      ? { ok: true, detail: `LLM provider ready: ${model.model}` }
      : { ok: false, detail: "No LLM provider is currently ready." }
  },
  recordExperience: (input) => {
    autonomyLearningStore.recordExperience({
      runId: input.runId,
      taskId: input.taskId == null ? undefined : String(input.taskId),
      taskClass: "autonomy_goal",
      contextSummary: `${input.goalTitle}\n${input.goalDescription || ""}`.trim(),
      actionKey: input.planDigest || "baseline",
      actionPayload: { goalId: input.goalId, acceptance: input.acceptance },
      outcome: input.outcome,
      reward: input.reward,
      idempotencyKey: `autonomy:${input.runId}`,
      metadata: { goalId: input.goalId },
    })
  },
})
getLifecycleBus().on("gateway:startup", (payload) => { autonomy.wake(); void autonomy.triggerEvent("gateway:startup", payload) })
getLifecycleBus().on("message:received", (payload) => { autonomy.wake(); void autonomy.triggerEvent("message:received", payload) })
getLifecycleBus().on("message:sent", (payload) => { autonomy.wake(); void autonomy.triggerEvent("message:sent", payload) })
getLifecycleBus().emit("gateway:startup", { pid: process.pid, reason: "gateway_initialized" })
agent.mount(app)

app.get("/api/autonomy/status", requireAuth, (_req, res) => res.json(autonomy.status()))
app.post("/api/autonomy/tick", requireAuth, async (_req, res) => {
  try {
    return res.json(await autonomy.tick("manual"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    appendGatewayLog(`Manual autonomy tick failed: ${message}`)
    return res.status(500).json({ status: "blocked", error: message })
  }
})

// Persistent autonomous task/schedule queue. All endpoints require gateway auth.
app.get("/api/autonomy/tasks", requireAuth, (req, res) => {
  const limit = Number(req.query.limit ?? 50)
  return res.json({ tasks: autonomy.listScheduledTasks(Number.isFinite(limit) ? limit : 50) })
})
app.post("/api/autonomy/tasks", requireAuth, (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {}
    if (typeof body.title !== "string") return res.status(400).json({ error: "title is required." })
    if (body.description !== undefined && typeof body.description !== "string") return res.status(400).json({ error: "description must be a string." })
    if (body.due_at !== undefined && typeof body.due_at !== "string") return res.status(400).json({ error: "due_at must be an ISO date/time string." })
    if (body.interval_seconds !== undefined && typeof body.interval_seconds !== "number") return res.status(400).json({ error: "interval_seconds must be a number." })
    if (body.max_retries !== undefined && typeof body.max_retries !== "number") return res.status(400).json({ error: "max_retries must be a number." })
    const task = autonomy.enqueueTask({
      title: body.title,
      description: body.description as string | undefined,
      dueAt: body.due_at as string | undefined,
      intervalSeconds: body.interval_seconds as number | undefined,
      priority: typeof body.priority === "number" ? body.priority : undefined,
      maxRetries: typeof body.max_retries === "number" ? body.max_retries : undefined,
      idempotencyKey: typeof body.idempotency_key === "string" ? body.idempotency_key : undefined,
      acceptance: body.acceptance && typeof body.acceptance === "object" && !Array.isArray(body.acceptance) ? body.acceptance as never : null,
    })
    autonomy.wake()
  return res.status(201).json({ task })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return res.status(400).json({ error: message })
  }
})
app.get("/api/autonomy/triggers", requireAuth, (req, res) => {
  const limit = Number(req.query.limit ?? 100)
  return res.json({ triggers: autonomy.listEventTriggers(Number.isFinite(limit) ? limit : 100) })
})
app.post("/api/autonomy/triggers", requireAuth, (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {}
    if (typeof body.event_name !== "string" || typeof body.title !== "string") return res.status(400).json({ error: "event_name and title are required." })
    const trigger = autonomy.addEventTrigger({
      eventName: body.event_name,
      title: body.title,
      description: typeof body.description === "string" ? body.description : undefined,
      filter: body.filter && typeof body.filter === "object" && !Array.isArray(body.filter) ? body.filter as Record<string, unknown> : undefined,
      acceptance: body.acceptance && typeof body.acceptance === "object" && !Array.isArray(body.acceptance) ? body.acceptance as never : null,
    })
    return res.status(201).json({ trigger })
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : String(error) })
  }
})
app.post("/api/autonomy/triggers/:id/disable", requireAuth, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id)) return res.status(400).json({ error: "invalid trigger id" })
  return res.json({ disabled: autonomy.disableEventTrigger(id) })
})
app.delete("/api/autonomy/tasks/:id", requireAuth, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ error: "Invalid task id." })
  const task = autonomy.cancelScheduledTask(id)
  if (!task) return res.status(404).json({ error: "Scheduled task not found or already started." })
  return res.json({ task })
})

app.get("/api/orchestrator/status", requireAuth, (_req, res) => {
  res.json({ engine: "FULL_AGENT", router: null, active_runs: agent.activeRunCount(), autonomous: autonomy.status(), embedding_provider: embeddingProvider.constructor.name })
})

app.get("/api/runtime/status", requireAuth, (_req, res) => {
  res.json({ engine: "FULL_AGENT", active_runs: agent.activeRunCount(), autonomous: autonomy.status() })
})

app.get("/api/orchestrator/runs/:id", requireAuth, (req, res) => {
  const row = db.prepare("SELECT run_id,goal_id,status,started_at,finished_at,result,error,attempt,next_retry_at,plan_digest,acceptance_result FROM autonomy_goal_runs WHERE run_id=?").get(req.params.id) as Record<string, unknown> | undefined
  if (!row) return res.status(404).json({ error: "FULL_AGENT runtime run not found." })
  return res.json({
    run_id: row.run_id,
    engine: "FULL_AGENT",
    goal_id: row.goal_id,
    status: row.status,
    started_at: row.started_at || null,
    finished_at: row.finished_at || null,
    result: row.result || null,
    error: row.error || null,
    attempt: row.attempt,
    next_retry_at: row.next_retry_at || null,
    plan_digest: row.plan_digest || null,
    acceptance_result: row.acceptance_result ? JSON.parse(String(row.acceptance_result)) : null,
  })
})

// The frontend exposes an agent-readiness test alongside the completion test.
// Keep this route separate from the basic completion probe so the UI can
// distinguish an available model from a runtime with registered tools.
const toolReadinessResponse = (model: string, completion: boolean, started: number) => {
  const tools = agent.registry.names()
  const modelReady = Boolean(agent.llmFor(model))
  const toolsReady = tools.length > 0
  return {
    success: completion && modelReady && toolsReady,
    latency_ms: Date.now() - started,
    status: completion && modelReady && toolsReady ? "ok" : "failed",
    readiness_status: modelReady && toolsReady ? "ready" : "unavailable",
    verification_level: "tools",
    completion_tested: true,
    tools_tested: true,
    dry_run_executed: false,
    final_response_received: completion,
    provider: "openai-compatible",
    model,
    tool_name: tools[0] || undefined,
    response_shape: { choiceCount: completion ? 1 : 0, contentPresent: completion },
    ...(completion && modelReady && toolsReady ? {} : { error: !modelReady ? "Model is not configured for the runtime." : "No tools are registered in the agent runtime." }),
  }
}
app.post("/api/models/:index/test-tools", async (req, res) => {
  const started = Date.now()
  const modelConfig = modelForIndex(Number(req.params.index)) as Record<string, unknown> | null
  const model = String(modelConfig?.model || modelConfig?.model_name || configuredModel())
  try {
    const content = await completeWithProvider([{ role: "user", content: "Reply with exactly OK" }], model, typeof modelConfig?.api_key === "string" ? modelConfig.api_key : undefined, typeof modelConfig?.api_base === "string" ? modelConfig.api_base : undefined, typeof modelConfig?.provider === "string" ? modelConfig.provider : undefined)
    return res.json(toolReadinessResponse(model, Boolean(content), started))
  } catch (error) {
    return res.json({ ...toolReadinessResponse(model, false, started), ...providerFailure(error, String(modelConfig?.provider || "openai-compatible"), String(modelConfig?.api_base || providerDefaultApiBase(modelConfig?.provider) || "")) })
  }
})
app.post("/api/models/test-tools-inline", async (req, res) => {
  const started = Date.now()
  const model = String(req.body?.model || "")
  try {
    const content = await completeWithProvider([{ role: "user", content: "Reply with exactly OK" }], model, req.body?.api_key, req.body?.api_base, req.body?.provider)
    const response = toolReadinessResponse(model, Boolean(content), started)
    return res.json({ ...response, provider: String(req.body?.provider || response.provider) })
  } catch (error) {
    return res.json({ ...toolReadinessResponse(model, false, started), provider: String(req.body?.provider || "openai-compatible"), ...providerFailure(error, String(req.body?.provider || "openai-compatible"), String(req.body?.api_base || providerDefaultApiBase(req.body?.provider) || "")) })
  }
})

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
// Skills: list, detail, search, import, install, delete, plugin catalog and readiness.
app.use("/api/skills", requireAuth, createSkillsRouter({
  store: skills.store,
  registry: skills.registry,
  workspaceDir: workspaceRoot,
  downloadedSkillsDir: skills.downloadedSkillsDir,
  configPath: path.join(workspaceRoot, "config", "tools.yaml"),
  audit: recordSkillEvent,
  pluginHealth: () => {
    const llm = agent.llmFor()
    const executionOn = fileExecutionEnabled()
    return {
      "tools.core-registry": { ok: agent.registry.size > 0, status: agent.registry.size > 0 ? "functional" : "partial", message: `${agent.registry.size} tool(s) registered.` },
      "workflow.agent-loop": { ok: Boolean(llm), status: llm ? "functional" : "partial", message: llm ? `Model ${llm.model} resolved.` : "No model with credentials is configured." },
      "code-execution.runtime-fetch": { ok: executionOn, status: executionOn ? "partial" : "disabled", message: executionOn ? undefined : "Script execution is switched off." },
      "storage.local": { ok: existsSync(dataRoot), status: existsSync(dataRoot) ? "functional" : "partial", message: dataRoot },
    }
  },
}))
let browserReadyCache: { ready: boolean; at: number } | undefined
const browserReady = async (): Promise<boolean> => {
  if (browserReadyCache && Date.now() - browserReadyCache.at < 60_000) return browserReadyCache.ready
  let ready = false
  try {
    const moduleName = "playwright"
    const pw = (await import(moduleName)) as { chromium?: { executablePath(): string } }
    const candidates = [
      process.env.MIKI_BROWSER_CHROME_PATH,
      pw.chromium?.executablePath(),
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
    ].filter((value): value is string => Boolean(value))
    ready = candidates.some((executable) => existsSync(executable))
  } catch {
    ready = false
  }
  browserReadyCache = { ready, at: Date.now() }
  return ready
}
app.get("/api/tools", async (_req, res) => {
  const state = (getAppConfig().tools as { tool_state?: Record<string, boolean> } | undefined)?.tool_state ?? {}
  // Members come from the full tool list, so a disabled group still shows what it would provide.
  const known = new Set(agent.allToolNames())
  const group = (key: string, name: string, description: string, category: string, defaultEnabled: boolean, members: string[], blockedReason?: string) => {
    const enabled = typeof state[key] === "boolean" ? state[key] : defaultEnabled
    const status = enabled && blockedReason ? "blocked" : enabled ? "enabled" : "disabled"
    return { name, description, category, config_key: key, status, config_enabled: enabled, ...(enabled && blockedReason ? { reason_code: blockedReason } : {}), tools: members.filter((m) => known.has(m)) }
  }
  const browserBlocked = (await browserReady()) ? undefined : "browser_not_installed"
  res.json({ tools: [
    group("filesystem", "filesystem", "Read, search, organize and (with approval) write, delete or run files inside the workspace.", "workspace", true, ["workspace_list", "file_read", "workspace_search", "file_write", "file_info", "file_mkdir", "file_rename", "file_move", "file_copy", "file_delete", "file_run"]),
    group("memory", "memory", "Search and store long-term memory notes.", "memory", true, ["memory_search", "memory_add"]),
    group("skills", "skills", "Discover, read and run installed skills; install or delete them (with approval).", "skills", true, ["skill_list", "skill_read", "skill_search", "skill_run", "skill_install", "skill_delete"]),
    group("control", "agent-control", "Typed, approval-gated agent configuration operations.", "system", true, ["agent_control_capabilities", "agent_control_state", "agent_control_plan", "agent_control_request", "agent_control_execute"]),
    group("web_search", "web-search", "Search the web through the configured local or cloud provider.", "network", true, ["web_search"]),
    group("browser", "browser", "Playwright browser tools: open pages, click, type, extract and screenshot like a human.", "browser", true, ["browser_navigate", "browser_click", "browser_type", "browser_extract", "browser_screenshot"], browserBlocked),
    group("terminal", "terminal", "Run any shell command like a human at a terminal (set MIKI_TERMINAL_SAFE=true to add approval and guard rails).", "system", true, ["terminal_run"]),
  ] })
})
app.put("/api/tools/:name/state", requireAuth, async (req, res) => {
  const name = decodeURIComponent(String(req.params.name || "")).trim()
  const enabled = req.body?.enabled
  if (!name) return res.status(400).json({ error: "Tool name is required." })
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "enabled must be a boolean." })
  const key = resolveToolGroupKey(name)
  if (!key) return res.status(404).json({ error: `Tool group "${name}" is not available in this backend.` })
  try {
    const result = await agent.setToolState(key, enabled)
    return res.json(result)
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})
const webSearchConfig = () => {
  const value = getAppConfig().web_search
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { execution_mode: "local", provider: "", current_service: "", prefer_native: false, providers: [], settings: {} }
}
app.get("/api/tools/web-search-config", (_req, res) => res.json(webSearchConfig()))
app.put("/api/tools/web-search-config", requireAuth, (req, res) => {
  const incoming = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : null
  if (!incoming) return res.status(400).json({ error: "A web-search configuration object is required." })
  const allowed = ["execution_mode", "provider", "current_service", "prefer_native", "proxy", "optimization", "providers", "settings"]
  const next = Object.fromEntries(Object.entries(incoming).filter(([key]) => allowed.includes(key)))
  putSetting("app_config", JSON.stringify({ ...getAppConfig(), web_search: { ...webSearchConfig(), ...next } }))
  return res.json({ ...webSearchConfig(), runtime_apply_status: "applied", gateway_restart_required: false })
})
app.get("/api/memory/stats", (_req, res) => { const rows = memoryRows(); const byRegion = [...new Set(rows.map((row) => String(row.region)))].map((region) => ({ region, count: rows.filter((row) => row.region === region).length })); const vectorCount = Number((db.prepare("SELECT COUNT(*) AS count FROM memory_vectors").get() as { count?: number })?.count || 0); res.json({ scope: {}, stats: { chunks: rows.length, edges: 0, postings: rows.length, retrievals: 0, vector_indexed: vectorCount, embedding_provider: embeddingProvider.name, byRegion } }) })
app.get("/api/memory/chunks", (req, res) => { const chunks = memoryRows(req.query.region ? String(req.query.region) : undefined).slice(0, Number(req.query.limit || 80)).map((row) => ({ ...row, access_count: 0, status: "active", metadata: {} })); res.json({ scope: {}, chunks }) })
app.post("/api/memory/chunks", (req, res) => { const content = String(req.body?.content || "").trim(); if (!content) return res.status(400).json({ error: "content is required" }); const id = randomUUID(); const timestamp = now(); db.prepare("INSERT INTO memory_chunks(id,region,content,summary,provenance,confidence,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)").run(id, String(req.body?.region || "long_term"), content, String(req.body?.summary || content.slice(0, 160)), String(req.body?.provenance || "manual"), Number(req.body?.confidence ?? 1), Number(req.body?.importance ?? 0.5), timestamp, timestamp); res.json({ status: "created", id }) })
app.get("/api/memory/search", (req, res) => { const query = String(req.query.q || "").trim().toLowerCase(); const items = memoryRows().filter((row) => String(row.content).toLowerCase().includes(query)).slice(0, Number(req.query.maxSelected || 12)).map((row) => ({ id: row.id, text: row.content, summary: row.summary, region: row.region, provenance: row.provenance, confidence: row.confidence, importance: row.importance, score: 1, lexical: 1, semantic: 0, depth: 0, sourceType: "sqlite" })); res.json({ query, scope: {}, result: { items, text: items.map((item) => item.text).join("\n"), trace: {}, stats: { candidateCount: items.length, selectedCount: items.length, tokensUsed: 0, maxTokens: Number(req.query.maxTokens || 1200), latencyMs: 0 } } })
})
app.post("/api/memory/reindex", async (_req, res) => {
  try {
    const rows = memoryRows()
    const texts = rows.map((row) => `${String(row.summary || "")}\n${String(row.content || "")}`)
    const vectors = embeddingProvider.embedBatch ? await embeddingProvider.embedBatch(texts) : await Promise.all(texts.map((text) => embeddingProvider.embed(text)))
    const upsert = db.prepare("INSERT INTO memory_vectors(chunk_id,embedding,dimensions,updated_at) VALUES(?,?,?,?) ON CONFLICT(chunk_id) DO UPDATE SET embedding=excluded.embedding,dimensions=excluded.dimensions,updated_at=excluded.updated_at")
    const txn = db.transaction((items: Array<{ id: string; vector: ArrayLike<number> }>) => {
      for (const item of items) upsert.run(item.id, JSON.stringify(Array.from(item.vector)), item.vector.length, now())
    })
    txn(rows.map((row, index) => ({ id: String(row.id), vector: vectors[index] })))
    return res.json({ result: { reindexed: rows.length, provider: embeddingProvider.name } })
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
  }
})
app.get("/api/memory/chunks/:id", (req, res) => { const row = db.prepare("SELECT * FROM memory_chunks WHERE id=?").get(req.params.id) as Record<string, unknown> | undefined; if (!row) return res.status(404).json({ error: "Memory chunk not found" }); return res.json({ scope: {}, chunk: { ...row, edges: [] } }) })
app.post("/api/memory/chunks/:id/forget", (req, res) => { const result = db.prepare("DELETE FROM memory_chunks WHERE id=?").run(req.params.id); res.json({ result: { forgotten: result.changes > 0, chunkId: req.params.id } }) })
const mikiInfo = (req: express.Request) => {
  const config = getAppConfig()
  const channels = isRecord(config.channel_list) ? config.channel_list : {}
  const raw = isRecord(channels.miki) ? channels.miki : {}
  const settings = isRecord(raw.settings) ? raw.settings : {}
  const token = String(settings.token || raw.token || "")
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim()
  const protocol = forwardedProto === "https" ? "wss" : "ws"
  const hostHeader = String(req.headers.host || `127.0.0.1:${currentPort}`)
  return { ws_url: `${protocol}://${hostHeader}/miki/ws`, enabled: raw.enabled === true, configured: Boolean(token) }
}
app.get("/api/miki/info", requireAuth, (req, res) => res.json(mikiInfo(req)))
app.post("/api/miki/token", requireAuth, (req, res) => {
  const token = randomBytes(16).toString("hex")
  const current = getAppConfig()
  const channels = isRecord(current.channel_list) ? current.channel_list : {}
  const raw = isRecord(channels.miki) ? channels.miki : {}
  const settings = isRecord(raw.settings) ? raw.settings : {}
  const next = deepMerge(current, { channel_list: { miki: { ...raw, settings: { ...settings, token }, enabled: raw.enabled === true } } })
  putSetting("app_config", JSON.stringify(next))
  appendGatewayLog("Miki channel token rotated through dashboard API.")
  res.json(mikiInfo(req))
})
app.post("/api/miki/setup", requireAuth, (req, res) => {
  const current = getAppConfig()
  const channels = isRecord(current.channel_list) ? current.channel_list : {}
  const raw = isRecord(channels.miki) ? channels.miki : {}
  const settings = isRecord(raw.settings) ? raw.settings : {}
  const token = String(settings.token || raw.token || "") || randomBytes(16).toString("hex")
  const changed = raw.enabled !== true || !String(settings.token || raw.token || "")
  const next = deepMerge(current, { channel_list: { miki: { ...raw, type: "miki", enabled: true, settings: { ...settings, token } } } })
  putSetting("app_config", JSON.stringify(next))
  appendGatewayLog(`Miki channel setup completed${changed ? " with configuration changes" : " (already configured)"}.`)
  res.json({ ...mikiInfo(req), enabled: true, configured: true, changed })
})

type ProviderErrorCategory = "provider_api_key" | "local_model_unavailable" | "upstream_provider_error" | "provider_network"

class ProviderRequestError extends Error {
  constructor(
    message: string,
    readonly category: ProviderErrorCategory,
    readonly provider: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "ProviderRequestError"
  }
}

function isLocalProvider(provider: string, base: string): boolean {
  return /llama[-.]?cpp|local/.test(provider.toLowerCase()) || /https?:\/\/(127\.0\.0\.1|localhost|::1)(:\d+)?(?:\/|$)/i.test(base)
}

function providerFailure(error: unknown, provider: string, base: string): { error: string; error_category: ProviderErrorCategory; provider: string } {
  if (error instanceof ProviderRequestError) {
    return { error: error.message, error_category: error.category, provider: error.provider }
  }
  const detail = error instanceof Error ? error.message : String(error)
  return {
    error: detail,
    error_category: isLocalProvider(provider, base) ? "local_model_unavailable" : "provider_network",
    provider,
  }
}

async function completeWithProvider(messages: { role: string; content: string }[], model: string, requestKey?: string, requestBase?: string, requestProvider?: string) {
  const provider = String(requestProvider || process.env.MIKI_PROVIDER || "openai").trim() || "openai"
  const key = requestKey || providerEnvironmentApiKey(provider)
  const base = (requestBase || providerDefaultApiBase(provider) || process.env.OPENAI_API_BASE || "https://api.openai.com/v1").replace(/\/$/, "")
  const keyOptional = providerKeyOptional(provider)
  if (!key && !keyOptional) {
    throw new ProviderRequestError(`API key is required for provider '${provider}'.`, "provider_api_key", provider)
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (key) headers.Authorization = `Bearer ${key}`
  let response: Response
  try {
    response = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, temperature: 0.7, max_completion_tokens: 1024, reasoning: { effort: "minimal" } }),
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    if (isLocalProvider(provider, base)) {
      throw new ProviderRequestError(`Local model is unavailable at ${base}.`, "local_model_unavailable", provider)
    }
    throw new ProviderRequestError(`Unable to reach provider '${provider}': ${error instanceof Error ? error.message : String(error)}`, "provider_network", provider)
  }
  const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } }
  if (!response.ok) throw new ProviderRequestError(body.error?.message || `Model provider returned HTTP ${response.status}`, "upstream_provider_error", provider, response.status)
  const content = body.choices?.[0]?.message?.content || ""
  if (!content) throw new ProviderRequestError("Provider returned no completion content.", "upstream_provider_error", provider, response.status)
  return content
}

const wss = new WebSocketServer({ noServer: true })
type ActiveRunState = {
  runId: string
  sessionId: string
  checkpointId: string
  sequence: number
  events: string[]
  socket: WebSocket | null
  done: boolean
  expiresAt: number
}
const activeRuns = new Map<string, ActiveRunState>()
const STREAM_RESUME_GRACE_MS = 30_000

const sendRawEvent = (ws: WebSocket, type: string, sessionId: string, payload: Record<string, unknown> = {}) => {
  if (ws.readyState !== ws.OPEN) return
  const message: Record<string, unknown> = { type, session_id: sessionId, timestamp: Date.now(), payload }
  if (typeof payload.checkpoint_id === "string") message.checkpoint_id = payload.checkpoint_id
  if (typeof payload.sequence === "number") message.sequence = payload.sequence
  ws.send(JSON.stringify(message))
}
const emitStreamEvent = (run: ActiveRunState, type: string, payload: Record<string, unknown> = {}) => {
  run.sequence += 1
  const message = JSON.stringify({
    type,
    session_id: run.sessionId,
    timestamp: Date.now(),
    checkpoint_id: run.checkpointId,
    sequence: run.sequence,
    payload: { ...payload, run_id: run.runId },
  })
  run.events.push(message)
  if (run.events.length > 500) run.events.splice(0, run.events.length - 500)
  if (run.socket?.readyState === run.socket.OPEN) run.socket.send(message)
}
const emitStreamDone = (run: ActiveRunState, status: "completed" | "completed_with_warning" | "failed" | "cancelled", error?: string) => {
  if (run.done) return
  emitStreamEvent(run, "stream_done", { status, ...(error ? { error } : {}) })
  run.done = true
  run.expiresAt = Date.now() + 10_000
  setTimeout(() => {
    if (activeRuns.get(run.runId) === run && Date.now() >= run.expiresAt) activeRuns.delete(run.runId)
  }, 11_000).unref()
}
setInterval(() => {
  const cutoff = Date.now()
  for (const [runId, run] of activeRuns) if (run.expiresAt <= cutoff && !run.socket) activeRuns.delete(runId)
}, 5_000).unref()

const sendEvent = (ws: WebSocket, type: string, sessionId: string, payload: Record<string, unknown> = {}) => {
  sendRawEvent(ws, type, sessionId, payload)
}
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
function applyTurnProfile(history: Array<{ role: "system" | "user" | "assistant"; content: string }>): { history: Array<{ role: "system" | "user" | "assistant"; content: string }>; allowTools: boolean; toolAllowlist?: string[]; systemPromptEnabled?: boolean; skillsEnabled?: boolean } {
  const root = getAppConfig()
  const agents = isRecord(root.agents) ? root.agents : {}
  const defaults = isRecord(agents.defaults) ? agents.defaults : {}
  const profile = isRecord(defaults.turn_profile) ? defaults.turn_profile : {}
  if (profile.enabled !== true) return { history, allowTools: true, systemPromptEnabled: true, skillsEnabled: true }
  const profileHistory = isRecord(profile.history) ? profile.history : {}
  const systemProfile = isRecord(profile.system_prompt) ? profile.system_prompt : {}
  const skillsProfile = isRecord(profile.skills) ? profile.skills : {}
  const historyMode = String(profileHistory.mode || "default")
  const effectiveHistory = historyMode === "off"
    ? [...history.filter((message) => message.role === "system"), ...history.filter((message) => message.role !== "system").slice(-1)]
    : history
  const toolsProfile = isRecord(profile.tools) ? profile.tools : {}
  const toolsMode = String(toolsProfile.mode || "default")
  const systemPromptEnabled = String(systemProfile.mode || "default") !== "off"
  const skillsEnabled = String(skillsProfile.mode || "default") !== "off"
  if (toolsMode === "off") return { history: effectiveHistory, allowTools: false, systemPromptEnabled, skillsEnabled }
  if (toolsMode === "custom") {
    const allow = Array.isArray(toolsProfile.allow)
      ? toolsProfile.allow.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean)
      : []
    return { history: effectiveHistory, allowTools: allow.length > 0, toolAllowlist: allow, systemPromptEnabled, skillsEnabled }
  }
  return { history: effectiveHistory, allowTools: true, systemPromptEnabled, skillsEnabled }
}


wss.on("connection", (ws: WebSocket, _request: http.IncomingMessage, url: URL) => {
  const requestedSessionId = url.searchParams.get("session_id") || "miki-main-chat"
  const channelId = url.searchParams.get("channel_id") || "default-channel"
  const peerId = url.searchParams.get("peer_id") || requestedSessionId
  const sessionId = requestedSessionId
  ensureSession(sessionId)
  let authenticatedMessage = false
  const socketRuns = new Set<string>()
  if (!setting("dashboard_password")) proactiveSockets.add(ws)
  sendRawEvent(ws, "connection.ready", sessionId, { session_id: sessionId, backend: "persistent-node", protocol: "miki.ws.v1", authenticated: !Boolean(setting("dashboard_password")) })
  ws.on("close", () => {
    proactiveSockets.delete(ws)
    for (const runId of socketRuns) {
      const run = activeRuns.get(runId)
      if (run && !run.done && run.socket === ws) {
        run.socket = null
        run.expiresAt = Date.now() + STREAM_RESUME_GRACE_MS
      }
    }
  })
  ws.on("message", async (raw) => {
    let message: {
      type?: "authenticate" | "resume" | "message.send" | "message.retry" | "cancel_task" | string
      id?: string
      task_id?: string
      session_id?: string
      checkpoint_id?: string
      last_sequence?: number
      payload?: {
        content?: string
        requested_model?: string
        message_id?: string
        thinking_mode?: "auto" | "off" | "low" | "medium" | "high"
        [key: string]: unknown
      }
    }
    try { message = JSON.parse(raw.toString()) } catch { sendEvent(ws, "error", sessionId, { code: "invalid_json", message: "Invalid WebSocket JSON payload." }); return }
    if (message.type === "authenticate") {
      authenticatedMessage = !setting("dashboard_password") || authenticated({ headers: { cookie: _request.headers.cookie } } as express.Request)
      if (!authenticatedMessage) {
        sendEvent(ws, "error", sessionId, { code: "authentication_required", message: "WebSocket authentication has expired; please sign in again." })
        return
      }
      sendRawEvent(ws, "auth.ok", sessionId, { session_id: sessionId, authenticated: true })
      proactiveSockets.add(ws)
      return
    }
    if (!authenticatedMessage) {
      sendEvent(ws, "error", sessionId, { code: "authentication_required", message: "Authenticate before sending WebSocket commands." })
      return
    }
    if (message.type === "resume") {
      const checkpointId = typeof message.checkpoint_id === "string" ? message.checkpoint_id : ""
      const lastSequence = Number.isFinite(Number(message.last_sequence)) ? Number(message.last_sequence) : -1
      const run = Array.from(activeRuns.values()).find((candidate) => candidate.sessionId === sessionId && candidate.checkpointId === checkpointId)
      if (!run) {
        sendEvent(ws, "error", sessionId, { code: "resume_not_found", message: "The requested stream checkpoint is no longer available.", checkpoint_id: checkpointId })
        return
      }
      run.socket = ws
      socketRuns.add(run.runId)
      run.expiresAt = Date.now() + (run.done ? 10_000 : STREAM_RESUME_GRACE_MS)
      for (const serialized of run.events) {
        try {
          const candidate = JSON.parse(serialized) as { sequence?: number }
          if (Number(candidate.sequence) > lastSequence && ws.readyState === ws.OPEN) ws.send(serialized)
        } catch {}
      }
      return
    }
    if (message.type === "cancel_task") {
      if (message.task_id) {
        agent.cancelRun(message.task_id)
        const run = activeRuns.get(message.task_id)
        if (run) emitStreamDone(run, "cancelled")
      }
      return
    }
    const isRetry = message.type === "message.retry"
    if (message.type !== "message.send" && !isRetry) {
      sendEvent(ws, "error", sessionId, { code: "unsupported_message_type", message: `Unsupported WebSocket message type: ${String(message.type || "unknown")}` })
      return
    }
    // Resolve this at message time so changing Session Scope in Settings takes
    // effect on the next turn without requiring a gateway or websocket restart.
    const sessionScope = normalizeSessionScope((getAppConfig() as any)?.session?.dm_scope)
    const contextId = resolveSessionContextId(sessionScope, channelId, peerId)
    let content = String(message.payload?.content || "").trim()
    const rawAttachments = Array.isArray(message.payload?.attachments) ? message.payload.attachments : []
    const incomingAttachments = rawAttachments
      .filter((item: unknown): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
      .map((item) => {
        const type = item.type === "image" || item.type === "audio" || item.type === "video" || item.type === "file" ? item.type : "file"
        const url = typeof item.url === "string" ? item.url.trim() : ""
        return {
          type,
          url,
          ...(typeof item.filename === "string" && item.filename.trim() ? { filename: item.filename.trim().slice(0, 255) } : {}),
          ...(typeof item.content_type === "string" && item.content_type.trim() ? { content_type: item.content_type.trim().slice(0, 160) } : {}),
        }
      })
      .filter((item) => item.url.length > 0)
      .slice(0, 16)
    const imageUrls = incomingAttachments.filter((item) => item.type === "image").map((item) => item.url)
    if (isRetry) {
      const targetId = String(message.payload?.message_id || "")
      const target = targetId
        ? db.prepare("SELECT id,role,content,created_at FROM chat_messages WHERE session_id=? AND context_id=? AND id=?").get(sessionId, contextId, targetId) as { id: string; role: string; content: string; created_at: string } | undefined
        : undefined
      const latest = db.prepare("SELECT id FROM chat_messages WHERE session_id=? AND context_id=? ORDER BY created_at DESC LIMIT 1").get(sessionId, contextId) as { id: string } | undefined
      if (!target || latest?.id !== target.id) {
        sendEvent(ws, "error", sessionId, { message: "Only the last chat message can be retried." })
        return
      }
      if (target.role === "assistant") {
        const previousUser = db.prepare("SELECT content FROM chat_messages WHERE session_id=? AND context_id=? AND role='user' AND created_at<=? ORDER BY created_at DESC LIMIT 1").get(sessionId, contextId, target.created_at) as { content: string } | undefined
        content = String(previousUser?.content || "").trim()
        db.prepare("DELETE FROM chat_messages WHERE session_id=? AND context_id=? AND id=?").run(sessionId, contextId, target.id)
      } else {
        content = target.content.trim()
      }
    }
    if (!content && incomingAttachments.length === 0) return
    const runId = `run_${randomUUID()}`
    const requested = message.payload?.requested_model?.trim() || undefined
    const stream: ActiveRunState = {
      runId,
      sessionId,
      checkpointId: `checkpoint_${runId}`,
      sequence: 0,
      events: [],
      socket: ws,
      done: false,
      expiresAt: Date.now() + STREAM_RESUME_GRACE_MS,
    }
    activeRuns.set(runId, stream)
    socketRuns.add(runId)
    sendRawEvent(ws, "stream_checkpoint", sessionId, { checkpoint_id: stream.checkpointId, run_id: runId, sequence: 0 })
    const thinkingMode = message.payload?.thinking_mode || "auto"
    const thinkingLevel = thinkingMode !== "auto" ? thinkingMode : undefined
    if (!isRetry) {
      db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,context_id,image_urls,attachments_json) VALUES(?,?,?,?,?,?,?,?)").run(randomUUID(), sessionId, "user", content, now(), contextId, imageUrls.length > 0 ? JSON.stringify(imageUrls) : null, incomingAttachments.length > 0 ? JSON.stringify(incomingAttachments) : null)
      db.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").run(now(), sessionId)
    }
    // Conversation history for the model: persisted normal messages only (thoughts/tool traces stay out).
    const storedHistory = (db.prepare("SELECT role,content,image_urls,attachments_json FROM chat_messages WHERE context_id=? AND kind='normal' ORDER BY created_at DESC LIMIT 50").all(contextId) as Array<{ role: string; content: string; image_urls?: string | null; attachments_json?: string | null }>)
      .reverse().filter((row) => row.role === "user" || row.role === "assistant").map((row) => {
        let parsedImages: unknown
        try { parsedImages = row.image_urls ? JSON.parse(row.image_urls) : undefined } catch { parsedImages = undefined }
        return {
          role: row.role as "user" | "assistant",
          content: row.content,
          ...(Array.isArray(parsedImages) && parsedImages.length > 0 ? { image_urls: parsedImages.filter((url): url is string => typeof url === "string") } : {}),
        }
      })
    const defaults = ((getAppConfig() as any)?.agents?.defaults ?? {}) as Record<string, unknown>
    const memoryConfig = (getAppConfig() as any)?.agent?.memory
    fileMemory.updateConfig(memoryConfig, {
      summarizeTokenPercent: Number(defaults.summarize_token_percent ?? 75),
      summarizeMessageThreshold: Number(defaults.summarize_message_threshold ?? 8),
    })
    const contextBudgetTokens = resolveContextWindowTokens(defaults) ?? 131072
    const compacted = await fileMemory.compaction.compact(contextId, storedHistory as any, {
      budgetChars: contextBudgetTokens * 4,
      triggerPercent: Number(defaults.summarize_token_percent ?? 75),
      minMessages: Number(defaults.summarize_message_threshold ?? 8),
    })
    const compactedHistory = compacted.compacted
      ? compacted.messages.map((row: any) => ({ role: row.role as "system" | "user" | "assistant", content: String(row.content ?? "") }))
      : storedHistory
    const turnPolicy = applyTurnProfile(compactedHistory)
    const history = turnPolicy.history
    const model = agent.llmFor(requested)?.model || requested
    const mapper = createWsEventMapper((type, payload) => emitStreamEvent(stream, type, payload as Record<string, unknown>), model, () => {
      const feedback = (getAppConfig() as any)?.agents?.defaults?.tool_feedback
      return {
        enabled: feedback?.enabled !== false,
        separateMessages: feedback?.separate_messages === true,
        maxArgsLength: Math.max(0, Number(feedback?.max_args_length ?? 300) || 300),
      }
    }, () => {
      const messaging = (getAppConfig() as any)?.messaging || {}
      return {
        adaptive: messaging.adaptive !== false,
        maxMessagesPerResponse: Math.max(1, Number(messaging.maxMessagesPerResponse ?? 3) || 3),
        enableChunking: messaging.enableChunking !== false,
        enableStreaming: messaging.enableStreaming !== false,
        enableProgressMessages: messaging.enableProgressMessages !== false,
        maxChunkLength: Math.max(256, Number(messaging.maxChunkLength ?? 4000) || 4000),
        avoidUnnecessaryMessages: messaging.avoidUnnecessaryMessages !== false,
        streamingMinLength: Math.max(256, Number(messaging.streamingMinLength ?? 1200) || 1200),
        multiMessageMinLength: Math.max(256, Number(messaging.multiMessageMinLength ?? 800) || 800),
        progressIntervalMs: Math.max(500, Number(messaging.progressIntervalMs ?? 1800) || 1800),
      }
    })
    const persistAdaptiveReply = (text: string, modelName: string | undefined) => {
      if (!text) return
      const finalIds = mapper.finalIds.length > 0 ? mapper.finalIds : [mapper.finalId]
      const messaging = (getAppConfig() as any)?.messaging || {}
      const planned = planAdaptiveOutput(
        { id: `final-${runId}`, runId, channel: "web", kind: "response", content: text, final: true },
        undefined,
        {
          adaptive: messaging.adaptive !== false,
          maxMessagesPerResponse: Math.max(1, Number(messaging.maxMessagesPerResponse ?? 3) || 3),
          enableChunking: messaging.enableChunking !== false,
          enableStreaming: messaging.enableStreaming !== false,
          enableProgressMessages: messaging.enableProgressMessages !== false,
          maxChunkLength: Math.max(256, Number(messaging.maxChunkLength ?? 4000) || 4000),
          avoidUnnecessaryMessages: messaging.avoidUnnecessaryMessages !== false,
          streamingMinLength: Math.max(256, Number(messaging.streamingMinLength ?? 1200) || 1200),
          multiMessageMinLength: Math.max(256, Number(messaging.multiMessageMinLength ?? 800) || 800),
          progressIntervalMs: Math.max(500, Number(messaging.progressIntervalMs ?? 1800) || 1800),
        },
      )
      const chunks = planned.length === finalIds.length
        ? planned
        : planned.map((item, index) => ({ ...item, id: finalIds[index] || item.id }))
      for (let i = 0; i < chunks.length; i += 1) {
        const item = chunks[i]
        const id = finalIds[i] || item.id
        const createdAt = new Date(Date.now() + i).toISOString()
        db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,model_name,context_id) VALUES(?,?,?,?,?,?,?)").run(id, sessionId, "assistant", item.content, createdAt, modelName || null, contextId)
      }
      db.prepare("UPDATE chat_sessions SET updated_at=? WHERE id=?").run(now(), sessionId)
      getLifecycleBus().emit("message:sent", {
        eventId: runId,
        session_key: contextId,
        text,
        surface: "webchat",
        status: "completed",
      })
    }

    try {
      const result = await agent.startRun({
        runId,
        sessionId: contextId,
        executionLaneId: `chat:${runId}`,
        history,
        model: requested,
        allowTools: turnPolicy.allowTools,
        toolAllowlist: turnPolicy.toolAllowlist,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        source: "webchat",
        onEvent: mapper.handle,
      })
      const recoverableLimit = result.status === "failed" && /limit|budget|step|empty response|could not make progress/i.test(result.error || "")
      const resultText = result.finalText?.trim() || (recoverableLimit
        ? "I reached the current execution limit before finishing. The work completed so far is preserved; please continue and I will resume from the latest state."
        : result.error?.trim() || "I could not complete this run.")
      if (!result.finalText?.trim() && resultText) {
        mapper.handle({ type: "message.final", runId, content: resultText })
      }
      if (resultText) persistAdaptiveReply(resultText, result.model)
      const streamStatus = result.status === "cancelled"
        ? "cancelled"
        : recoverableLimit
          ? "completed_with_warning"
          : result.finalText
            ? "completed"
            : "failed"
      emitStreamDone(stream, streamStatus, result.error)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const category = error instanceof ProviderRequestError ? error.category : undefined
      emitStreamEvent(stream, "error", { message: detail, ...(category ? { error_category: category } : {}) })
      emitStreamEvent(stream, "typing.stop", { run_id: runId })
      emitStreamEvent(stream, "node.run_end", { run_id: runId, status: "failed", error: detail })
      emitStreamDone(stream, "failed", detail)
    } finally {
      socketRuns.delete(runId)
      if (stream.done && !stream.socket) stream.expiresAt = Date.now() + 10_000
    }
  })
})

app.use("/api", createDashboardExtendedRouter({
  db,
  app,
  projectRoot,
  dataRoot,
  workspaceRoot,
  configDir,
  getAppConfig,
  setAppConfig: (next) => putSetting("app_config", JSON.stringify(next)),
  rebindServer,
  requireAuth,
  now,
  agent: { registry: agent.registry, llmFor: (model) => agent.llmFor(model), activeRunCount: agent.activeRunCount },
  getGatewayLogs: (offset, runId) => { const filtered = gatewayLogs.filter((entry) => runId === undefined || entry.runId === runId); return { logs: filtered.slice(Math.max(0, offset)).map((entry) => `[${entry.at}] ${entry.message}`), log_total: filtered.length, log_run_id: gatewayRunId } },
  appendGatewayLog: (message) => appendGatewayLog(message),
  approvals: agent.approvals,
}))

app.use("/api", (_req, res) => res.status(404).json({ error: "API endpoint is not implemented in this backend yet." }))
app.use(express.static(dashboardRoot))
app.get("*", (_req, res) => res.sendFile(path.join(dashboardRoot, "index.html")))
async function configureRuntimeLoop() {
  await autonomy.stop()
  autonomy.start()
  appendGatewayLog("24/7 FULL_AGENT autonomy loop started.")
}

async function rebindServer(nextPort: number, nextPublic: boolean): Promise<void> {
  const nextHost = nextPublic ? "0.0.0.0" : "127.0.0.1"
  if (nextPort === currentPort && nextHost === currentHost) return
  await new Promise<void>((resolve, reject) => {
    server.close((closeError) => {
      if (closeError && (closeError as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") return reject(closeError)
      server.listen(nextPort, nextHost, () => resolve())
    })
  })
  currentPort = nextPort
  currentHost = nextHost
  appendGatewayLog(`Gateway listener rebound to http://${currentHost}:${currentPort}`)
}

void configureRuntimeLoop()
server.listen(currentPort, currentHost, () => { appendGatewayLog(`Persistent backend listening at http://${currentHost}:${currentPort}`); console.log(`[miki] persistent backend listening at http://${currentHost}:${currentPort}`) })
async function shutdown() { await autonomy.stop(); try { db.close() } finally { server.close(() => process.exit(0)) } }
process.once("SIGINT", shutdown)
process.once("SIGTERM", shutdown)
