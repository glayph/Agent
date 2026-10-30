import { promises as fsp } from "node:fs"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import * as fs from "node:fs"
import path from "node:path"
import { randomUUID, createHash } from "node:crypto"
import { Router, type Express, type Request, type Response } from "express"
import * as yaml from "js-yaml"
import Database from "better-sqlite3"
import { createGoalsRouter, GoalStore } from "@miki/core/api/goals"
import { createLinkPreviewRouter } from "@miki/core/api/link-preview"
import { WhisperCppService, SpeechToTextError, loadSpeechToTextSettings } from "@miki/core/speech-to-text"
import { listBuiltinPluginHealth } from "@miki/core/plugins"
import QRCode from "qrcode"
import { ExternalMcpConnectorManager } from "@miki/core/mcp/connectors"
import { SelfImprovementEngine, type SelfImprovementConfig } from "@miki/core/self-improvement"
import { LearningStore } from "@miki/memory"
import type { McpRuntimeConfig, McpServerConfig } from "@miki/core/mcp/types"
import type { SpeechToTextSettings } from "@miki/config"
import { createWorkspaceSecretVault } from "@miki/config"
import { CHANNEL_CONFIG_METADATA, CHANNEL_SECRET_FIELD_KEYS } from "@miki/config/channel-meta"
import { authCredentialKey, runChannelAuthCheck, supportsAuthCheck, type ChannelAuthCheckResult } from "./channel-auth-check.js"
import { publicChannelConfig, splitChannelConfig } from "./channel-config-helpers.js"
import { getLifecycleBus } from "@miki/core/hooks"
import { evolutionConfigFrom } from "./learned-behavior.js"
import { wrapAsyncRoutes } from "./async-route.js"
import { sessionCookie } from "./session-cookie.js"
import { IGNORED_DIRS as SECRET_IGNORED_DIRS, isFixturePath, isIgnoredPath, isScannableFile, parseIgnoreFile, scanLine } from "./secret-scan-rules.js"
import { createZipArchive } from "./zip-archive.js"

export interface DashboardExtendedDeps {
  db: Database.Database
  app: Express
  projectRoot: string
  dataRoot: string
  workspaceRoot: string
  configDir: string
  getAppConfig: () => Record<string, unknown>
  setAppConfig: (next: Record<string, unknown>) => void
  rebindServer?: (port: number, publicAccess: boolean) => Promise<void>
  requireAuth: import("express").RequestHandler
  now: () => string
  /** Injectable fetch for outbound provider checks (tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch
  registerShutdownHandler?: (handler: () => void | Promise<void>) => void
  agent: {
    registry: { size: number; names(): string[] }
    llmFor(model?: string): { model: string } | undefined
    /** Same resolution chat uses; health must agree with it. */
    resolveCurrentModel(model?: string): { configured: boolean; model: string; reason?: string; keyCheck: { status: string } }
    activeRunCount(): number
  }
  getGatewayLogs: (offset: number, runId?: number) => { logs: string[]; log_total: number; log_run_id: number }
  appendGatewayLog: (message: string) => void
  channelRuntimeStatus?: (name: string) => { runtime_live: boolean; connected: boolean; enabled: boolean; configured: boolean; lastError?: string; lastConnectedAt?: string; lastEventAt?: string }
  /** Single-recipient provider delivery with durable idempotency; only exposed behind explicit E2E gate. */
  channelTestDelivery?: (name: string, recipient: string, text: string, idempotencyKey: string) => Promise<{ status: "sent" | "duplicate"; channel: string; recipientHash: string; providerAckId: string; idempotencyKey: string }>
  approvals: {
    requestApproval: (request: { operationId: string; capability: string; action: string; risk: "install"; reason: string; sanitizedInput: Record<string, unknown>; context: { origin: "dashboard"; actor: string } }) => Promise<{ requestId: string }>
    isApproved: (request: { operationId: string; capability: string; action: string; risk: "install"; reason: string; sanitizedInput: Record<string, unknown>; context: { origin: "dashboard"; actor: string }; approvalRequestId?: string }) => boolean
    consumeApproval: (request: { operationId: string; capability: string; action: string; risk: "install"; reason: string; sanitizedInput: Record<string, unknown>; context: { origin: "dashboard"; actor: string }; approvalRequestId?: string }, requestId: string) => boolean
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {}
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function parseAllowedPeers(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;]+/) : []
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))]
}

function appMcpConfig(config: Record<string, unknown>): McpRuntimeConfig {
  const tools = asRecord(config.tools)
  const mcp = asRecord(tools.mcp)
  const discovery = asRecord(mcp.discovery)
  const serversRaw = asRecord(mcp.servers)
  const servers: Record<string, McpServerConfig> = {}
  for (const [name, raw] of Object.entries(serversRaw)) {
    const value = asRecord(raw)
    const type = value.type === "http" || value.type === "sse" ? value.type : "stdio"
    servers[name] = {
      name, enabled: value.enabled !== false, type,
      url: stringValue(value.url) || undefined,
      command: stringValue(value.command) || undefined,
      args: Array.isArray(value.args) ? value.args.filter((v): v is string => typeof v === "string") : undefined,
      headers: isRecord(value.headers) ? Object.fromEntries(Object.entries(value.headers).filter((entry) => typeof entry[1] === "string")) as Record<string, string> : undefined,
      env: isRecord(value.env) ? Object.fromEntries(Object.entries(value.env).filter((entry) => typeof entry[1] === "string")) as Record<string, string> : undefined,
      headerEnv: isRecord(value.header_env) ? Object.fromEntries(Object.entries(value.header_env).filter((entry) => typeof entry[1] === "string")) as Record<string, string> : undefined,
      envFile: stringValue(value.env_file) || undefined,
      deferred: typeof value.deferred === "boolean" ? value.deferred : null,
      allowSideEffects: value.allow_side_effects === true,
    }
  }
  return {
    enabled: mcp.enabled !== false,
    discovery: {
      enabled: discovery.enabled !== false,
      ttl: Math.max(1, Number(discovery.ttl) || 5),
      maxSearchResults: Math.max(1, Number(discovery.max_search_results) || 5),
      useBM25: discovery.use_bm25 !== false,
      useRegex: discovery.use_regex === true,
    },
    servers,
  }
}

function deepMergeLocal(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const output = { ...base }
  for (const [key, value] of Object.entries(incoming)) {
    output[key] = isRecord(output[key]) && isRecord(value) ? deepMergeLocal(output[key] as Record<string, unknown>, value) : value
  }
  return output
}

const execFileAsync = promisify(execFile)

const CHANNEL_FIELDS: Record<string, string[]> = Object.fromEntries(
  Object.entries(CHANNEL_CONFIG_METADATA).map(([name, meta]) => [name, [...meta.requiredFields]]),
)
const CHANNEL_META = Object.entries(CHANNEL_CONFIG_METADATA).map(([name, meta]) => ({
  name,
  display_name: meta.displayName,
  runtime_status: meta.runtimeStatus,
  sender_gated: meta.senderGated === true,
  note: meta.note,
}))
const CHANNEL_SECRET_KEYS = new Set<string>(CHANNEL_SECRET_FIELD_KEYS)

function channelRoot(config: Record<string, unknown>): Record<string, unknown> {
  const current = asRecord(config.channel_list)
  return current
}

function getChannelRecord(config: Record<string, unknown>, name: string): Record<string, unknown> {
  return asRecord(channelRoot(config)[name])
}

function getSpeechConfigPath(configDir: string): string {
  return path.join(configDir, "agent.yaml")
}

function readYamlConfig(configPath: string): Record<string, unknown> {
  try {
    const parsed = yaml.load(fs.readFileSync(configPath, "utf8"))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

async function writeYamlConfig(configPath: string, next: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(configPath, yaml.dump(next, { lineWidth: 120 }), { mode: 0o600 })
}

function publicSpeechSettings(settings: SpeechToTextSettings): Record<string, unknown> {
  return clone(settings)
}

function voiceCatalog(config: SpeechToTextSettings) {
  const root = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
  const sha: Record<string, string> = {
    base: "465707469ff3a37a2b9b8d8f89f2f99de7299dac",
    "base.en": "137c40403d78fd54d454da0f9bd998f78703390c",
    small: "55356645c2b361a969dfd0ef2c5a50d530afd8d5",
  }
  const sizes: Record<string, string> = { base: "142 MiB", "base.en": "142 MiB", small: "466 MiB" }
  return ["base", "base.en", "small"].map((id) => {
    const active = config.active_model_id === id
    const installed = Boolean(config.models.find((item) => item.id === id)?.model)
    return {
      id,
      name: `Whisper ${id}`,
      description: `Official whisper.cpp ${id} model`,
      languages: id.endsWith(".en") ? "English" : "Multilingual",
      size: sizes[id],
      sha1: sha[id],
      modelUrl: `${root}/ggml-${id}.bin`,
      licenseUrl: "https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md",
      transport: "cli" as const,
      installed,
      active,
    }
  })
}

async function downloadVoiceModel(modelId: string, target: string): Promise<void> {
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${modelId}.bin`
  const expected = ({ base: "465707469ff3a37a2b9b8d8f89f2f99de7299dac", "base.en": "137c40403d78fd54d454da0f9bd998f78703390c", small: "55356645c2b361a969dfd0ef2c5a50d530afd8d5" } as Record<string, string>)[modelId]
  const response = await fetch(url, { redirect: "follow" })
  if (!response.ok || !response.body) throw new Error(`Voice model download failed with HTTP ${response.status}.`)
  const tmp = `${target}.part`
  const file = fs.createWriteStream(tmp, { mode: 0o600 })
  const hasher = createHash("sha1")
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      hasher.update(chunk)
      file.write(chunk)
    }
    await new Promise<void>((resolve, reject) => file.end((error) => error ? reject(error) : resolve()))
    if (hasher.digest("hex") !== expected) throw new Error(`Voice model checksum mismatch for ${modelId}.`)
    await fsp.rename(tmp, target)
  } catch (error) {
    file.destroy()
    await fsp.rm(tmp, { force: true }).catch(() => undefined)
    throw error
  }
}

async function modelRuntimeStatus(configDir: string) {
  try {
    const settings = loadSpeechToTextSettings(configDir)
    const catalog = voiceCatalog(settings)
    const runtimeConfigured = Boolean(settings.endpoint || (settings.executable && settings.model))
    const executableExists = Boolean(settings.executable && fs.existsSync(settings.executable))
    const modelExists = Boolean(settings.model && fs.existsSync(settings.model))
    const healthy = settings.enabled && runtimeConfigured && (settings.endpoint ? true : executableExists && modelExists)
    return {
      installed: settings.models.some((m) => m.id === settings.active_model_id && Boolean(m.model)),
      enabled: settings.enabled,
      activeModelId: settings.active_model_id ?? null,
      activeModelName: settings.models.find((m) => m.id === settings.active_model_id)?.name ?? null,
      transport: settings.endpoint ? "endpoint" : settings.executable ? "cli" : null,
      runtimeConfigured,
      healthy,
      reason: healthy ? "Speech-to-text runtime is configured." : settings.enabled ? "Speech-to-text runtime is not ready." : "Speech-to-text is disabled.",
      modelDirectory: path.join(configDir, "voice-models"),
      executable: settings.executable,
      endpoint: settings.endpoint,
      catalog,
    }
  } catch (error) {
    return {
      installed: false, enabled: false, activeModelId: null, activeModelName: null, transport: null,
      runtimeConfigured: false, healthy: false, reason: error instanceof Error ? error.message : String(error),
      modelDirectory: path.join(configDir, "voice-models"), catalog: [],
    }
  }
}

function snapshotTable(db: Database.Database, table: string): unknown[] {
  try { return db.prepare(`SELECT * FROM ${table}`).all() } catch { return [] }
}

function snapshotModelConfigs(db: Database.Database): unknown[] {
  return snapshotTable(db, "model_configs").map((raw) => {
    if (!isRecord(raw) || typeof raw.payload !== "string") return raw
    try {
      const payload = JSON.parse(raw.payload) as Record<string, unknown>
      // Secret values belong in the encrypted vault, never in JSON backups.
      delete payload.api_key
      delete payload.api_key_ref
      return { ...raw, payload: JSON.stringify(payload) }
    } catch {
      return raw
    }
  })
}

async function loadBackups(dir: string): Promise<Array<{ id: string; createdAt: string; entries: Array<{ source: string; kind: "file" | "directory"; sizeBytes: number }>; file: string }>> {
  await fsp.mkdir(dir, { recursive: true })
  const names = await fsp.readdir(dir).catch(() => [])
  const out = []
  for (const name of names.filter((v) => v.endsWith(".json"))) {
    try { out.push(JSON.parse(await fsp.readFile(path.join(dir, name), "utf8"))) } catch { /* ignore corrupt backups */ }
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

async function scanSecrets(root: string) {
  type Finding = { file: string; line: number; pattern: string; redactedPreview: string }
  const findings: Finding[] = []
  const fixtureFindings: Finding[] = []
  let scannedFiles = 0
  // Project-level allowlists: Miki's own file and gitleaks' ignore file (path part only).
  const matchers: RegExp[] = []
  for (const name of [".miki-secretignore", ".gitleaksignore"]) {
    try { matchers.push(...parseIgnoreFile(await fsp.readFile(path.join(root, name), "utf8"))) } catch { /* optional file */ }
  }
  async function walk(dir: string): Promise<void> {
    const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) { if (!SECRET_IGNORED_DIRS.has(entry.name)) await walk(full); continue }
      if (!entry.isFile() || !isScannableFile(entry.name)) continue
      const relative = path.relative(root, full)
      if (isIgnoredPath(relative, matchers)) continue
      try {
        const stat = await fsp.stat(full)
        if (stat.size > 1024 * 1024) continue
        const content = await fsp.readFile(full, "utf8")
        if (content.includes("\u0000")) continue
        scannedFiles += 1
        const target = isFixturePath(relative) ? fixtureFindings : findings
        const lines = content.split(/\r?\n/)
        for (let index = 0; index < lines.length; index += 1) {
          const hit = scanLine(lines[index], relative)
          if (hit) target.push({ file: relative, line: index + 1, pattern: hit.pattern, redactedPreview: hit.preview })
        }
      } catch { /* unreadable/binary files are ignored */ }
    }
  }
  await walk(root)
  // Fixture matches (tests, .env.example, docs) are reported for transparency but never degrade health.
  return { scannedFiles, fixedFiles: [], findings: findings.slice(0, 200), fixtureFindings: fixtureFindings.slice(0, 200) }
}

export function createDashboardExtendedRouter(deps: DashboardExtendedDeps): Router {
  const router = wrapAsyncRoutes(Router())
  const backupsDir = path.join(deps.dataRoot, "backups")
  router.get("/runtime/export", deps.requireAuth, async (_req, res) => {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const tempDir = path.join(backupsDir, `.runtime-export-${randomUUID()}`)
    const snapshotPath = path.join(tempDir, "miki-runtime.sqlite")
    try {
      await fsp.mkdir(tempDir, { recursive: true, mode: 0o700 })
      await deps.db.backup(snapshotPath)
      await fsp.chmod(snapshotPath, 0o600).catch(() => undefined)
      const entries: Array<{ name: string; data: Buffer }> = [
        { name: "data/miki-runtime.sqlite", data: await fsp.readFile(snapshotPath) },
      ]
      const vaultDir = path.join(deps.configDir, "data")
      const vaultPath = path.join(vaultDir, "secret-vault.json")
      const vaultKeyPath = path.join(vaultDir, "secret-vault.key")
      let hasVault = await fsp.access(vaultPath).then(() => true, () => false)
      let hasVaultKey = await fsp.access(vaultKeyPath).then(() => true, () => false)
      if (hasVault && !hasVaultKey) {
        let envelope: Record<string, unknown> = {}
        try { envelope = JSON.parse(await fsp.readFile(vaultPath, "utf8")) as Record<string, unknown> } catch { /* validation below fails closed */ }
        const passphraseVault = envelope.kdf === "passphrase" || Boolean(process.env.MIKI_VAULT_KEY || process.env.MIKI_SECRET_VAULT_KEY)
        if (!passphraseVault && envelope.version === 1) {
          // Version 1 derives its key from the original machine/path. Reading and
          // writing every secret upgrades it to the portable v2 key-file format.
          const vault = createWorkspaceSecretVault(deps.configDir)
          const keys = vault.list()
          try {
            for (const key of keys) {
              const value = vault.get(key)
              if (typeof value !== "string") throw new Error("legacy vault contains an unreadable secret")
              vault.set(key, value)
            }
            // A legacy vault with zero entries still needs a portable key file
            // so the exported vault/key pair remains restorable on another host.
            if (keys.length === 0) {
              const marker = `__miki_internal_export_migration_${randomUUID()}`
              vault.set(marker, randomUUID())
              vault.delete(marker)
            }
          } catch (error) {
            return res.status(409).json({ error: `Legacy secret vault could not be upgraded for a portable backup: ${error instanceof Error ? error.message : "vault upgrade failed"}` })
          }
          hasVaultKey = await fsp.access(vaultKeyPath).then(() => true, () => false)
          hasVault = await fsp.access(vaultPath).then(() => true, () => false)
        }
        if (hasVault && !hasVaultKey && !passphraseVault) return res.status(409).json({ error: "The encrypted secret vault exists but its key file is missing. Export stopped to avoid creating an incomplete backup." })
      }
      if (hasVault) entries.push({ name: "config/data/secret-vault.json", data: await fsp.readFile(vaultPath) })
      if (hasVaultKey) entries.push({ name: "config/data/secret-vault.key", data: await fsp.readFile(vaultKeyPath) })
      const agentConfig = path.join(deps.configDir, "agent.yaml")
      if (await fsp.access(agentConfig).then(() => true, () => false)) {
        entries.push({ name: "config/agent.yaml", data: await fsp.readFile(agentConfig) })
      }
      const instructions = [
        "Miki runtime backup",
        `Created: ${new Date().toISOString()}`,
        "Contains a consistent SQLite backup and, when present, the encrypted secret vault and its decryption key.",
        "SECURITY: this archive may contain credentials and the key that decrypts them. Store it privately; never send it to another person or upload it to public storage.",
        "Restore data/miki-runtime.sqlite to the configured runtime data directory. Restore config/data/secret-vault.json and secret-vault.key together to the configured config/data directory. If the vault uses MIKI_VAULT_KEY, preserve that environment variable separately; it is not included in this archive.",
        "The ZIP does not contain program source or installed dependencies.",
      ].join("\n") + "\n"
      entries.push({ name: "BACKUP-README.txt", data: Buffer.from(instructions, "utf8") })
      const zip = createZipArchive(entries)
      res.setHeader("Content-Type", "application/zip")
      res.setHeader("Content-Disposition", `attachment; filename="miki-runtime-backup-${stamp}.zip"`)
      res.setHeader("Cache-Control", "no-store")
      return res.status(200).send(zip)
    } catch (error) {
      return res.status(500).json({ error: `Runtime export failed: ${error instanceof Error ? error.message : "backup could not be created"}` })
    } finally {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
  const jobsDbInit = () => deps.db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 2, progress REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, run_after INTEGER NOT NULL DEFAULT 0, error_json TEXT);
    CREATE TABLE IF NOT EXISTS delivery_receipts (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS dashboard_qr_flows (id TEXT PRIMARY KEY, channel TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, account_id TEXT, bot_id TEXT, error TEXT, external_key TEXT, qr_data_uri TEXT, expires_at TEXT);
  `)
  jobsDbInit()

  const learningStore = new LearningStore(deps.db)
  learningStore.initializeSync()
  let evolutionSignature = ""
  let evolutionEngine: SelfImprovementEngine | null = null
  let evolutionTimer: ReturnType<typeof setInterval> | null = null
  let evolutionRunning = false
  let dashboardShuttingDown = false
  let evolutionTask: Promise<Record<string, unknown>> | null = null

  function evolutionConfig(): SelfImprovementConfig {
    return evolutionConfigFrom(deps.getAppConfig())
  }

  function getEvolutionEngine(): SelfImprovementEngine {
    const config = evolutionConfig()
    const stateDir = String((asRecord(deps.getAppConfig().evolution).state_dir || deps.dataRoot))
    const signature = JSON.stringify({ config, stateDir })
    if (!evolutionEngine || signature !== evolutionSignature) {
      const llm = deps.agent.llmFor()
      evolutionEngine = new SelfImprovementEngine(
        { tkg: { learningStore } },
        { dataDir: String((asRecord(deps.getAppConfig().evolution).state_dir || deps.dataRoot)) },
        async (messages) => {
          const client = (llm ?? deps.agent.llmFor()) as unknown as { complete(messages: Array<{ role: string; content: string }>, options: Record<string, unknown>): Promise<never> } | undefined
          if (!client) throw new Error("No configured LLM is available for self-improvement analysis.")
          return client.complete(messages.map((message) => ({ role: message.role, content: message.content })), { json: true, maxCompletionTokens: 600 })
        },
        config,
      )
      evolutionSignature = signature
    }
    return evolutionEngine
  }

  async function runDueEvolutionCycles(force = false): Promise<Record<string, unknown>> {
    if (dashboardShuttingDown) return { status: "shutting_down" }
    const config = {
      ...asRecord(deps.getAppConfig().self_improvement),
      ...asRecord(deps.getAppConfig().evolution),
    }
    const trigger = stringValue(config.cold_path_trigger) || "after_turn"
    const scheduledTimes = Array.isArray(config.cold_path_times) ? config.cold_path_times.filter((v): v is string => typeof v === "string") : []
    if (!force && trigger === "manual") return { status: "manual_only" }
    if (!force && trigger === "scheduled") {
      const hhmm = new Date().toTimeString().slice(0, 5)
      if (!scheduledTimes.some((time) => time.trim() === hhmm)) return { status: "not_scheduled", next_check: hhmm, configured_times: scheduledTimes }
    }
    const engine = getEvolutionEngine()
    if (evolutionRunning) return { status: "skipped", reason: "cycle_already_running" }
    evolutionRunning = true
    try {
      const status = engine.getStatus()
      const raw = {
        ...asRecord(deps.getAppConfig().self_improvement),
        ...asRecord(deps.getAppConfig().evolution),
      }
      const minTasks = Math.max(1, Number(raw.min_task_count ?? 2) || 2)
      const minSuccessRatio = Math.max(0, Math.min(1, Number(raw.min_success_ratio ?? 0.7) || 0.7))
      const stats = status.learning as Record<string, unknown>
      const outcomes = Array.isArray(stats.outcomes) ? stats.outcomes as Array<Record<string, unknown>> : []
      const totalOutcomes = outcomes.reduce((sum, item) => sum + (Number(item.count) || 0), 0)
      const successful = outcomes.filter((item) => String(item.outcome || "").toLowerCase() === "success").reduce((sum, item) => sum + (Number(item.count) || 0), 0)
      const successRatio = totalOutcomes > 0 ? successful / totalOutcomes : 0
      if (!force && totalOutcomes < minTasks) return { status: "gated", reason: "min_task_count", current: totalOutcomes, required: minTasks, success_ratio: successRatio, required_success_ratio: minSuccessRatio, engine: status }
      if (!force && trigger !== "after_turn" && totalOutcomes > 0 && successRatio < minSuccessRatio) return { status: "gated", reason: "min_success_ratio", current: successRatio, required: minSuccessRatio, engine: status }
      const results: Record<string, unknown> = {}
      if (force || status.reflectionDue) results.reflection = await engine.runReflectionCycle({ force })
      if (force || status.tuningDue) results.promptTuning = await engine.runPromptTuningCycle({ force })
      if (force || status.optimizationDue) results.optimization = await engine.runOptimizationCycle({ force })
      return { status: Object.keys(results).length ? "completed" : "not_due", results, engine: engine.getStatus() }
    } finally {
      evolutionRunning = false
    }
  }

  function runTrackedEvolutionCycle(force = false): Promise<Record<string, unknown>> {
    if (dashboardShuttingDown) return Promise.resolve({ status: "shutting_down" })
    if (evolutionTask) return evolutionTask
    const task = runDueEvolutionCycles(force)
    evolutionTask = task
    void task.then(
      () => { if (evolutionTask === task) evolutionTask = null },
      () => { if (evolutionTask === task) evolutionTask = null },
    )
    return task
  }

  const onMessageSent = () => {
    if (dashboardShuttingDown) return
    const cfg = evolutionConfig();
    if (cfg.enabled && String((asRecord(deps.getAppConfig().evolution).cold_path_trigger || "after_turn")) === "after_turn") {
      void runTrackedEvolutionCycle(false).catch((error) => deps.appendGatewayLog(`Evolution after-turn cycle failed: ${error instanceof Error ? error.message : String(error)}`));
    }
  }
  const unsubscribeMessageSent = getLifecycleBus().on?.("message:sent", onMessageSent)

  evolutionTimer = setInterval(() => {
    if (dashboardShuttingDown) return
    const config = evolutionConfig()
    const raw = asRecord(deps.getAppConfig().evolution)
    const trigger = stringValue(raw.cold_path_trigger) || "after_turn"
    // after_turn is driven by message:sent; manual is owner-triggered only.
    // The timer exists solely to check scheduled HH:MM windows.
    if (!config.enabled || trigger !== "scheduled") return
    void runTrackedEvolutionCycle(false).catch((error) => deps.appendGatewayLog(`Evolution cycle failed: ${error instanceof Error ? error.message : String(error)}`))
  }, 30_000)
  evolutionTimer.unref?.()

  let mcpManager = new ExternalMcpConnectorManager(deps.workspaceRoot, appMcpConfig(deps.getAppConfig()))

  router.use("/link-preview", deps.requireAuth, createLinkPreviewRouter())

  router.use("/goals", deps.requireAuth, createGoalsRouter(new GoalStore(deps.db)))

  router.post("/evolution/run", deps.requireAuth, async (_req, res) => {
    if (!evolutionConfig().enabled) {
      return res.status(409).json({ error: "Enable and save Evolution before running it." })
    }
    try {
      return res.json(await runTrackedEvolutionCycle(true))
    } catch (error) {
      return res.status(500).json({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  router.post("/mcp/test", deps.requireAuth, async (req, res) => {
    const name = stringValue(req.body?.name)
    if (!name) return res.status(400).json({ ok: false, error: "MCP server name is required." })
    const draftServer = req.body?.config
    if (draftServer !== undefined && !isRecord(draftServer)) {
      return res.status(400).json({ ok: false, error: "MCP server draft must be an object." })
    }
    const sourceConfig = draftServer === undefined
      ? deps.getAppConfig()
      : deepMergeLocal(deps.getAppConfig(), { tools: { mcp: { servers: { [name]: draftServer } } } })
    const config = appMcpConfig(sourceConfig)
    const server = config.servers[name]
    if (!server) return res.status(404).json({ ok: false, error: `MCP server '${name}' was not found.` })
    if (!server.enabled) return res.json({ ok: true, status: "disabled", name, tools: 0 })
    const manager = new ExternalMcpConnectorManager(deps.workspaceRoot, config)
    const started = Date.now()
    try {
      const entries = await manager.listCatalogEntries(true)
      const tools = entries.filter((entry) => entry.serverName === name)
      if (tools.length === 0) return res.status(502).json({ ok: false, status: "connected_no_tools", name, tools: 0, latency_ms: Date.now() - started, error: "Connection succeeded but the server exposed no tools." })
      return res.json({ ok: true, status: "connected", name, tools: tools.length, latency_ms: Date.now() - started })
    } catch (error) {
      return res.status(502).json({ ok: false, status: "failed", name, latency_ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) })
    } finally {
      await manager.close()
    }
  })





  router.post("/channels/:name/test-delivery", deps.requireAuth, async (req, res) => {
    if (process.env.MIKI_E2E_CHANNEL_SEND_ENABLED !== "true") return res.status(403).json({ error: "live_test_delivery_disabled" })
    const configuredRecipient = (process.env.MIKI_E2E_TEST_RECIPIENT || "").trim()
    if (!configuredRecipient || configuredRecipient === "*") return res.status(503).json({ error: "test_recipient_not_configured" })
    const name = typeof req.params.name === "string" ? req.params.name : ""
    if (!(name === "telegram" || name === "discord" || name === "slack")) return res.status(404).json({ error: "channel_test_not_supported" })
    const body = asRecord(req.body)
    const recipient = typeof body.recipient === "string" ? body.recipient.trim() : ""
    const idempotencyKey = String(req.header("idempotency-key") || "")
    const text = typeof body.text === "string" ? body.text : ""
    if (recipient !== configuredRecipient) return res.status(403).json({ error: "test_recipient_mismatch" })
    if (!/^[A-Za-z0-9._:-]{8,120}$/.test(idempotencyKey) || text !== `MIKI-E2E:${idempotencyKey}`) return res.status(400).json({ error: "test_message_marker_invalid" })
    if (!deps.channelTestDelivery) return res.status(503).json({ error: "channel_test_delivery_unavailable" })
    try {
      const result = await deps.channelTestDelivery(name, recipient, text, idempotencyKey)
      return res.json({ ok: true, status: result.status, channel: result.channel, recipient_hash: result.recipientHash, provider_ack_id: result.providerAckId, idempotency_key: result.idempotencyKey })
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_:-]{1,100}$/i.test(error.message) ? error.message : "channel_test_delivery_failed"
      const status = code.endsWith("in_progress") || code.endsWith("idempotency_key_conflict") ? 409 : code.endsWith("not_configured") ? 409 : code.endsWith("disabled") || code.endsWith("recipient_mismatch") ? 403 : code.endsWith("auth_rejected") || code.endsWith("provider_rejected") || code.endsWith("provider_unavailable") ? 502 : 400
      return res.status(status).json({ ok: false, error: code })
    }
  })

  router.get("/channels/catalog", (_req, res) => {
    const config = deps.getAppConfig()
    res.json({ channels: CHANNEL_META.map((meta) => {
      const raw = getChannelRecord(config, meta.name)
      const { settings } = splitChannelConfig(raw)
      const required = CHANNEL_FIELDS[meta.name] ?? []
      const allowFrom = parseAllowedPeers(raw.allow_from ?? settings.allow_from)
      const hasRuntimeSecrets = meta.name === "slack"
        ? Boolean(stringValue(settings.bot_token) && stringValue(settings.app_token))
        : meta.name === "telegram" || meta.name === "discord"
          ? Boolean(stringValue(settings.token))
          : true
      const configured = raw.enabled !== false && required.every((key) => stringValue(settings[key]) || stringValue(raw[key])) && hasRuntimeSecrets
      const senderGated = meta.sender_gated
      const allowFromNote = configured && senderGated && allowFrom.length === 0 ? "Connected, but allow_from is empty so every sender is ignored. Add trusted sender IDs (or * to allow everyone)." : undefined
      const runtime = deps.channelRuntimeStatus?.(meta.name)
      return { ...meta, runtime_note: allowFromNote ?? meta.note, runtime_live: meta.name === "miki" ? true : Boolean(runtime?.runtime_live), runtime_connected: meta.name === "miki" ? true : Boolean(runtime?.connected), runtime_error: runtime?.lastError, config_key: meta.name, variant: meta.name === "whatsapp_native" ? "native" : undefined, configured }
    }) })
  })

  router.get("/channels/:name/config", deps.requireAuth, (req, res) => {
    const name = req.params.name
    const meta = CHANNEL_META.find((item) => item.name === name)
    if (!meta) return res.status(404).json({ error: `Unknown channel \"${name}\".` })
    const raw = getChannelRecord(deps.getAppConfig(), name)
    const safe = publicChannelConfig(raw, meta.name)
    res.json({ ...safe, config_key: meta.name, variant: meta.name === "whatsapp_native" ? "native" : undefined })
  })



  function buildChannelProbeResponse(
    name: string,
    raw: Record<string, unknown>,
    runtime: ReturnType<NonNullable<DashboardExtendedDeps["channelRuntimeStatus"]>> | undefined,
    checkedAt: string,
    mode?: unknown,
    auth?: ChannelAuthCheckResult,
  ) {
    const meta = CHANNEL_META.find((item) => item.name === name)
    if (!meta) return null
    const { settings } = splitChannelConfig(raw)
    const required = CHANNEL_FIELDS[name] ?? []
    const configuredSecrets = new Set(
      Object.keys(settings).filter((key) => CHANNEL_SECRET_KEYS.has(key) && stringValue(settings[key])),
    )
    const missing = required.filter(
      (key) => !stringValue(settings[key]) && !configuredSecrets.has(key) && !stringValue(raw[key]),
    )
    const enabled = raw.enabled !== false
    const implementedAdapter = meta.runtime_status === "functional"
    const allowFrom = parseAllowedPeers(raw.allow_from ?? settings.allow_from)
    const configured = missing.length === 0
    const liveAdapterAvailable = meta.runtime_status === "functional"
    const connected = name === "miki" ? true : Boolean(runtime?.connected)
    const checks: Array<{ id: string; status: "pass" | "warn" | "fail"; message: string }> = [
      {
        id: "config",
        status: !enabled ? "warn" : configured ? "pass" : "warn",
        message: !enabled ? "Channel is disabled." : configured ? "Required configuration is present." : `Missing: ${missing.join(", ")}`,
      },
      {
        id: "runtime",
        status: !liveAdapterAvailable
          ? meta.runtime_status === "config_only" ? "fail" : "warn"
          : connected ? "pass" : "warn",
        message: !liveAdapterAvailable
          ? meta.note
          : connected
            ? "Live adapter is connected."
            : runtime?.lastError
              ? `Adapter is reconnecting: ${runtime.lastError}`
              : name === "miki"
                ? "Built-in Miki WebSocket channel is available."
                : "Adapter is implemented but not yet connected.",
      },
    ]
    if (enabled && configured && meta.sender_gated && allowFrom.length === 0) {
      checks.push({
        id: "allow_from",
        status: "warn",
        message: "allow_from is empty, so every sender is ignored. Add trusted sender IDs (or * to allow everyone).",
      })
    }
    let probeStatus: "ready" | "disabled" | "needs_config" | "auth_failed" | "runtime_error" | "partial" | "not_implemented" =
      !enabled
        ? "disabled"
        : missing.length
          ? "needs_config"
          : connected
            ? "ready"
            : !liveAdapterAvailable
              ? meta.runtime_status === "config_only" ? "not_implemented" : "partial"
              : "partial"
    if (name === "dingtalk" && configured) {
      try {
        const u = new URL(stringValue(settings.webhook_url))
        checks.push({
          id: "url",
          status: u.protocol === "https:" ? "pass" : "warn",
          message: "DingTalk webhook URL parsed successfully.",
        })
      } catch {
        checks.push({ id: "url", status: "fail", message: "Invalid webhook URL." })
        probeStatus = "needs_config"
      }
    }
    if (auth) {
      checks.push({ id: "auth", status: auth.ok ? "pass" : "fail", message: auth.message })
      // A rejected credential is an auth failure; a timeout/unreachable provider is a runtime error, not a bad credential.
      if (!auth.ok) probeStatus = auth.failureCode === "auth_rejected" ? "auth_failed" : "runtime_error"
    }
    const modeValue = String(mode || "sandbox")
    // "live" is only reported when a real provider call was made; otherwise the check stays a sandbox check.
    const checkMode = (modeValue === "live" ? (auth ? "live" : "sandbox") : modeValue) as "mock" | "sandbox" | "live"
    return {
      channel: name,
      display_name: meta.display_name,
      runtime_status: meta.runtime_status,
      probe_status: probeStatus,
      agent_connected: connected,
      enabled,
      configured,
      missing_fields: missing,
      checks,
      check_mode: checkMode,
      latency_ms: auth ? auth.latencyMs : connected ? 1 : 0,
      ...(auth && !auth.ok && auth.failureCode ? { failure_code: auth.failureCode } : {}),
      send_check: {
        status: "skipped" as const,
        mode: "sandbox" as const,
        message: auth
          ? "Credentials were verified with a read-only provider call; no message was sent."
          : connected
            ? "Adapter connection was checked; no external message was sent."
            : "No external message was sent by the dashboard probe.",
        latency_ms: 0,
      },
      next_steps: missing.length
        ? missing.map((key) => key === "allow_from"
          ? "Add trusted sender IDs to allow_from; use * only if you intentionally want to allow every sender."
          : `Configure ${key}.`)
        : !liveAdapterAvailable
          ? ["This channel does not currently provide full live message transport."]
          : !connected
            ? ["The adapter is starting or reconnecting. Check the runtime error and network access."]
            : ["The live adapter is connected and only accepts sender IDs listed in allow_from."],
      setup_checklist: [
        ...required,
        ...(implementedAdapter && meta.sender_gated ? ["allow_from (trusted sender IDs)"] : []),
      ].map((key) => `Configure ${key}.`),
      checked_at: checkedAt,
    }
  }

  router.get("/channels/:name/probe", deps.requireAuth, async (req, res) => {
    const name = req.params.name
    const meta = CHANNEL_META.find((item) => item.name === name)
    if (!meta) return res.status(404).json({ error: `Unknown channel \"${name}\".` })
    const raw = getChannelRecord(deps.getAppConfig(), name)
    const result = buildChannelProbeResponse(
      name,
      raw,
      deps.channelRuntimeStatus?.(name),
      deps.now(),
      req.query.mode,
    )
    if (!result) return res.status(404).json({ error: `Unknown channel \"${name}\".` })
    return res.json(result)
  })

  // Tests draft settings only in memory. The body is never persisted or logged;
  // the response deliberately contains status/checks only, never credential values.
  router.post("/channels/:name/probe", deps.requireAuth, async (req, res) => {
    const name = req.params.name
    const meta = CHANNEL_META.find((item) => item.name === name)
    if (!meta) return res.status(404).json({ error: `Unknown channel \"${name}\".` })
    const requestBody = asRecord(req.body)
    const draftInput = asRecord(requestBody.config ?? requestBody)
    const saved = getChannelRecord(deps.getAppConfig(), name)
    const savedParts = splitChannelConfig(saved)
    const draftParts = splitChannelConfig(draftInput)
    const draft: Record<string, unknown> = {
      ...saved,
      ...draftInput,
      settings: { ...savedParts.settings, ...draftParts.settings },
      enabled: typeof draftInput.enabled === "boolean" ? draftInput.enabled : saved.enabled,
    }
    // The provider authentication check runs only for an explicit live probe, and only from POST:
    // GET never reaches out to a provider. The credential stays in this scope (never logged, stored or returned).
    let auth: ChannelAuthCheckResult | undefined
    if (req.query.mode === "live" && supportsAuthCheck(name) && draft.enabled !== false) {
      const credential = stringValue(splitChannelConfig(draft).settings[authCredentialKey(name)])
      if (credential) auth = await runChannelAuthCheck(name, credential, { fetchImpl: deps.fetchImpl })
    }
    const result = buildChannelProbeResponse(
      name,
      draft,
      deps.channelRuntimeStatus?.(name),
      deps.now(),
      req.query.mode,
      auth,
    )
    if (!result) return res.status(404).json({ error: `Unknown channel \"${name}\".` })
    res.setHeader("Cache-Control", "no-store")
    return res.json(result)
  })

  async function qrDataUri(content: string) {
    return QRCode.toDataURL(content, { errorCorrectionLevel: "M", margin: 2, width: 320 })
  }

  async function saveChannelBinding(channel: "weixin" | "wecom", binding: Record<string, unknown>) {
    const config = deps.getAppConfig()
    const channels = isRecord(config.channel_list) ? config.channel_list : {}
    const existing = isRecord(channels[channel]) ? channels[channel] : {}
    const settings = isRecord(existing.settings) ? existing.settings : {}
    const next = deepMergeLocal(config, {
      channel_list: {
        [channel]: {
          ...existing,
          type: channel,
          enabled: true,
          settings: deepMergeLocal(settings, binding),
        },
      },
    })
    await deps.setAppConfig(next)
  }

  async function weixinStart(req: Request, res: Response) {
    try {
      const response = await fetch("https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3", {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15000),
      })
      if (!response.ok) return res.status(502).json({ error: `WeChat QR service returned ${response.status}.` })
      const body = await response.json() as Record<string, unknown>
      const token = stringValue(body.qrcode)
      const content = stringValue(body.qrcode_img_content)
      if (!token || !content) return res.status(502).json({ error: "WeChat QR service returned an incomplete QR payload." })
      const stamp = deps.now()
      const id = randomUUID()
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString()
      const dataUri = await qrDataUri(content)
      deps.db.prepare("INSERT INTO dashboard_qr_flows(id,channel,status,created_at,updated_at,external_key,qr_data_uri,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "weixin", "wait", stamp, stamp, token, dataUri, expiresAt)
      deps.appendGatewayLog(`WeChat QR flow started: ${id}`)
      return res.json({ flow_id: id, status: "wait", qr_data_uri: dataUri })
    } catch (error) {
      return res.status(502).json({ error: `Failed to start WeChat QR flow: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  async function weixinPoll(req: Request, res: Response) {
    const row = deps.db.prepare("SELECT * FROM dashboard_qr_flows WHERE id=? AND channel=?").get(req.params.id, "weixin") as Record<string, unknown> | undefined
    if (!row) return res.status(404).json({ error: "QR flow not found" })
    const terminal = new Set(["confirmed", "expired", "error"])
    if (terminal.has(String(row.status))) return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined, account_id: row.account_id || undefined, error: row.error || undefined })
    if (row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) {
      deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("expired", deps.now(), row.id)
      return res.json({ flow_id: row.id, status: "expired" })
    }
    try {
      const response = await fetch(`https://ilinkai.weixin.qq.com/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(String(row.external_key || ""))}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      })
      if (!response.ok) return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined })
      const body = await response.json() as Record<string, unknown>
      const status = String(body.status || row.status)
      if (status === "scaned" || status === "scanned") {
        deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("scaned", deps.now(), row.id)
      } else if (status === "expired") {
        deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("expired", deps.now(), row.id)
      } else if (status === "confirmed") {
        const botToken = stringValue(body.bot_token)
        const accountId = stringValue(body.ilink_bot_id) || stringValue(body.bot_id)
        if (!botToken) {
          deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,error=?,updated_at=? WHERE id=?").run("error", "WeChat confirmed the QR login but did not return bot_token.", deps.now(), row.id)
        } else {
          const binding: Record<string, unknown> = { token: botToken }
          if (accountId) binding.account_id = accountId
          if (stringValue(body.baseurl)) binding.base_url = stringValue(body.baseurl)
          await saveChannelBinding("weixin", binding)
          deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,account_id=?,updated_at=? WHERE id=?").run("confirmed", accountId || null, deps.now(), row.id)
          deps.appendGatewayLog(`WeChat QR flow confirmed: ${row.id}`)
        }
      }
      const updated = deps.db.prepare("SELECT * FROM dashboard_qr_flows WHERE id=?").get(row.id) as Record<string, unknown>
      return res.json({ flow_id: updated.id, status: updated.status, qr_data_uri: ["wait", "scaned", "scanned"].includes(String(updated.status)) ? updated.qr_data_uri || undefined : undefined, account_id: updated.account_id || undefined, error: updated.error || undefined })
    } catch {
      return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined })
    }
  }

  async function wecomStart(req: Request, res: Response) {
    try {
      const platform = process.platform === "darwin" ? 1 : process.platform === "win32" ? 2 : process.platform === "linux" ? 3 : 0
      const url = new URL("https://work.weixin.qq.com/ai/qc/generate")
      url.searchParams.set("source", "miki")
      url.searchParams.set("sourceID", "miki")
      url.searchParams.set("plat", String(platform))
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) })
      if (!response.ok) return res.status(502).json({ error: `WeCom QR service returned ${response.status}.` })
      const body = await response.json() as Record<string, unknown>
      const data = isRecord(body.data) ? body.data : {}
      const scode = stringValue(data.scode)
      const authUrl = stringValue(data.auth_url)
      if (!scode || !authUrl) return res.status(502).json({ error: "WeCom QR service returned an incomplete QR payload." })
      const stamp = deps.now(); const id = randomUUID(); const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString(); const dataUri = await qrDataUri(authUrl)
      deps.db.prepare("INSERT INTO dashboard_qr_flows(id,channel,status,created_at,updated_at,external_key,qr_data_uri,expires_at) VALUES(?,?,?,?,?,?,?,?)").run(id, "wecom", "wait", stamp, stamp, scode, dataUri, expiresAt)
      deps.appendGatewayLog(`WeCom QR flow started: ${id}`)
      return res.json({ flow_id: id, status: "wait", qr_data_uri: dataUri })
    } catch (error) {
      return res.status(502).json({ error: `Failed to start WeCom QR flow: ${error instanceof Error ? error.message : String(error)}` })
    }
  }

  async function wecomPoll(req: Request, res: Response) {
    const row = deps.db.prepare("SELECT * FROM dashboard_qr_flows WHERE id=? AND channel=?").get(req.params.id, "wecom") as Record<string, unknown> | undefined
    if (!row) return res.status(404).json({ error: "QR flow not found" })
    if (["confirmed", "expired", "error"].includes(String(row.status))) return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined, bot_id: row.bot_id || undefined, error: row.error || undefined })
    if (row.expires_at && Date.parse(String(row.expires_at)) <= Date.now()) { deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("expired", deps.now(), row.id); return res.json({ flow_id: row.id, status: "expired" }) }
    try {
      const url = new URL("https://work.weixin.qq.com/ai/qc/query_result")
      url.searchParams.set("scode", String(row.external_key || ""))
      const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) })
      if (!response.ok) return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined })
      const body = await response.json() as Record<string, unknown>
      const data = isRecord(body.data) ? body.data : {}
      const status = String(data.status || row.status).toLowerCase()
      if (status === "scaned" || status === "scanned") deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("scaned", deps.now(), row.id)
      else if (status === "expired") deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,updated_at=? WHERE id=?").run("expired", deps.now(), row.id)
      else if (["success", "confirmed"].includes(status)) {
        const info = isRecord(data.bot_info) ? data.bot_info : {}
        const botId = stringValue(info.botid) || stringValue(data.botid)
        const secret = stringValue(info.secret) || stringValue(data.secret)
        if (!botId || !secret) deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,error=?,updated_at=? WHERE id=?").run("error", "WeCom confirmed the QR login but did not return bot credentials.", deps.now(), row.id)
        else {
          await saveChannelBinding("wecom", { bot_id: botId, secret, websocket_url: "wss://openws.work.weixin.qq.com" })
          deps.db.prepare("UPDATE dashboard_qr_flows SET status=?,bot_id=?,updated_at=? WHERE id=?").run("confirmed", botId, deps.now(), row.id)
          deps.appendGatewayLog(`WeCom QR flow confirmed: ${row.id}`)
        }
      }
      const updated = deps.db.prepare("SELECT * FROM dashboard_qr_flows WHERE id=?").get(row.id) as Record<string, unknown>
      return res.json({ flow_id: updated.id, status: updated.status, qr_data_uri: ["wait", "scaned", "scanned"].includes(String(updated.status)) ? updated.qr_data_uri || undefined : undefined, bot_id: updated.bot_id || undefined, error: updated.error || undefined })
    } catch {
      return res.json({ flow_id: row.id, status: row.status, qr_data_uri: row.qr_data_uri || undefined })
    }
  }

  router.post("/weixin/flows", deps.requireAuth, weixinStart)
  router.get("/weixin/flows/:id", deps.requireAuth, weixinPoll)
  router.post("/wecom/flows", deps.requireAuth, wecomStart)
  router.get("/wecom/flows/:id", deps.requireAuth, wecomPoll)

  router.get("/speech-to-text/models", deps.requireAuth, async (_req, res) => {
    try {
      const settings = loadSpeechToTextSettings(deps.configDir)
      res.json({ provider: "whisper.cpp", enabled: settings.enabled, active_model_id: settings.active_model_id ?? null, models: settings.models, settings: publicSpeechSettings(settings), local_runtime: await modelRuntimeStatus(deps.configDir) })
    } catch (error) { res.status(error instanceof SpeechToTextError ? error.status : 503).json({ error: error instanceof Error ? error.message : String(error) }) }
  })

  async function mutateSpeechConfig(mutator: (current: SpeechToTextSettings) => SpeechToTextSettings) {
    const configPath = getSpeechConfigPath(deps.configDir)
    const root = readYamlConfig(configPath)
    const current = loadSpeechToTextSettings(deps.configDir)
    root.speech_to_text = mutator(current)
    await writeYamlConfig(configPath, root)
    return loadSpeechToTextSettings(deps.configDir)
  }


  router.post("/speech-to-text/models", deps.requireAuth, async (req, res) => {
    try {
      const body = asRecord(req.body)
      const id = stringValue(body.id); const name = stringValue(body.name)
      const transport = body.transport === "endpoint" ? "endpoint" : "cli"
      if (!id || !name) return res.status(400).json({ error: "id and name are required" })
      const model = transport === "endpoint"
        ? { id, name, transport, enabled: body.enabled !== false, endpoint: stringValue(body.endpoint) }
        : { id, name, transport, enabled: body.enabled !== false, executable: stringValue(body.executable), model: stringValue(body.model) }
      const next = await mutateSpeechConfig((current) => ({ ...current, models: [...current.models.filter((item) => item.id !== id), model as SpeechToTextSettings["models"][number]], active_model_id: body.set_active === true || current.models.length === 0 ? id : current.active_model_id }))
      res.status(201).json({ status: "created", ...next, local_runtime: await modelRuntimeStatus(deps.configDir) })
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  router.put("/speech-to-text/models/:id", deps.requireAuth, async (req, res) => {
    try {
      const body = asRecord(req.body); const id = req.params.id
      const next = await mutateSpeechConfig((current) => ({ ...current, models: current.models.map((item) => item.id === id ? { ...item, ...body, id } : item) }))
      res.json({ status: "updated", ...next, local_runtime: await modelRuntimeStatus(deps.configDir) })
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  router.delete("/speech-to-text/models/:id", deps.requireAuth, async (req, res) => {
    try {
      const id = req.params.id
      const next = await mutateSpeechConfig((current) => { const models = current.models.filter((item) => item.id !== id); return { ...current, models, active_model_id: current.active_model_id === id ? (models[0]?.id ?? undefined) : current.active_model_id } })
      res.json({ status: "deleted", ...next, local_runtime: await modelRuntimeStatus(deps.configDir) })
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  router.post("/speech-to-text/models/active", deps.requireAuth, async (req, res) => {
    try {
      const id = stringValue(req.body?.model_id); if (!id) return res.status(400).json({ error: "model_id is required" })
      const next = await mutateSpeechConfig((current) => current.models.some((m) => m.id === id) ? { ...current, active_model_id: id } : (() => { throw new Error("Speech model not found") })())
      res.json({ status: "active", ...next, local_runtime: await modelRuntimeStatus(deps.configDir) })
    } catch (error) { res.status(400).json({ error: error instanceof Error ? error.message : String(error) }) }
  })

  router.post("/speech-to-text/install", deps.requireAuth, async (req, res) => {
    const id = stringValue(req.body?.model_id)
    if (!["base", "base.en", "small"].includes(id)) return res.status(400).json({ error: "Only base, base.en, and small are installable." })
    const plan = { model_id: id, risk: "install" as const, action: "download" }
    const approvalRequestId = stringValue(req.body?.approval_request_id)
    const operationId = `speech-install:${id}`
    const approvalRequest = { operationId, capability: "speech_to_text", action: "install_model", risk: "install" as const, reason: `Download and install Whisper ${id} locally.`, sanitizedInput: plan as Record<string, unknown>, context: { origin: "dashboard" as const, actor: "dashboard-operator" } }
    if (!approvalRequestId) {
      const pending = await deps.approvals.requestApproval(approvalRequest)
      deps.appendGatewayLog(`Speech model install approval requested: ${id} (${pending.requestId})`)
      return res.json({ status: "approval_required", approval_request_id: pending.requestId, plan })
    }
    if (!deps.approvals.isApproved({ ...approvalRequest, approvalRequestId })) {
      return res.status(403).json({ error: "Approval is still pending or does not match this installation request.", code: "approval_required", approval_request_id: approvalRequestId, plan })
    }
    if (!deps.approvals.consumeApproval({ ...approvalRequest, approvalRequestId }, approvalRequestId)) {
      return res.status(409).json({ error: "Approval could not be consumed.", code: "approval_invalid", approval_request_id: approvalRequestId })
    }
    try {
      const dir = path.join(deps.configDir, "voice-models")
      await fsp.mkdir(dir, { recursive: true })
      const target = path.join(dir, `ggml-${id}.bin`)
      if (!fs.existsSync(target)) await downloadVoiceModel(id, target)
      const executable = process.env.MIKI_WHISPER_CPP_EXECUTABLE || "whisper-cli"
      const next = await mutateSpeechConfig((current) => {
        const models = [...current.models.filter((m) => m.id !== id), { id, name: `Whisper ${id}`, transport: "cli", enabled: true, executable, model: target }]
        return { ...current, enabled: true, active_model_id: id, models } as SpeechToTextSettings
      })
      deps.appendGatewayLog(`Speech model installed: ${id}`)
      res.json({ status: "installed", ...next, local_runtime: await modelRuntimeStatus(deps.configDir) })
    } catch (error) { res.status(502).json({ error: error instanceof Error ? error.message : String(error) }) }
  })
  router.post("/speech-to-text/health", deps.requireAuth, async (_req, res) => {
    res.json({ status: "checked", provider: "whisper.cpp", local_runtime: await modelRuntimeStatus(deps.configDir) })
  })

  router.post("/voice/transcribe", deps.requireAuth, (req, res) => {
    const chunks: Buffer[] = []
    const contentType = String(req.headers["content-type"] || "")
    if (!contentType.toLowerCase().startsWith("multipart/form-data")) return res.status(415).json({ error: "audio multipart upload is required", code: "invalid_request" })
    const boundaryMatch = contentType.match(/boundary=(?:\"([^\"]+)\"|([^;]+))/i)
    const boundary = boundaryMatch?.[1] || boundaryMatch?.[2]?.trim()
    if (!boundary) return res.status(400).json({ error: "Multipart boundary is missing.", code: "invalid_multipart" })
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
    req.on("end", async () => {
      try {
        const body = Buffer.concat(chunks)
        if (body.length > 26 * 1024 * 1024) throw new SpeechToTextError(413, "file_too_large", "Audio upload exceeds the maximum request size.")
        const marker = Buffer.from(`--${boundary}`)
        let cursor = 0
        let selected: { data: Buffer; filename: string; mimeType: string } | undefined
        while (true) {
          const start = body.indexOf(marker, cursor)
          if (start < 0) break
          const after = start + marker.length
          if (body.subarray(after, after + 2).toString() === "--") break
          const headersStart = after + 2
          const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), headersStart)
          if (headerEnd < 0) break
          const headers = body.subarray(headersStart, headerEnd).toString("utf8")
          const dataStart = headerEnd + 4
          const nextBoundary = body.indexOf(Buffer.from(`\r\n--${boundary}`), dataStart)
          if (nextBoundary < 0) break
          const part = body.subarray(dataStart, nextBoundary)
          const filenameMatch = headers.match(/filename=\"([^\"]*)\"/i)
          const mimeMatch = headers.match(/(?:^|\r\n)content-type:\s*([^\r\n]+)/i)
          const nameMatch = headers.match(/name=\"([^\"]+)\"/i)
          const filename = filenameMatch?.[1] || "voice.webm"
          const mimeType = mimeMatch?.[1]?.trim() || "application/octet-stream"
          if ((nameMatch?.[1] === "audio" || filenameMatch) && part.length > 0) selected = { data: part, filename, mimeType }
          cursor = nextBoundary + 2
        }
        if (!selected) throw new SpeechToTextError(400, "invalid_multipart", "No audio part was found in the upload.")
        const service = new WhisperCppService(deps.configDir)
        const result = await service.transcribe({ data: selected.data, filename: selected.filename, mimeType: selected.mimeType, clientDurationMs: Number(req.body?.duration_ms) || undefined })
        res.json({ ok: true, mode: "local", ...result })
      } catch (error) {
        const status = error instanceof SpeechToTextError ? error.status : 500
        res.status(status).json({ ok: false, code: error instanceof SpeechToTextError ? error.code : "voice_transcription_failed", error: error instanceof Error ? error.message : String(error) })
      }
    })
  })



  router.get("/models/catalog", deps.requireAuth, (_req, res) => {
    const rows = deps.db.prepare("SELECT id,provider,api_base,api_key_mask,models_json,fetched_at FROM model_catalogs ORDER BY fetched_at DESC").all() as Array<Record<string, unknown>>
    res.json({ entries: rows.map((r) => ({ id: r.id, provider: r.provider, api_base: r.api_base, api_key_mask: r.api_key_mask, models: JSON.parse(String(r.models_json)), fetched_at: r.fetched_at })), total: rows.length })
  })
  router.delete("/models/catalog/:id", deps.requireAuth, (req, res) => {
    deps.db.prepare("DELETE FROM model_catalogs WHERE id=?").run(req.params.id)
    res.json({ status: "deleted", id: req.params.id })
  })

  router.get("/system/launcher-config", (_req, res) => {
    const saved = asRecord((() => { try { return JSON.parse((deps.db.prepare("SELECT value FROM settings WHERE key='launcher_config'").get() as { value?: string } | undefined)?.value || "{}") } catch { return {} } })())
    res.json({ port: Number(saved.port || process.env.GATEWAY_PORT || 18800), public: saved.public === true, allowed_cidrs: Array.isArray(saved.allowed_cidrs) ? saved.allowed_cidrs : [], session_timeout_minutes: Number(saved.session_timeout_minutes || 0) })
  })
  router.put("/system/launcher-config", deps.requireAuth, async (req, res) => {
    const port = Number(req.body?.port)
    const publicAccess = req.body?.public === true
    const timeout = Number(req.body?.session_timeout_minutes || 0)
    const allowedCidrs = Array.isArray(req.body?.allowed_cidrs) ? req.body.allowed_cidrs.filter((v: unknown) => typeof v === "string" && v.trim()) : []
    if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).json({ error: "port must be an integer between 1 and 65535" })
    if (!Number.isInteger(timeout) || timeout < 0 || timeout > 31 * 24 * 60) return res.status(400).json({ error: "session_timeout_minutes must be an integer between 0 and 44640" })
    const value = { port, public: publicAccess, allowed_cidrs: allowedCidrs, session_timeout_minutes: timeout }
    const previous = (() => { try { return JSON.parse(String((deps.db.prepare("SELECT value FROM settings WHERE key='launcher_config'").get() as { value?: string } | undefined)?.value || "{}")) as Record<string, unknown> } catch { return {} } })()
    deps.db.prepare("INSERT INTO settings(key,value) VALUES('launcher_config',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value))
    const changedRuntime = Number(previous.port || process.env.GATEWAY_PORT || 18800) !== port || Boolean(previous.public) !== publicAccess
    const noExpiry = "9999-12-31T23:59:59.999Z"
    const expiresAt = timeout > 0
      ? new Date(Date.now() + timeout * 60_000).toISOString()
      : noExpiry
    deps.db.prepare("UPDATE auth_sessions SET expires_at=? WHERE expires_at>? OR expires_at=?").run(expiresAt, deps.now(), noExpiry)
    const currentToken = req.headers.cookie?.match(/(?:^|;\s*)miki_session=([^;]+)/)?.[1]
    if (currentToken) {
      res.setHeader("Set-Cookie", sessionCookie(currentToken, timeout > 0 ? timeout * 60 : undefined, req.secure))
    }
    let runtimeApplyStatus: "applied" | "pending_restart" | "failed" = changedRuntime ? "pending_restart" : "applied"
    let runtimeApplyError: string | undefined
    if (changedRuntime && deps.rebindServer) {
      try { await deps.rebindServer(port, publicAccess); runtimeApplyStatus = "applied" }
      catch (error) { runtimeApplyStatus = "failed"; runtimeApplyError = error instanceof Error ? error.message : String(error) }
    }
    return res.status(runtimeApplyStatus === "failed" ? 500 : 200).json({ ...value, runtime_apply_status: runtimeApplyStatus, runtime_apply_error: runtimeApplyError, gateway_restart_required: runtimeApplyStatus !== "applied", pending_restart_fields: runtimeApplyStatus === "applied" ? [] : ["launcher_config"] })
  })
  async function hasUserSystemd(): Promise<boolean> {
    if (process.platform !== "linux") return false
    try {
      await execFileAsync("systemctl", ["--user", "show-environment"])
      return true
    } catch {
      return false
    }
  }

  async function applyAutostart(enabled: boolean): Promise<{ supported: boolean; active: boolean; message: string }> {
    if (process.platform === "linux") {
      const serviceDir = path.join(process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || deps.dataRoot, ".config"), "systemd", "user")
      const servicePath = path.join(serviceDir, "miki-gateway.service")
      if (!enabled) {
        await execFileAsync("systemctl", ["--user", "disable", "--now", "miki-gateway.service"]).catch(() => undefined)
        await fsp.rm(servicePath, { force: true })
        return { supported: true, active: false, message: "User systemd autostart disabled." }
      }
      if (!(await hasUserSystemd())) {
        return { supported: false, active: false, message: "Launch at login is unavailable because this session has no user systemd service manager." }
      }
      await fsp.mkdir(serviceDir, { recursive: true })
      const node = process.execPath.replace(/\\/g, "/")
      const script = path.resolve(process.argv[1] || "").replace(/\\/g, "/")
      const unit = `[Unit]\nDescription=Miki Gateway\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=${node} ${script}\nRestart=always\nRestartSec=3\n\n[Install]\nWantedBy=default.target\n`
      await fsp.writeFile(servicePath, unit, { mode: 0o600 })
      await execFileAsync("systemctl", ["--user", "daemon-reload"])
      await execFileAsync("systemctl", ["--user", "enable", "--now", "miki-gateway.service"])
      return { supported: true, active: true, message: "User systemd autostart enabled." }
    }
    if (process.platform === "win32") {
      const taskName = "Miki Gateway"
      if (!enabled) {
        await execFileAsync("schtasks", ["/Delete", "/TN", taskName, "/F"]).catch(() => undefined)
        return { supported: true, active: false, message: "Windows logon task removed." }
      }
      const script = process.argv[1] || ""
      const taskCommand = `\"${process.execPath}\" \"${script}\"`
      await execFileAsync("schtasks", ["/Create", "/TN", taskName, "/TR", taskCommand, "/SC", "ONLOGON", "/RL", "LIMITED", "/F"])
      return { supported: true, active: true, message: "Windows logon autostart task created." }
    }
    return { supported: false, active: enabled, message: `Automatic startup is not implemented for ${process.platform}.` }
  }

  router.put("/system/autostart", deps.requireAuth, async (req, res) => {
    const enabled = req.body?.enabled === true
    try {
      const result = await applyAutostart(enabled)
      const persistedEnabled = result.supported ? enabled : false
      deps.db.prepare("INSERT INTO settings(key,value) VALUES('autostart_enabled',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(persistedEnabled ? "true" : "false")
      res.json({ enabled: persistedEnabled, platform: process.platform, ...result })
    } catch (error) {
      res.status(500).json({ enabled, supported: process.platform === "linux" || process.platform === "win32", active: false, error: error instanceof Error ? error.message : String(error) })
    }
  })
  router.get("/system/autostart", async (_req, res) => {
    const row = deps.db.prepare("SELECT value FROM settings WHERE key='autostart_enabled'").get() as { value?: string } | undefined
    const enabled = row?.value === "true"
    const supported = process.platform === "win32" || (process.platform === "linux" && await hasUserSystemd())
    res.json({ enabled: supported && enabled, supported, active: supported && enabled, platform: process.platform, message: supported ? undefined : "Launch at login requires a user systemd session on Linux." })
  })

  router.get("/system/flow", deps.requireAuth, (_req, res) => {
    const models = deps.agent.llmFor()
    const components = [
      { id: "dashboard", label: "Dashboard", status: "ready" as const, summary: "Frontend is served by the persistent gateway.", evidence: ["HTTP", "static assets"] },
      { id: "gateway", label: "Gateway", status: "ready" as const, summary: "Persistent Node gateway is running.", evidence: ["Express", `PID ${process.pid}`] },
      { id: "agent", label: "Agent runtime", status: models ? "ready" as const : "partial" as const, summary: models ? `Model ${models.model} is resolvable.` : "No configured model is currently resolvable.", evidence: [`${deps.agent.registry.size} tools`, `${deps.agent.activeRunCount()} active run(s)`] },
      { id: "memory", label: "Memory", status: "ready" as const, summary: "SQLite memory store is available.", evidence: ["SQLite", `${(deps.db.prepare("SELECT COUNT(*) c FROM memory_chunks").get() as { c?: number } | undefined)?.c ?? 0} chunks`] },
      { id: "skills", label: "Skills", status: "ready" as const, summary: "Skill routes and runtime are mounted.", evidence: ["/api/skills"] },
    ]
    const ready = components.filter((c) => c.status === "ready").length
    res.json({ status: ready === components.length ? "ready" : "partial", generated_at: deps.now(), flow_version: 1, components, edges: components.slice(1).map((c, i) => ({ from: components[i].id, to: c.id, contract: "HTTP/API or runtime contract" })), gaps: models ? [] : [{ id: "model", severity: "warning", title: "No model configured", detail: "Configure at least one model to run agent turns.", owner: "Models" }] })
  })

  router.get("/enhancements/health/full", deps.requireAuth, async (_req, res) => {
    const defaultModel = deps.agent.resolveCurrentModel()
    const doctorChecks = [
      { id: "database", label: "SQLite database", status: "pass" as const, message: "SQLite is reachable.", details: {} },
      { id: "workspace", label: "Workspace", status: fs.existsSync(deps.workspaceRoot) ? "pass" as const : "fail" as const, message: deps.workspaceRoot, details: {} },
      { id: "tools", label: "Agent tools", status: deps.agent.registry.size > 0 ? "pass" as const : "warn" as const, message: `${deps.agent.registry.size} registered tool(s).`, details: {} },
      { id: "model", label: "Default model", status: defaultModel.configured ? "pass" as const : "warn" as const, message: defaultModel.configured ? defaultModel.model : (defaultModel.reason || "No model configured."), details: { key_status: defaultModel.keyCheck.status } },
    ]
    const backups = await loadBackups(backupsDir)
    const jobs = deps.db.prepare("SELECT * FROM runtime_jobs ORDER BY updated_at DESC LIMIT 100").all() as Array<Record<string, unknown>>
    const items = jobs.map((job) => ({ id: job.id, type: job.type, status: String(job.status ?? "unknown"), priority: Number(job.priority), attempts: Number(job.attempts), maxAttempts: Number(job.max_attempts), progress: Number(job.progress), updatedAt: job.updated_at, runAfter: Number(job.run_after), ...(job.error_json ? { error: JSON.parse(String(job.error_json)) } : {}) }))
    const stats: Record<string, number> = {}
    for (const item of items) stats[item.status] = (stats[item.status] || 0) + 1
    const safeModeRow = deps.db.prepare("SELECT value FROM settings WHERE key='safe_mode'").get() as { value?: string } | undefined
    const safeMode = safeModeRow?.value ? JSON.parse(safeModeRow.value) : { enabled: false, reasons: [] }
    const secretScan = await scanSecrets(deps.workspaceRoot)
    const memoryCount = Number((deps.db.prepare("SELECT COUNT(*) c FROM memory_chunks").get() as { c?: number } | undefined)?.c || 0)
    const pluginHealth = listBuiltinPluginHealth({ "tools.core-registry": { ok: deps.agent.registry.size > 0, status: deps.agent.registry.size > 0 ? "functional" : "partial" }, "workflow.agent-loop": { ok: defaultModel.configured, status: defaultModel.configured ? "functional" : "partial" } })
    const components = [
      { name: "gateway", status: "healthy" as const, message: `PID ${process.pid}` },
      { name: "agent-runtime", status: defaultModel.configured ? "healthy" as const : "degraded" as const, message: defaultModel.configured ? defaultModel.model : (defaultModel.reason || "No configured model") },
      { name: "memory", status: memoryCount >= 0 ? "healthy" as const : "failed" as const, message: `${memoryCount} memory chunk(s)` },
      { name: "plugins", status: Object.values(pluginHealth).every((v) => v.ok) ? "healthy" as const : "degraded" as const, message: `${Object.keys(pluginHealth).length} built-in capability checks` },
    ]
    const hasFailure = doctorChecks.some((c) => c.status === "fail")
    const hasWarn = doctorChecks.some((c) => c.status === "warn") || secretScan.findings.length > 0
    res.json({ status: hasFailure ? "failed" : hasWarn ? "degraded" : "healthy", checkedAt: deps.now(), doctor: { status: hasFailure ? "fail" : hasWarn ? "warn" : "pass", checkedAt: deps.now(), workspaceDir: deps.workspaceRoot, checks: doctorChecks }, memory: { available: true, dataDir: deps.dataRoot }, safeMode, backups: backups.map((b) => ({ id: b.id, createdAt: b.createdAt, entries: b.entries })), migrations: [], watchdog: { enabled: true, services: [{ name: "gateway", healthy: true, failures: 0, lastMessage: "Persistent gateway is running.", lastCheckedAt: deps.now() }, { name: "database", healthy: true, failures: 0, lastMessage: "SQLite reachable.", lastCheckedAt: deps.now() }] }, jobs: { items, stats }, performance: [{ name: "health-check", durationMs: 0 }], audit: [], secretScan, components })
  })
  router.post("/enhancements/doctor/run", deps.requireAuth, async (_req, res) => {
    const secretScan = await scanSecrets(deps.workspaceRoot)
    const report = { status: secretScan.findings.length ? "warn" : "pass", checkedAt: deps.now(), workspaceDir: deps.workspaceRoot, checks: [{ id: "database", label: "SQLite", status: "pass", message: "SQLite reachable." }, { id: "workspace", label: "Workspace", status: fs.existsSync(deps.workspaceRoot) ? "pass" : "fail", message: deps.workspaceRoot }, { id: "secrets", label: "Secret scan", status: secretScan.findings.length ? "warn" : "pass", message: `${secretScan.findings.length} finding(s).` }] }
    res.json({ report })
  })
  router.post("/enhancements/safety/backups", deps.requireAuth, async (_req, res) => {
    await fsp.mkdir(backupsDir, { recursive: true })
    const id = `backup-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
    const file = path.join(backupsDir, `${id}.json`)
    const state = {
      id, createdAt: deps.now(), entries: [
        { source: "settings", kind: "file", sizeBytes: 0 }, { source: "model_configs", kind: "file", sizeBytes: 0 },
        { source: "memory_chunks", kind: "file", sizeBytes: 0 }, { source: "memory_vectors", kind: "file", sizeBytes: 0 },
        { source: "chat_sessions", kind: "file", sizeBytes: 0 }, { source: "chat_messages", kind: "file", sizeBytes: 0 },
      ], snapshot: { settings: snapshotTable(deps.db, "settings"), model_configs: snapshotModelConfigs(deps.db), memory_chunks: snapshotTable(deps.db, "memory_chunks"), memory_vectors: snapshotTable(deps.db, "memory_vectors"), chat_sessions: snapshotTable(deps.db, "chat_sessions"), chat_messages: snapshotTable(deps.db, "chat_messages"), runtime_jobs: snapshotTable(deps.db, "runtime_jobs") },
    }
    await fsp.writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 })
    res.json({ backup: { id, createdAt: state.createdAt, entries: state.entries } })
  })
  router.post("/enhancements/safety/rollback", deps.requireAuth, async (req, res) => {
    const id = stringValue(req.body?.backupId)
    if (!id || !/^[A-Za-z0-9_-]{1,160}$/.test(id)) return res.status(400).json({ error: "A valid backupId is required" })
    const file = path.join(backupsDir, `${id}.json`)
    let backup: { snapshot?: Record<string, unknown> }
    try { backup = JSON.parse(await fsp.readFile(file, "utf8")) } catch { return res.status(404).json({ error: "Backup not found" }) }
    const tables = ["settings", "model_configs", "memory_chunks", "memory_vectors", "chat_sessions", "chat_messages", "runtime_jobs"]
    await fsp.mkdir(backupsDir, { recursive: true, mode: 0o700 })
    // Always capture the current state before restoring anything. If this write
    // fails, stop; rollback must never run without a recovery point.
    const beforeId = `pre-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
    const beforeFile = path.join(backupsDir, `${beforeId}.json`)
    const beforeSnapshot: Record<string, unknown[]> = {}
    for (const table of tables) beforeSnapshot[table] = table === "model_configs" ? snapshotModelConfigs(deps.db) : snapshotTable(deps.db, table)
    try { await fsp.writeFile(beforeFile, JSON.stringify({ id: beforeId, createdAt: deps.now(), type: "pre-rollback-recovery", entries: [], snapshot: beforeSnapshot }, null, 2), { mode: 0o600 }) }
    catch (error) { return res.status(500).json({ error: `Rollback stopped because a recovery backup could not be created: ${error instanceof Error ? error.message : "backup write failed"}` }) }

    let restoredEntries = 0
    try {
      const tx = deps.db.transaction(() => {
        for (const table of tables) {
          const rows = Array.isArray(backup.snapshot?.[table]) ? backup.snapshot[table] : []
          const cols = deps.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; pk: number }>
          const valid = new Set(cols.map((c) => c.name))
          const primaryKeys = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
          for (const rawRow of rows) {
            if (!isRecord(rawRow)) continue
            const safeRow = { ...rawRow }
            if (table === "model_configs" && typeof safeRow.payload === "string") {
              // Older backup JSON can contain plaintext keys. Do not reintroduce them.
              try {
                const payload = JSON.parse(safeRow.payload) as Record<string, unknown>
                delete payload.api_key
                delete payload.api_key_ref
                safeRow.payload = JSON.stringify(payload)
              } catch { /* skip only if fields can't be interpreted below */ }
            }
            const entries = Object.entries(safeRow).filter(([key]) => valid.has(key))
            if (!entries.length) continue
            const q = (name: string) => `"${name.replace(/"/g, '""')}"`
            const names = entries.map(([key]) => q(key))
            const placeholders = entries.map(() => "?").join(",")
            const updates = entries.map(([key]) => key).filter((key) => !primaryKeys.includes(key))
            let sql = `INSERT INTO ${q(table)} (${names.join(",")}) VALUES (${placeholders})`
            if (primaryKeys.length) {
              const conflict = primaryKeys.map(q).join(",")
              sql += updates.length
                ? ` ON CONFLICT(${conflict}) DO UPDATE SET ${updates.map((key) => `${q(key)}=excluded.${q(key)}`).join(",")}`
                : ` ON CONFLICT(${conflict}) DO NOTHING`
            } else {
              sql = sql.replace("INSERT INTO", "INSERT OR IGNORE INTO")
            }
            deps.db.prepare(sql).run(...entries.map(([, value]) => value))
            restoredEntries += 1
          }
        }
      })
      tx()
    } catch (error) {
      return res.status(500).json({ error: `Rollback merge failed; current state is available in recovery backup ${beforeId}: ${error instanceof Error ? error.message : "database merge failed"}`, recoveryBackupId: beforeId })
    }
    res.json({ rollback: { restoredBackupId: id, recoveryBackupId: beforeId, restoredEntries, mode: "merge", deletedRows: 0 } })
  })
  router.post("/enhancements/safety/secret-scan", deps.requireAuth, async (_req, res) => res.json({ report: await scanSecrets(deps.workspaceRoot) }))
  router.post("/enhancements/safety/watchdog/restart", deps.requireAuth, (_req, res) => res.json({ watchdog: { enabled: true, services: [{ name: "gateway", healthy: true, failures: 0, lastMessage: "Watchdog probe refreshed.", lastCheckedAt: deps.now() }] } }))
  router.post("/enhancements/safety/safe-mode/clear", deps.requireAuth, (_req, res) => { const value = { enabled: false, reasons: [], updatedAt: deps.now() }; deps.db.prepare("INSERT INTO settings(key,value) VALUES('safe_mode',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(value)); res.json({ safeMode: value }) })

  router.delete("/enhancements/runtime/jobs/:id", deps.requireAuth, (req, res) => { const result = deps.db.prepare("UPDATE runtime_jobs SET status='cancelled',updated_at=? WHERE id=? AND status NOT IN ('completed','cancelled','dead_letter')").run(deps.now(), req.params.id); res.json({ cancelled: result.changes > 0 }) })
  router.post("/enhancements/runtime/jobs/:id/retry", deps.requireAuth, (req, res) => { const result = deps.db.prepare("UPDATE runtime_jobs SET status='pending',attempts=0,progress=0,updated_at=?,error_json=NULL WHERE id=?").run(deps.now(), req.params.id); if (!result.changes) return res.status(404).json({ error: "Runtime job not found" }); const job = deps.db.prepare("SELECT * FROM runtime_jobs WHERE id=?").get(req.params.id) as Record<string, unknown>; res.json({ job: { id: job.id, type: job.type, status: String(job.status ?? "unknown"), priority: Number(job.priority), attempts: Number(job.attempts), maxAttempts: Number(job.max_attempts), progress: Number(job.progress), updatedAt: job.updated_at, runAfter: Number(job.run_after) } }) })
  router.get("/enhancements/runtime/deliveries", deps.requireAuth, (_req, res) => { const rows = deps.db.prepare("SELECT payload_json FROM delivery_receipts ORDER BY updated_at DESC").all() as Array<{ payload_json: string }>; const receipts = rows.map((r) => JSON.parse(r.payload_json)); const stats: Record<string, number> = {}; for (const receipt of receipts) stats[receipt.status] = (stats[receipt.status] || 0) + 1; res.json({ receipts, stats }) })

  deps.registerShutdownHandler?.(async () => {
    dashboardShuttingDown = true
    if (evolutionTimer) clearInterval(evolutionTimer)
    unsubscribeMessageSent?.()
    await evolutionTask?.catch((error) => {
      deps.appendGatewayLog(`Evolution cycle did not stop cleanly: ${error instanceof Error ? error.message : String(error)}`)
    })
    try {
      await mcpManager.close()
    } catch (error) {
      deps.appendGatewayLog(`MCP manager shutdown failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })

  return router
}
