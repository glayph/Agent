import { createHash, randomUUID, verify as verifySignature } from "node:crypto"
import { execFileSync } from "node:child_process"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { readZip } from "@miki/core/skills"
import { Router, type RequestHandler } from "express"

const API_VERSION = "1.0"
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024
const MAX_UNPACKED_BYTES = 50 * 1024 * 1024
const MAX_FILES = 200
const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/
const PERMISSIONS = new Set(["network", "filesystem-read", "filesystem-write", "secrets", "shell", "browser", "computer-use", "mcp", "agent-delegation"])
const UNSUPPORTED_SANDBOX_PERMISSIONS = new Set(["network", "secrets", "shell", "browser", "computer-use", "mcp", "agent-delegation"])
const CAPABILITIES = new Set(["ai-provider", "channel", "mcp", "tool", "memory", "search", "browser", "computer-use", "knowledge", "storage", "authentication", "security", "scheduler", "workflow", "code-execution", "integration", "notification", "model-router", "observability", "guardrail", "agent-to-agent"])

type PluginManifest = { id: string; displayName: string; version: string; apiVersion: string; entrypoint: string; capabilities: string[]; permissions: string[]; dependencies?: string[]; description?: string; platform?: string[]; monitorIconKey?: string }
type InstalledRow = { id: string; version: string; digest: string; source: string; install_path: string; enabled: number; lifecycle_state: string; runtime_status: string; manifest_json: string; permissions_json: string; grants_json: string; installed_at: string; updated_at: string; last_error_code: string | null }
type RuntimeHandle = { child: ChildProcessWithoutNullStreams; request: (message: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>; stop: () => Promise<void>; health: () => Promise<{ ok: boolean; details?: Record<string, unknown> }> }

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)) }
function isSafeArchivePath(value: string): boolean {
  if (!value || value.length > 1024 || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false
  const parts = value.split("/").filter(Boolean)
  return parts.length > 0 && parts.length <= 16 && parts.every((part) => part !== "." && part !== "..")
}
function extractPluginArchive(archive: Buffer, extractPath: string): { root: string; names: string[] } {
  const entries = readZip(archive, {
    maxEntries: MAX_FILES,
    maxTotalBytes: MAX_UNPACKED_BYTES,
    maxFileBytes: MAX_UNPACKED_BYTES,
  })
  const names = entries.map((entry) => entry.path)
  if (!names.length || names.length > MAX_FILES || new Set(names).size !== names.length || names.some((name) => !isSafeArchivePath(name))) {
    throw new Error("package_archive_paths_invalid")
  }
  if (names.filter((name) => name === "miki-plugin.json").length !== 1) {
    throw new Error("package_manifest_missing_or_duplicate")
  }

  mkdirSync(extractPath, { recursive: true, mode: 0o700 })
  const root = realpathSync(extractPath)
  for (const entry of entries) {
    const target = path.resolve(root, ...entry.path.split("/"))
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error("package_path_escape")
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
    // The defensive ZIP reader rejects traversal, duplicate entries, symlinks,
    // encrypted files and oversized content. Create only regular files with
    // restrictive permissions; never restore archive-provided executable bits.
    writeFileSync(target, entry.data, { mode: 0o600, flag: "wx" })
  }
  return { root, names }
}

function validateManifest(input: unknown): PluginManifest {
  if (!isRecord(input)) throw new Error("manifest_invalid")
  const id = typeof input.id === "string" ? input.id.trim() : ""
  const version = typeof input.version === "string" ? input.version.trim() : ""
  const entrypoint = typeof input.entrypoint === "string" ? input.entrypoint.trim() : ""
  if (!ID_PATTERN.test(id) || id.length > 120 || id.startsWith("builtin.")) throw new Error("manifest_id_invalid")
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("manifest_version_invalid")
  if (input.apiVersion !== API_VERSION) throw new Error("plugin_api_version_unsupported")
  if (!isSafeArchivePath(entrypoint) || !/\.(?:mjs|js)$/.test(entrypoint)) throw new Error("manifest_entrypoint_invalid")
  if (typeof input.displayName !== "string" || !input.displayName.trim() || input.displayName.length > 120) throw new Error("manifest_display_name_invalid")
  if (!Array.isArray(input.capabilities) || input.capabilities.length > 32 || input.capabilities.some((item) => typeof item !== "string" || !CAPABILITIES.has(item))) throw new Error("manifest_capabilities_invalid")
  const permissions = Array.isArray(input.permissions) ? input.permissions : []
  if (permissions.length > 20 || permissions.some((item) => typeof item !== "string" || !PERMISSIONS.has(item))) throw new Error("manifest_permissions_invalid")
  const dependencies = Array.isArray(input.dependencies) ? input.dependencies : []
  if (dependencies.length > 32 || dependencies.some((item) => typeof item !== "string" || !ID_PATTERN.test(item))) throw new Error("manifest_dependencies_invalid")
  const platform = Array.isArray(input.platform) ? input.platform : ["any"]
  if (platform.some((item) => !["any", "linux", "win32", "darwin"].includes(String(item)))) throw new Error("manifest_platform_invalid")
  const monitorIconKey = typeof input.monitorIconKey === "string" ? input.monitorIconKey.trim().toLowerCase() : undefined
  // Icons are resolved only from the bundled local registry; manifests cannot supply markup or remote URLs.
  const supportedMonitorIcons = new Set(["plugin", "github", "slack", "gmail", "calendar", "notion", "linear", "hubspot", "salesforce", "jira", "drive", "discord"])
  if (monitorIconKey && !supportedMonitorIcons.has(monitorIconKey)) throw new Error("manifest_monitor_icon_invalid")
  return { id, version, entrypoint, apiVersion: API_VERSION, displayName: input.displayName.trim(), capabilities: [...new Set(input.capabilities as string[])], permissions: [...new Set(permissions as string[])], dependencies: [...new Set(dependencies as string[])], description: typeof input.description === "string" ? input.description.slice(0, 500) : undefined, platform: [...new Set(platform as string[])], ...(monitorIconKey ? { monitorIconKey } : {}) }
}

const RUNNER_SOURCE = String.raw`
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const entry = path.resolve(process.argv[2]);
console.log = (...args) => console.error('[plugin]', ...args);
console.info = (...args) => console.error('[plugin]', ...args);
console.warn = (...args) => console.error('[plugin]', ...args);
let runtime;
try {
  const imported = await import(pathToFileURL(entry).href);
  const factory = typeof imported.createPlugin === 'function' ? imported.createPlugin : typeof imported.default === 'function' ? imported.default : undefined;
  runtime = factory ? await factory({ id: process.env.MIKI_PLUGIN_ID, version: process.env.MIKI_PLUGIN_VERSION, permissions: JSON.parse(process.env.MIKI_PLUGIN_PERMISSIONS || '[]') }) : (imported.default || imported.plugin || imported);
  if (!runtime || typeof runtime !== 'object') throw new Error('plugin_runtime_invalid');
  await runtime.start?.();
  const health = typeof runtime.health === 'function' ? await runtime.health() : { ok: true, status: 'started' };
  process.stdout.write(JSON.stringify({ type: 'ready', health: { ok: health?.ok !== false, status: typeof health?.status === 'string' ? health.status : 'started' } }) + '\n');
} catch (e) {
  process.stdout.write(JSON.stringify({ type: 'error', code: e instanceof Error && /^[a-z0-9_:-]{1,80}$/i.test(e.message) ? e.message : 'plugin_start_failed' }) + '\n');
  process.exit(1);
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', async (chunk) => {
  buffer += chunk;
  const lines = buffer.split('\n'); buffer = lines.pop() || '';
  // Bound each incomplete/request frame, not the combined chunk: several
  // individually valid concurrent requests may arrive in one stream event.
  if (buffer.length > 131072) { process.exit(3); return; }
  for (const line of lines) {
    if (line.length > 131072) { process.exit(3); return; }
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    if (msg.type === 'health') {
      try { const h = typeof runtime.health === 'function' ? await runtime.health() : { ok: true, status: 'started' }; process.stdout.write(JSON.stringify({ id: msg.id, health: { ok: h?.ok !== false, status: typeof h?.status === 'string' ? h.status : 'started' } }) + '\n'); }
      catch { process.stdout.write(JSON.stringify({ id: msg.id, health: { ok: false, status: 'health_failed' } }) + '\n'); }
    } else if (msg.type === 'stop') {
      try { await runtime.stop?.(); process.stdout.write(JSON.stringify({ id: msg.id, stopped: true }) + '\n'); } catch {}
      process.exit(0);
    } else if (msg.type === 'describe') {
      try {
        const description = typeof runtime.describe === 'function' ? await runtime.describe() : null;
        const serialized = JSON.stringify(description);
        if (serialized && serialized.length > 32768) throw new Error('plugin_description_too_large');
        process.stdout.write(JSON.stringify({ id: msg.id, ok: true, available: description !== null && description !== undefined, description: description ?? null }) + '\n');
      } catch (e) {
        const code = e instanceof Error && /^[a-z0-9_:-]{1,80}$/i.test(e.message) ? e.message : 'plugin_describe_failed';
        process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: code }) + '\n');
      }
    } else if (msg.type === 'invoke' && typeof runtime.handle === 'function' && /^[a-z0-9_.:-]{1,120}$/i.test(String(msg.method || ''))) {
      try { const result = await runtime.handle(String(msg.method), msg.payload); const response = JSON.stringify({ id: msg.id, ok: true, result }); process.stdout.write((response.length > 131072 ? JSON.stringify({ id: msg.id, ok: false, error: 'plugin_response_too_large' }) : response) + '\n'); }
      catch { process.stdout.write(JSON.stringify({ id: msg.id, ok: false, error: 'plugin_call_failed' }) + '\n'); }
    }
  }
});
`


type TrustedRegistryPackage = { id: string; manifest: PluginManifest; digest: string; archive: Buffer }

function readTrustedRegistry(configDir: string): { configured: boolean; packages: TrustedRegistryPackage[]; unavailableReason?: string; warnings: string[] } {
  const registryPath = process.env.MIKI_PLUGIN_REGISTRY_FILE
    ? path.resolve(configDir, process.env.MIKI_PLUGIN_REGISTRY_FILE)
    : path.join(configDir, "plugins", "registry.json")
  if (!existsSync(registryPath)) return { configured: false, packages: [], warnings: ["No trusted plugin registry is configured."] }
  try {
    const registryRoot = realpathSync(path.dirname(registryPath))
    const publicKeyPath = path.join(registryRoot, "trusted-public-key.pem")
    if (!existsSync(publicKeyPath)) return { configured: true, packages: [], unavailableReason: "registry_trust_key_missing", warnings: ["The trusted plugin registry has no trusted-public-key.pem; packages cannot be verified."] }
    const publicKey = readFileSync(publicKeyPath, "utf8")
    const parsed = JSON.parse(readFileSync(registryPath, "utf8")) as { packages?: unknown }
    const items = Array.isArray(parsed.packages) ? parsed.packages : []
    const packages: TrustedRegistryPackage[] = []
    const warnings: string[] = []
    if (!Array.isArray(parsed.packages)) warnings.push("registry.json must contain a packages array.")
    else if (!items.length) warnings.push("The trusted plugin registry is configured but contains no package entries.")
    const seenPackageIds = new Set<string>()
    for (const item of items) {
      if (!isRecord(item)) { warnings.push("A plugin registry entry was skipped because it is not an object."); continue }
      try {
        const manifest = validateManifest(item.manifest)
        if (seenPackageIds.has(manifest.id)) { warnings.push(`Duplicate plugin registry entry ignored: ${manifest.id}`); continue }
        const archiveName = typeof item.archive === "string" ? item.archive : ""
        const digest = typeof item.sha256 === "string" ? item.sha256.toLowerCase() : ""
        const signatureText = typeof item.signature === "string" ? item.signature : ""
        if (!isSafeArchivePath(archiveName) || !/^[a-f0-9]{64}$/.test(digest) || !/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText)) { warnings.push(`Plugin ${manifest.id} skipped: archive path, SHA-256 digest, or signature encoding is invalid.`); continue }
        const archivePath = path.resolve(registryRoot, archiveName)
        if (!archivePath.startsWith(`${registryRoot}${path.sep}`) || !existsSync(archivePath)) { warnings.push(`Plugin ${manifest.id} skipped: package archive is missing or outside the trusted registry directory.`); continue }
        const realArchivePath = realpathSync(archivePath)
        if (!realArchivePath.startsWith(`${registryRoot}${path.sep}`) || !lstatSync(archivePath).isFile() || lstatSync(archivePath).isSymbolicLink()) { warnings.push(`Plugin ${manifest.id} skipped: archive is not a regular file within the trusted registry.`); continue }
        const archive = readFileSync(realArchivePath)
        if (!archive.length || archive.length > MAX_ARCHIVE_BYTES || createHash("sha256").update(archive).digest("hex") !== digest) { warnings.push(`Plugin ${manifest.id} skipped: archive is empty, too large, or its checksum does not match.`); continue }
        const signature = Buffer.from(signatureText, "base64")
        if (signature.length !== 64 || !verifySignature(null, archive, publicKey, signature)) { warnings.push(`Plugin ${manifest.id} skipped: Ed25519 signature verification failed.`); continue }
        seenPackageIds.add(manifest.id)
        packages.push({ id: manifest.id, manifest, digest, archive })
      } catch (error) {
        // Invalid entries are excluded individually; a broken package never weakens registry trust.
        warnings.push(`A plugin registry entry was skipped: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (items.length && !packages.length && !warnings.length) warnings.push("The registry contains no usable verified plugin packages.")
    return { configured: true, packages, warnings }
  } catch {
    return { configured: true, packages: [], unavailableReason: "plugin_registry_invalid", warnings: ["The trusted plugin registry could not be parsed or verified."] }
  }
}

export interface PluginManagementOptions {
  db: Database.Database
  dataRoot: string
  configDir: string
  requireAuth: RequestHandler
  now: () => string
  builtinIds: ReadonlySet<string>
  /** Run extension code with the guest OS identity and skip the nested plugin sandbox. */
  allowUnrestrictedGuestPlugins?: () => boolean
  registerShutdownHandler?: (handler: () => void | Promise<void>) => void
}

export function ensurePluginManagementSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS plugin_installations (
      id TEXT PRIMARY KEY, version TEXT NOT NULL, digest TEXT NOT NULL, source TEXT NOT NULL,
      install_path TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, lifecycle_state TEXT NOT NULL DEFAULT 'disabled',
      runtime_status TEXT NOT NULL DEFAULT 'not_started', manifest_json TEXT NOT NULL, permissions_json TEXT NOT NULL,
      grants_json TEXT NOT NULL DEFAULT '[]', installed_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_error_code TEXT
    );
    CREATE TABLE IF NOT EXISTS plugin_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, plugin_id TEXT NOT NULL, event TEXT NOT NULL,
      status TEXT NOT NULL, code TEXT, at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_audit_plugin_at ON plugin_audit(plugin_id, at DESC);
  `)
}

export function createPluginManagementRouter(options: PluginManagementOptions) {
  const { db, dataRoot, configDir, now, builtinIds } = options
  ensurePluginManagementSchema(db)
  const router = Router()
  router.use(options.requireAuth)
  const root = path.join(dataRoot, "plugins", "installed")
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const runtimes = new Map<string, RuntimeHandle>()
  const audit = (id: string, event: string, status: string, code?: string) => db.prepare("INSERT INTO plugin_audit(plugin_id,event,status,code,at) VALUES(?,?,?,?,?)").run(id, event, status, code ?? null, now())
  const sandboxAvailable = (() => {
    if (process.platform !== "linux") return false
    try {
      execFileSync("unshare", ["-Urn", "--", "true"], { timeout: 2_000, stdio: "ignore" })
      execFileSync("prlimit", ["--cpu=60", "--nofile=128", "--", "true"], { timeout: 2_000, stdio: "ignore" })
      return true
    } catch { return false }
  })()
  const listRows = () => db.prepare("SELECT * FROM plugin_installations ORDER BY installed_at DESC").all() as InstalledRow[]
  const unrestrictedGuestPlugins = () => options.allowUnrestrictedGuestPlugins?.() === true
  const pluginExecutionMode = () => unrestrictedGuestPlugins() ? "guest_unrestricted" : sandboxAvailable ? "os_sandbox" : "unavailable"
  const publicRow = (row: InstalledRow) => ({ id: row.id, version: row.version, digest: row.digest, source: row.source, enabled: row.enabled === 1, lifecycle_state: row.lifecycle_state, runtime_status: row.runtime_status, manifest: JSON.parse(row.manifest_json) as PluginManifest, requested_permissions: JSON.parse(row.permissions_json) as string[], granted_permissions: JSON.parse(row.grants_json) as string[], installed_at: row.installed_at, updated_at: row.updated_at, last_error_code: row.last_error_code, sandbox_supported: sandboxAvailable && !unrestrictedGuestPlugins(), execution_mode: pluginExecutionMode() })
  const rowById = (id: string) => db.prepare("SELECT * FROM plugin_installations WHERE id=?").get(id) as InstalledRow | undefined

  const request = (runtime: RuntimeHandle, message: Record<string, unknown>, timeoutMs = 2_000) => runtime.request(message, timeoutMs)
  /** Only enabled, healthy plugins running under the active guest/OS execution mode are visible to the autonomous agent. */
  const listAgentPlugins = () => listRows().flatMap((row) => {
    if (row.enabled !== 1 || row.lifecycle_state !== "healthy" || row.runtime_status !== "healthy" || !runtimes.has(row.id)) return []
    const manifest = JSON.parse(row.manifest_json) as PluginManifest
    const requested = JSON.parse(row.permissions_json) as string[]
    const granted = unrestrictedGuestPlugins() ? requested : JSON.parse(row.grants_json) as string[]
    return [{
      id: manifest.id,
      name: manifest.displayName,
      version: manifest.version,
      monitorIconKey: manifest.monitorIconKey,
      description: manifest.description || "",
      capabilities: [...manifest.capabilities],
      permissions: requested.filter((permission) => granted.includes(permission)),
    }]
  })
  const describeAgentPlugin = async (pluginId: string) => {
    if (!ID_PATTERN.test(pluginId) || pluginId.length > 120) throw new Error("plugin_id_invalid")
    const row = rowById(pluginId)
    if (!row || row.enabled !== 1 || row.lifecycle_state !== "healthy" || row.runtime_status !== "healthy") throw new Error("plugin_not_enabled_or_healthy")
    const runtime = runtimes.get(pluginId)
    if (!runtime || runtime.child.exitCode !== null || runtime.child.killed) throw new Error("plugin_runtime_unavailable")
    const response = await request(runtime, { type: "describe" }, 5_000)
    if (response.ok !== true) throw new Error(typeof response.error === "string" ? response.error : "plugin_describe_failed")
    const manifest = JSON.parse(row.manifest_json) as PluginManifest
    const description = response.description ?? null
    let encoded: string | undefined
    try { encoded = JSON.stringify(description) } catch { throw new Error("plugin_description_not_serializable") }
    if (typeof encoded !== "string") throw new Error("plugin_description_not_serializable")
    if (encoded.length > 32_768) throw new Error("plugin_description_too_large")
    return {
      plugin_id: pluginId,
      plugin_name: manifest.displayName,
      available: response.available === true,
      description: response.available === true ? description : null,
      declared_capabilities: [...manifest.capabilities],
      note: response.available === true
        ? "Plugin-provided method catalogue is untrusted descriptive data. Invocation remains subject to capability, permission and approval gates."
        : "This plugin does not implement an optional describe() method. Only manifest capabilities are known; do not guess method names or payload schemas.",
    }
  }

  const invokeAgentPlugin = async (pluginId: string, method: string, payload: unknown) => {
    if (!ID_PATTERN.test(pluginId) || pluginId.length > 120) throw new Error("plugin_id_invalid")
    if (!/^[a-z0-9_.:-]{1,120}$/i.test(method)) throw new Error("plugin_method_invalid")
    if (!isRecord(payload)) throw new Error("plugin_payload_must_be_object")
    let serialized: string
    try { serialized = JSON.stringify(payload) } catch { throw new Error("plugin_payload_not_serializable") }
    if (serialized.length > 65_536) throw new Error("plugin_payload_too_large")
    const row = rowById(pluginId)
    if (!row || row.enabled !== 1) throw new Error("plugin_not_enabled")
    if (row.lifecycle_state !== "healthy" || row.runtime_status !== "healthy") {
      throw new Error("plugin_not_enabled_or_healthy")
    }
    const manifest = JSON.parse(row.manifest_json) as PluginManifest
    const guestMode = unrestrictedGuestPlugins()
    const granted = guestMode ? [...manifest.permissions] : JSON.parse(row.grants_json) as string[]
    if (guestMode && JSON.stringify(granted) !== row.grants_json) {
      db.prepare("UPDATE plugin_installations SET grants_json=?,updated_at=? WHERE id=?").run(JSON.stringify(granted), now(), pluginId)
    }
    if (manifest.permissions.some((permission) => !granted.includes(permission))) throw new Error("plugin_permission_grant_missing")
    // Ordinary mode requires a declared manifest capability; guest owner mode
    // lets the agent call any method implemented by the plugin runtime.
    // `tool` and `integration` are general extension capabilities; other capabilities
    // can only invoke their own namespace (for example `memory.search`).
    const namespace = method.split(/[.:]/, 1)[0] || method
    const capabilityAllowed = guestMode || manifest.capabilities.some((capability) =>
      method === capability || method.startsWith(`${capability}.`) || method.startsWith(`${capability}:`)
      || (capability === "tool" && method.length > 0)
      || (capability === "integration" && namespace === "integration"),
    )
    if (!capabilityAllowed) throw new Error("plugin_capability_not_declared")
    const runtime = runtimes.get(pluginId)
    if (!runtime || runtime.child.exitCode !== null || runtime.child.killed) throw new Error("plugin_runtime_unavailable")
    const response = await request(runtime, { type: "invoke", method, payload }, 120_000)
    if (response.ok !== true) {
      const code = typeof response.error === "string" && /^[a-z0-9_:-]{1,100}$/i.test(response.error) ? response.error : "plugin_call_failed"
      audit(pluginId, "agent_invoke", "failed", code)
      throw new Error(code)
    }
    audit(pluginId, "agent_invoke", "success")
    return { plugin: pluginId, method, result: response.result ?? null }
  }

  const stopRuntime = async (id: string) => {
    const runtime = runtimes.get(id)
    if (!runtime) return
    runtimes.delete(id)
    try { await runtime.stop() } catch { runtime.child.kill("SIGKILL") }
  }

  const startRuntime = async (row: InstalledRow, granted: string[]) => {
    const guestMode = unrestrictedGuestPlugins()
    if (!guestMode && !sandboxAvailable) throw new Error("sandbox_unavailable")
    const manifest = JSON.parse(row.manifest_json) as PluginManifest
    const unsupported = manifest.permissions.filter((permission) => UNSUPPORTED_SANDBOX_PERMISSIONS.has(permission))
    if (!guestMode && unsupported.length) throw new Error("permission_not_supported_by_sandbox")
    if (manifest.permissions.some((permission) => !granted.includes(permission))) throw new Error("permission_grant_required")
    if (!manifest.platform?.includes("any") && !manifest.platform?.includes(process.platform)) throw new Error("plugin_platform_incompatible")
    const packageRoot = realpathSync(row.install_path)
    const entry = path.resolve(packageRoot, manifest.entrypoint)
    if (!entry.startsWith(`${packageRoot}${path.sep}`) || !existsSync(entry)) throw new Error("plugin_entrypoint_missing")
    // Bound CPU time and open descriptors in addition to network namespace
    // isolation, a capped Node heap, and Node's filesystem permission model.
    const nodeArgs = ["--max-old-space-size=256",
      ...(guestMode ? [] : ["--experimental-permission", `--allow-fs-read=${packageRoot}`,
        ...(granted.includes("filesystem-write") ? [`--allow-fs-write=${packageRoot}`] : [])]),
      path.join(packageRoot, ".miki-plugin-runner.mjs"), entry]
    let child: ChildProcessWithoutNullStreams
    const pluginEnv = guestMode
      ? { ...process.env, HOME: process.env.HOME || packageRoot, NODE_ENV: "production", MIKI_PLUGIN_ID: manifest.id, MIKI_PLUGIN_VERSION: manifest.version, MIKI_PLUGIN_PERMISSIONS: JSON.stringify(granted) }
      : { PATH: "/usr/bin:/bin", HOME: packageRoot, NODE_ENV: "production", MIKI_PLUGIN_ID: manifest.id, MIKI_PLUGIN_VERSION: manifest.version, MIKI_PLUGIN_PERMISSIONS: JSON.stringify(granted) }
    if (guestMode) {
      // The outer disposable VM/container is the security boundary in owner mode.
      // Keep resource limits where prlimit exists, but do not apply a nested network
      // namespace or Node permission sandbox that would remove guest capabilities.
      let prlimitAvailable = false
      if (process.platform === "linux") {
        try { execFileSync("prlimit", ["--version"], { timeout: 1_000, stdio: "ignore" }); prlimitAvailable = true } catch { /* optional guest utility */ }
      }
      child = prlimitAvailable
        ? spawn("prlimit", ["--cpu=60", "--nofile=128", "--", process.execPath, ...nodeArgs], { cwd: packageRoot, env: pluginEnv, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(process.execPath, nodeArgs, { cwd: packageRoot, env: pluginEnv, stdio: ["pipe", "pipe", "pipe"] })
    } else {
      const args = ["-Urn", "--", "prlimit", "--cpu=60", "--nofile=128", "--",
        process.execPath, ...nodeArgs]
      child = spawn("unshare", args, { cwd: packageRoot, env: pluginEnv, stdio: ["pipe", "pipe", "pipe"] })
    }
    let stdout = ""
    let stderr = ""
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString("utf8")).slice(-4000) })
    const ready = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("plugin_start_timeout")) }, 5_000)
      const onData = (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
        const i = stdout.indexOf("\n")
        if (i < 0) { if (stdout.length > 65536) { clearTimeout(timer); reject(new Error("plugin_runtime_output_limit")) } return }
        const line = stdout.slice(0, i); stdout = stdout.slice(i + 1)
        clearTimeout(timer); child.stdout.off("data", onData)
        try { resolve(JSON.parse(line) as Record<string, unknown>) } catch { reject(new Error("plugin_runtime_protocol_error")) }
      }
      child.stdout.on("data", onData)
      child.once("error", (error) => { clearTimeout(timer); reject(error) })
      child.once("exit", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error("plugin_start_failed")) })
    }).catch((error: unknown) => {
      const code = error instanceof Error && /^[a-z0-9_:-]{1,80}$/i.test(error.message) ? error.message : "plugin_start_failed"
      throw new Error(code)
    })
    if (ready.type !== "ready" || !isRecord(ready.health) || ready.health.ok !== true) {
      child.kill("SIGKILL")
      throw new Error(isRecord(ready) && typeof ready.code === "string" ? ready.code : "plugin_health_failed")
    }
    let protocolBuffer = stdout
    const pendingRequests = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>()
    const rejectPending = (code: string) => {
      for (const pending of pendingRequests.values()) { clearTimeout(pending.timer); pending.reject(new Error(code)) }
      pendingRequests.clear()
    }
    child.stdout.on("data", (chunk) => {
      protocolBuffer += chunk.toString("utf8")
      if (protocolBuffer.length > 131_072 && !protocolBuffer.includes("\n")) { child.kill("SIGKILL"); rejectPending("plugin_runtime_output_limit"); return }
      let boundary = protocolBuffer.indexOf("\n")
      while (boundary >= 0) {
        const line = protocolBuffer.slice(0, boundary)
        protocolBuffer = protocolBuffer.slice(boundary + 1)
        if (line.length > 131_072) { child.kill("SIGKILL"); rejectPending("plugin_runtime_output_limit"); return }
        try {
          const response = JSON.parse(line) as Record<string, unknown>
          const responseId = typeof response.id === "string" ? response.id : ""
          const pending = pendingRequests.get(responseId)
          if (pending) {
            pendingRequests.delete(responseId)
            clearTimeout(pending.timer)
            pending.resolve(response)
          }
        } catch {
          // Plugin stdout is not a logging API. Ignore malformed, unsolicited lines; bounded buffers prevent memory growth.
        }
        boundary = protocolBuffer.indexOf("\n")
      }
    })
    child.once("exit", () => rejectPending("plugin_runtime_unavailable"))
    const handle: RuntimeHandle = {
      child,
      request: (message, timeoutMs = 2_000) => new Promise<Record<string, unknown>>((resolve, reject) => {
        if (child.exitCode !== null || child.killed) { reject(new Error("plugin_runtime_unavailable")); return }
        const reqId = randomUUID()
        const timer = setTimeout(() => { pendingRequests.delete(reqId); reject(new Error("plugin_runtime_timeout")) }, timeoutMs)
        pendingRequests.set(reqId, { resolve, reject, timer })
        child.stdin.write(JSON.stringify({ ...message, id: reqId }) + "\n", (error) => {
          if (!error) return
          const pending = pendingRequests.get(reqId)
          if (pending) { pendingRequests.delete(reqId); clearTimeout(pending.timer); reject(new Error("plugin_runtime_unavailable")) }
        })
      }),
      stop: async () => {
        if (child.exitCode !== null) return
        child.stdin.write(JSON.stringify({ type: "stop", id: randomUUID() }) + "\n")
        await Promise.race([new Promise<void>((resolve) => child.once("exit", () => resolve())), new Promise<void>((resolve) => setTimeout(() => { child.kill("SIGKILL"); resolve() }, 1_500))])
      },
      health: async () => {
        const response = await request(handle, { type: "health" })
        return isRecord(response.health) ? response.health as { ok: boolean; details?: Record<string, unknown> } : { ok: false }
      },
    }
    child.once("exit", (code) => {
      if (runtimes.get(manifest.id) !== handle) return
      runtimes.delete(manifest.id)
      db.prepare("UPDATE plugin_installations SET runtime_status='failed',lifecycle_state='failed',last_error_code=?,updated_at=? WHERE id=?").run(code === 0 ? "runtime_stopped_unexpectedly" : "runtime_exited", now(), manifest.id)
    })
    runtimes.set(manifest.id, handle)
    return handle
  }

  const dependenciesFor = (id: string) => listRows().filter((row) => {
    const manifest = JSON.parse(row.manifest_json) as PluginManifest
    return manifest.dependencies?.includes(id)
  }).map((row) => row.id)
  const createsDependencyCycle = (pluginId: string, proposedDependencies: string[]): boolean => {
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): boolean => {
      if (visiting.has(id)) return true
      if (visited.has(id)) return false
      visiting.add(id)
      let dependencies: string[] = []
      if (id === pluginId) dependencies = proposedDependencies
      else {
        const row = rowById(id)
        if (row) { try { dependencies = (JSON.parse(row.manifest_json) as PluginManifest).dependencies ?? [] } catch { dependencies = [] } }
      }
      for (const dependency of dependencies) if (visit(dependency)) return true
      visiting.delete(id)
      visited.add(id)
      return false
    }
    return visit(pluginId)
  }


  const listInstalledPlugins = () => listRows().map((row) => {
    const manifest = JSON.parse(row.manifest_json) as PluginManifest
    const requested = JSON.parse(row.permissions_json) as string[]
    const granted = unrestrictedGuestPlugins() ? requested : JSON.parse(row.grants_json) as string[]
    const missing = requested.filter((permission) => !granted.includes(permission))
    const unsupported = requested.filter((permission) => UNSUPPORTED_SANDBOX_PERMISSIONS.has(permission))
    const active = row.enabled === 1 && row.lifecycle_state === "healthy" && row.runtime_status === "healthy" && runtimes.has(row.id)
    const blockedReason = active ? undefined
      : row.last_error_code ?? (!unrestrictedGuestPlugins() && !sandboxAvailable ? "sandbox_unavailable"
        : !unrestrictedGuestPlugins() && unsupported.length ? `permission_not_supported_by_sandbox:${unsupported.join(",")}`
          : missing.length ? `permission_grant_required:${missing.join(",")}`
            : row.enabled !== 1 ? "plugin_disabled"
              : !runtimes.has(row.id) ? "runtime_not_running" : "runtime_unhealthy")
    return { ...publicRow(row), available_to_invoke: active, blocked_reason: blockedReason }
  })

  const listTrustedPluginPackages = () => {
    const registry = readTrustedRegistry(configDir)
    return {
      configured: registry.configured,
      packages: registry.packages.map((item) => ({ id: item.id, manifest: item.manifest, description: item.manifest.description ?? "", digest: item.digest, installed: Boolean(rowById(item.id)), trusted: true })),
      total: registry.packages.length,
      source: "trusted_local_registry",
      warnings: registry.warnings,
      ...(!registry.configured ? { unavailable_reason: "registry_not_configured" } : registry.unavailableReason ? { unavailable_reason: registry.unavailableReason } : {}),
    }
  }

  /** Install only a package present in the locally configured, signature-verified registry. */
  const installTrustedPluginPackage = async (registryId: string) => {
    if (!ID_PATTERN.test(registryId)) throw new Error("plugin_registry_id_invalid")
    const registry = readTrustedRegistry(configDir)
    if (!registry.configured) throw new Error("registry_not_configured: configure a signed local plugin registry first")
    if (registry.unavailableReason) throw new Error(registry.unavailableReason)
    const trusted = registry.packages.find((item) => item.id === registryId)
    if (!trusted) throw new Error(`trusted_plugin_package_not_found${registry.warnings.length ? `: ${registry.warnings.join(" ")}` : ""}`)
    if (rowById(registryId)) throw new Error("plugin_already_installed: use the Plugin page to review upgrades")
    const archive = trusted.archive
    const expectedHash = trusted.digest
    const digest = createHash("sha256").update(archive).digest("hex")
    if (digest !== expectedHash) throw new Error("package_checksum_mismatch")
    const staging = mkdtempSync(path.join(root, ".staging-agent-"))
    const extractPath = path.join(staging, "contents")
    let dest = ""
    let movedNew = false
    try {
      const { root: extractReal } = extractPluginArchive(archive, extractPath)
      const manifest = validateManifest(JSON.parse(readFileSync(path.join(extractReal, "miki-plugin.json"), "utf8")) as unknown)
      if (JSON.stringify(manifest) !== JSON.stringify(trusted.manifest)) throw new Error("plugin_registry_manifest_mismatch")
      if (builtinIds.has(manifest.id)) throw new Error("builtin_plugin_immutable")
      for (const dependency of manifest.dependencies ?? []) if (!rowById(dependency) && !builtinIds.has(dependency)) throw new Error("plugin_dependency_missing")
      if (createsDependencyCycle(manifest.id, manifest.dependencies ?? [])) throw new Error("plugin_dependency_cycle")
      dest = path.join(root, `${manifest.id}-${manifest.version}`)
      if (!path.resolve(dest).startsWith(`${path.resolve(root)}${path.sep}`) || existsSync(dest)) throw new Error("plugin_version_path_exists")
      writeFileSync(path.join(extractReal, ".miki-plugin-runner.mjs"), RUNNER_SOURCE, { mode: 0o600 })
      renameSync(extractReal, dest)
      movedNew = true
      const at = now()
      const grants = unrestrictedGuestPlugins() ? [...manifest.permissions] : []
      db.prepare(`INSERT INTO plugin_installations(id,version,digest,source,install_path,enabled,lifecycle_state,runtime_status,manifest_json,permissions_json,grants_json,installed_at,updated_at,last_error_code) VALUES(?,?,?,?,?,0,'disabled','not_started',?,?,?,?,?,NULL)`)
        .run(manifest.id, manifest.version, digest, "trusted_registry", dest, JSON.stringify(manifest), JSON.stringify(manifest.permissions), JSON.stringify(grants), at, at)
      audit(manifest.id, "install", "success")
      return publicRow(rowById(manifest.id) as InstalledRow)
    } catch (error) {
      if (movedNew && dest) rmSync(dest, { recursive: true, force: true })
      audit(registryId, "install", "failed", error instanceof Error ? error.message.slice(0, 100) : "plugin_install_failed")
      throw error
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  const setPluginEnabled = async (id: string, enabled: boolean) => {
    if (builtinIds.has(id)) throw new Error("builtin_plugin_immutable")
    const row = rowById(id)
    if (!row) throw new Error("plugin_not_found")
    const manifest = JSON.parse(row.manifest_json) as PluginManifest
    const grants = unrestrictedGuestPlugins() ? [...manifest.permissions] : JSON.parse(row.grants_json) as string[]
    if (!enabled) {
      db.prepare("UPDATE plugin_installations SET enabled=0,lifecycle_state='stopping',updated_at=?,last_error_code=NULL WHERE id=?").run(now(), id)
      try { await stopRuntime(id) } catch { /* persist disabled state even when shutdown reports an error */ }
      db.prepare("UPDATE plugin_installations SET lifecycle_state='disabled',runtime_status='disabled',updated_at=? WHERE id=?").run(now(), id)
      audit(id, "disable", "success")
      return publicRow(rowById(id) as InstalledRow)
    }
    const unsupported = manifest.permissions.filter((permission) => UNSUPPORTED_SANDBOX_PERMISSIONS.has(permission))
    if (!unrestrictedGuestPlugins() && unsupported.length) throw new Error(`permission_not_supported_by_sandbox:${unsupported.join(",")}`)
    const missing = manifest.permissions.filter((permission) => !grants.includes(permission))
    if (missing.length) throw new Error(`permission_grant_required:${missing.join(",")}`)
    if (!sandboxAvailable && !unrestrictedGuestPlugins()) throw new Error("sandbox_unavailable")
    db.prepare("UPDATE plugin_installations SET lifecycle_state='starting',updated_at=?,last_error_code=NULL WHERE id=?").run(now(), id)
    try {
      const runtime = await startRuntime(rowById(id) as InstalledRow, grants)
      if (!(await runtime.health()).ok) throw new Error("plugin_health_failed")
      db.prepare("UPDATE plugin_installations SET enabled=1,lifecycle_state='healthy',runtime_status='healthy',grants_json=?,updated_at=?,last_error_code=NULL WHERE id=?").run(JSON.stringify(grants), now(), id)
      audit(id, "enable", "success")
      return publicRow(rowById(id) as InstalledRow)
    } catch (error) {
      await stopRuntime(id)
      const code = error instanceof Error ? error.message : "plugin_start_failed"
      db.prepare("UPDATE plugin_installations SET enabled=0,lifecycle_state='failed',runtime_status='failed',updated_at=?,last_error_code=? WHERE id=?").run(now(), code, id)
      audit(id, "enable", "failed", code)
      throw error
    }
  }

  const uninstallPlugin = async (id: string) => {
    if (builtinIds.has(id)) throw new Error("builtin_plugin_immutable")
    const row = rowById(id)
    if (!row) throw new Error("plugin_not_found")
    const dependents = dependenciesFor(id)
    if (dependents.length) throw new Error(`plugin_has_dependents:${dependents.join(",")}`)
    const installPath = path.resolve(row.install_path)
    if (!installPath.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("plugin_path_invalid")
    db.prepare("UPDATE plugin_installations SET lifecycle_state='stopping',updated_at=? WHERE id=?").run(now(), id)
    await stopRuntime(id)
    const stagedPath = path.join(root, `.uninstall-${id}-${randomUUID()}`)
    const wasEnabled = row.enabled === 1
    const grants = unrestrictedGuestPlugins() ? (JSON.parse(row.manifest_json) as PluginManifest).permissions : JSON.parse(row.grants_json) as string[]
    try {
      // Stage the package inside the same rollback boundary as the registry
      // mutation. A filesystem rename failure must restore the previous state
      // and restart a plugin that was active before uninstall began.
      if (existsSync(installPath)) renameSync(installPath, stagedPath)
      const deleted = db.prepare("DELETE FROM plugin_installations WHERE id=?").run(id)
      if (deleted.changes !== 1) throw new Error("plugin_registry_remove_failed")
    } catch (error) {
      let restoreFailed = false
      try {
        if (existsSync(stagedPath) && !existsSync(installPath)) renameSync(stagedPath, installPath)
      } catch {
        restoreFailed = true
      }
      if (restoreFailed) {
        db.prepare("UPDATE plugin_installations SET lifecycle_state='failed',runtime_status='failed',enabled=0,last_error_code='uninstall_rollback_restore_failed',updated_at=? WHERE id=?").run(now(), id)
      } else if (wasEnabled) {
        try {
          const runtime = await startRuntime(row, grants)
          if ((await runtime.health()).ok) {
            db.prepare("UPDATE plugin_installations SET lifecycle_state='healthy',runtime_status='healthy',enabled=1,updated_at=? WHERE id=?").run(now(), id)
          } else throw new Error("plugin_health_failed")
        } catch {
          db.prepare("UPDATE plugin_installations SET lifecycle_state='failed',runtime_status='failed',enabled=0,last_error_code='uninstall_rollback_runtime_failed',updated_at=? WHERE id=?").run(now(), id)
        }
      } else {
        db.prepare("UPDATE plugin_installations SET lifecycle_state='disabled',runtime_status='disabled',enabled=0,updated_at=? WHERE id=?").run(now(), id)
      }
      audit(id, "uninstall", "failed", restoreFailed ? "uninstall_rollback_restore_failed" : error instanceof Error ? error.message : "plugin_registry_remove_failed")
      throw error
    }
    try { if (existsSync(stagedPath)) rmSync(stagedPath, { recursive: true, force: true }) } catch { /* database no longer references it; cleanup can be retried safely */ }
    audit(id, "uninstall", "success")
    return { removed: true, id, cleanup_pending: existsSync(stagedPath) }
  }

  router.get("/installed", (_req, res) => res.json({ plugins: listRows().map(publicRow), total: db.prepare("SELECT COUNT(*) AS n FROM plugin_installations").get() && (db.prepare("SELECT COUNT(*) AS n FROM plugin_installations").get() as { n: number }).n, sandbox_supported: sandboxAvailable && !unrestrictedGuestPlugins(), execution_mode: pluginExecutionMode() }))

  router.get("/marketplace", (_req, res) => {
    const registry = readTrustedRegistry(configDir)
    const packages = registry.packages.map((item) => ({ id: item.id, manifest: item.manifest, description: item.manifest.description ?? "", digest: item.digest, installed: Boolean(rowById(item.id)), trusted: true }))
    return res.json({ packages, total: packages.length, source: "trusted_local_registry", warnings: registry.warnings, ...(!registry.configured ? { unavailable_reason: "registry_not_configured" } : registry.unavailableReason ? { unavailable_reason: registry.unavailableReason } : {}) })
  })

  router.post("/install", async (req, res) => {
    const registryId = typeof req.body?.registry_id === "string" ? req.body.registry_id.trim() : ""
    let archive: Buffer
    let expectedHash: string
    let trustedManifest: PluginManifest | undefined
    if (registryId) {
      if (!ID_PATTERN.test(registryId)) return res.status(400).json({ error: "plugin_registry_id_invalid" })
      const registry = readTrustedRegistry(configDir)
      const trusted = registry.packages.find((item) => item.id === registryId)
      if (!trusted) return res.status(registry.unavailableReason ? 503 : 404).json({ error: [registry.unavailableReason || "trusted_plugin_package_not_found", ...registry.warnings].join(": ") })
      archive = trusted.archive
      expectedHash = trusted.digest
      trustedManifest = trusted.manifest
    } else {
      const archiveText = typeof req.body?.archive_base64 === "string" ? req.body.archive_base64 : ""
      expectedHash = typeof req.body?.sha256 === "string" ? req.body.sha256.toLowerCase() : ""
      if (!archiveText || !/^[a-f0-9]{64}$/.test(expectedHash)) return res.status(400).json({ error: "archive_and_sha256_required" })
      if (archiveText.length > Math.ceil(MAX_ARCHIVE_BYTES * 4 / 3) + 8) return res.status(413).json({ error: "archive_too_large" })
      archive = Buffer.from(archiveText, "base64")
      if (!archive.length || archive.length > MAX_ARCHIVE_BYTES || archive.toString("base64").replace(/=+$/, "") !== archiveText.replace(/=+$/, "")) return res.status(413).json({ error: "archive_size_or_encoding_invalid" })
    }
    const digest = createHash("sha256").update(archive).digest("hex")
    if (digest !== expectedHash) return res.status(400).json({ error: "package_checksum_mismatch" })
    const staging = mkdtempSync(path.join(root, ".staging-"))
    const extractPath = path.join(staging, "contents")
    let installedId = "unknown"
    let dest = ""
    let backupPath = ""
    let oldRow: InstalledRow | undefined
    let movedOld = false
    let movedNew = false
    let switchedDatabase = false
    let shouldRestartOld = false
    let oldGrants: string[] = []
    try {
      const { root: extractReal } = extractPluginArchive(archive, extractPath)
      const manifest = validateManifest(JSON.parse(readFileSync(path.join(extractReal, "miki-plugin.json"), "utf8")) as unknown)
      if (trustedManifest && JSON.stringify(manifest) !== JSON.stringify(trustedManifest)) throw new Error("plugin_registry_manifest_mismatch")
      installedId = manifest.id
      if (builtinIds.has(manifest.id)) throw new Error("builtin_plugin_immutable")
      const installed = rowById(manifest.id)
      oldRow = installed
      oldGrants = installed ? JSON.parse(installed.grants_json) as string[] : []
      shouldRestartOld = installed?.enabled === 1
      if (installed && installed.version === manifest.version && installed.digest === digest) return res.status(409).json({ error: "plugin_already_installed" })
      // Never silently grant new capabilities during an upgrade of a currently enabled plugin.
      if (shouldRestartOld && !unrestrictedGuestPlugins() && manifest.permissions.some((permission) => !oldGrants.includes(permission))) {
        return res.status(409).json({ error: "plugin_upgrade_requires_permission_review", permissions: manifest.permissions.filter((permission) => !oldGrants.includes(permission)) })
      }
      if (shouldRestartOld && !unrestrictedGuestPlugins() && manifest.permissions.some((permission) => UNSUPPORTED_SANDBOX_PERMISSIONS.has(permission))) throw new Error("permission_not_supported_by_sandbox")
      for (const dependency of manifest.dependencies ?? []) if (!rowById(dependency) && dependency !== manifest.id) throw new Error("plugin_dependency_missing")
      if (createsDependencyCycle(manifest.id, manifest.dependencies ?? [])) throw new Error("plugin_dependency_cycle")
      dest = path.join(root, `${manifest.id}-${manifest.version}`)
      if (!path.resolve(dest).startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("package_path_escape")
      if (existsSync(dest) && (!installed || path.resolve(installed.install_path) !== path.resolve(dest))) throw new Error("plugin_version_path_exists")
      writeFileSync(path.join(extractReal, ".miki-plugin-runner.mjs"), RUNNER_SOURCE, { mode: 0o600 })

      if (installed) {
        const priorPath = path.resolve(installed.install_path)
        if (!priorPath.startsWith(`${path.resolve(root)}${path.sep}`) || !existsSync(priorPath)) throw new Error("plugin_path_invalid")
        backupPath = path.join(root, `.rollback-${manifest.id}-${randomUUID()}`)
        if (shouldRestartOld) await stopRuntime(manifest.id)
        renameSync(priorPath, backupPath)
        movedOld = true
      }
      renameSync(extractReal, dest)
      movedNew = true
      const at = now()
      const newGrants = unrestrictedGuestPlugins()
        ? [...manifest.permissions]
        : oldGrants.filter((permission) => manifest.permissions.includes(permission))
      const writeNewRow = db.transaction(() => {
        db.prepare("DELETE FROM plugin_installations WHERE id=?").run(manifest.id)
        db.prepare(`INSERT INTO plugin_installations(id,version,digest,source,install_path,enabled,lifecycle_state,runtime_status,manifest_json,permissions_json,grants_json,installed_at,updated_at,last_error_code)
          VALUES(?,?,?,?,?,0,'disabled','not_started',?,?,?,?,?,NULL)`)
          .run(manifest.id, manifest.version, digest, registryId ? "trusted_registry" : "local_archive", dest, JSON.stringify(manifest), JSON.stringify(manifest.permissions), JSON.stringify(newGrants), at, at)
      })
      writeNewRow()
      switchedDatabase = true

      // Preserve enabled state only when the updated package can start using the old, explicit grants.
      if (shouldRestartOld) {
        const nextRow = rowById(manifest.id) as InstalledRow
        try {
          const runtime = await startRuntime(nextRow, newGrants)
          if (!(await runtime.health()).ok) throw new Error("plugin_health_failed")
          db.prepare("UPDATE plugin_installations SET enabled=1,lifecycle_state='healthy',runtime_status='healthy',updated_at=?,last_error_code=NULL WHERE id=?").run(now(), manifest.id)
        } catch {
          await stopRuntime(manifest.id)
          db.prepare("DELETE FROM plugin_installations WHERE id=?").run(manifest.id)
          rmSync(dest, { recursive: true, force: true })
          movedNew = false
          if (movedOld && backupPath) {
            renameSync(backupPath, installed!.install_path)
            movedOld = false
          }
          const restore = db.transaction(() => {
            db.prepare(`INSERT INTO plugin_installations(id,version,digest,source,install_path,enabled,lifecycle_state,runtime_status,manifest_json,permissions_json,grants_json,installed_at,updated_at,last_error_code)
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
              installed!.id, installed!.version, installed!.digest, installed!.source, installed!.install_path,
              installed!.enabled, installed!.lifecycle_state, installed!.runtime_status, installed!.manifest_json,
              installed!.permissions_json, installed!.grants_json, installed!.installed_at, now(), installed!.last_error_code,
            )
          })
          restore()
          switchedDatabase = false
          try { await startRuntime(rowById(manifest.id) as InstalledRow, oldGrants) }
          catch {
            db.prepare("UPDATE plugin_installations SET enabled=0,lifecycle_state='failed',runtime_status='failed',last_error_code='rollback_restart_failed',updated_at=? WHERE id=?").run(now(), manifest.id)
          }
          audit(manifest.id, "upgrade", "rolled_back", "plugin_start_failed")
          return res.status(409).json({ error: "plugin_upgrade_rolled_back" })
        }
      }
      if (movedOld && backupPath) { rmSync(backupPath, { recursive: true, force: true }); movedOld = false }
      audit(manifest.id, installed ? "upgrade" : "install", "success")
      return res.status(installed ? 200 : 201).json({ plugin: publicRow(rowById(manifest.id) as InstalledRow) })
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_:-]{1,100}$/i.test(error.message) ? error.message : "package_install_failed"
      try {
        if (movedNew && dest) rmSync(dest, { recursive: true, force: true })
        if (movedOld && backupPath && oldRow && existsSync(backupPath)) renameSync(backupPath, oldRow.install_path)
        if (switchedDatabase && oldRow) {
          db.prepare("DELETE FROM plugin_installations WHERE id=?").run(oldRow.id)
          db.prepare(`INSERT INTO plugin_installations(id,version,digest,source,install_path,enabled,lifecycle_state,runtime_status,manifest_json,permissions_json,grants_json,installed_at,updated_at,last_error_code)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(oldRow.id, oldRow.version, oldRow.digest, oldRow.source, oldRow.install_path, oldRow.enabled, oldRow.lifecycle_state, oldRow.runtime_status, oldRow.manifest_json, oldRow.permissions_json, oldRow.grants_json, oldRow.installed_at, now(), oldRow.last_error_code)
        }
        if (shouldRestartOld && oldRow && !runtimes.has(oldRow.id) && rowById(oldRow.id)) {
          try { await startRuntime(rowById(oldRow.id) as InstalledRow, oldGrants) } catch { db.prepare("UPDATE plugin_installations SET enabled=0,lifecycle_state='failed',runtime_status='failed',last_error_code='rollback_restart_failed',updated_at=? WHERE id=?").run(now(), oldRow.id) }
        }
      } catch {
        // Keep the prior database row/package as intact as possible; rollback failures are audit-visible below.
        audit(installedId, "rollback", "failed", "plugin_rollback_failed")
      }
      audit(installedId, "install", "failed", code)
      return res.status(["plugin_dependency_missing", "plugin_dependency_cycle", "plugin_upgrade_requires_permission_review"].includes(code) ? 409 : 400).json({ error: code })
    } finally { rmSync(staging, { recursive: true, force: true }) }
  })

  router.patch("/:id", async (req, res) => {
    const id = typeof req.params.id === "string" ? req.params.id : ""
    if (builtinIds.has(id)) return res.status(409).json({ error: "builtin_plugin_immutable" })
    const row = rowById(id)
    if (!row) return res.status(404).json({ error: "plugin_not_found" })
    const enabled = req.body?.enabled
    const manifest = JSON.parse(row.manifest_json) as PluginManifest
    const suppliedGrants = req.body?.granted_permissions
    if (suppliedGrants !== undefined && (!Array.isArray(suppliedGrants) || suppliedGrants.some((permission: unknown) => typeof permission !== "string" || !PERMISSIONS.has(permission)))) {
      return res.status(400).json({ error: "plugin_permission_invalid" })
    }
    const grants = suppliedGrants === undefined
      ? unrestrictedGuestPlugins()
        ? [...new Set(manifest.permissions)]
        : JSON.parse(row.grants_json) as string[]
      : [...new Set(suppliedGrants as string[])]
    // A user may grant or revoke requested permissions, but the grants record
    // must never contain capabilities that the installed manifest did not ask for.
    const unrequestedGrants = grants.filter((permission) => !manifest.permissions.includes(permission))
    if (unrequestedGrants.length) {
      return res.status(400).json({ error: "plugin_permission_not_requested", permissions: unrequestedGrants })
    }
    if (enabled === false) {
      db.prepare("UPDATE plugin_installations SET enabled=0,lifecycle_state='stopping',updated_at=?,last_error_code=NULL WHERE id=?").run(now(), id)
      try { await stopRuntime(id) } catch {}
      db.prepare("UPDATE plugin_installations SET lifecycle_state='disabled',runtime_status='disabled',grants_json=?,updated_at=? WHERE id=?").run(JSON.stringify(grants), now(), id)
      audit(id, "disable", "success")
      return res.json({ plugin: publicRow(rowById(id) as InstalledRow) })
    }
    if (enabled !== true && req.body?.granted_permissions === undefined) return res.status(400).json({ error: "enabled_or_grants_required" })
    if (enabled === true) {
      const unsupported = manifest.permissions.filter((permission) => UNSUPPORTED_SANDBOX_PERMISSIONS.has(permission))
      if (!unrestrictedGuestPlugins() && unsupported.length) return res.status(409).json({ error: "permission_not_supported_by_sandbox", permissions: unsupported })
      const missing = manifest.permissions.filter((permission) => !grants.includes(permission))
      if (missing.length) return res.status(403).json({ error: "permission_grant_required", permissions: missing })
      if (!sandboxAvailable && !unrestrictedGuestPlugins()) return res.status(409).json({ error: "sandbox_unavailable" })
      db.prepare("UPDATE plugin_installations SET lifecycle_state='starting',updated_at=?,last_error_code=NULL WHERE id=?").run(now(), id)
      try {
        const handle = await startRuntime(row, grants)
        const health = await handle.health()
        if (!health.ok) throw new Error("plugin_health_failed")
        db.prepare("UPDATE plugin_installations SET enabled=1,lifecycle_state='healthy',runtime_status='healthy',grants_json=?,updated_at=?,last_error_code=NULL WHERE id=?").run(JSON.stringify(grants), now(), id)
        audit(id, "enable", "success")
      } catch (error) {
        await stopRuntime(id)
        const code = error instanceof Error && /^[a-z0-9_:-]{1,100}$/i.test(error.message) ? error.message : "plugin_start_failed"
        db.prepare("UPDATE plugin_installations SET enabled=0,lifecycle_state='failed',runtime_status='failed',updated_at=?,last_error_code=? WHERE id=?").run(now(), code, id)
        audit(id, "enable", "failed", code)
        return res.status(409).json({ error: code })
      }
    } else {
      db.prepare("UPDATE plugin_installations SET grants_json=?,updated_at=? WHERE id=?").run(JSON.stringify(grants), now(), id)
    }
    return res.json({ plugin: publicRow(rowById(id) as InstalledRow) })
  })

  router.post("/:id/health", async (req, res) => {
    const id = typeof req.params.id === "string" ? req.params.id : ""
    const row = rowById(id)
    if (!row) return res.status(404).json({ error: "plugin_not_found" })
    const runtime = runtimes.get(id)
    if (!runtime) return res.json({ ok: false, source: "not_checked", status: row.runtime_status, checked_at: now(), error: row.last_error_code ?? "runtime_not_running" })
    try {
      const health = await runtime.health()
      db.prepare("UPDATE plugin_installations SET runtime_status=?,lifecycle_state=?,updated_at=?,last_error_code=? WHERE id=?").run(health.ok ? "healthy" : "failed", health.ok ? "healthy" : "failed", now(), health.ok ? null : "plugin_health_failed", id)
      audit(id, "health", health.ok ? "success" : "failed", health.ok ? undefined : "plugin_health_failed")
      return res.json({ ...health, source: "live_probe", checked_at: now() })
    } catch {
      db.prepare("UPDATE plugin_installations SET runtime_status='failed',lifecycle_state='failed',updated_at=?,last_error_code='plugin_health_failed' WHERE id=?").run(now(), id)
      return res.status(502).json({ error: "plugin_health_failed", source: "live_probe", checked_at: now() })
    }
  })

  router.delete("/:id", async (req, res) => {
    const id = typeof req.params.id === "string" ? req.params.id : ""
    if (builtinIds.has(id)) return res.status(409).json({ error: "builtin_plugin_immutable" })
    if (!unrestrictedGuestPlugins() && req.header("x-confirm-plugin-uninstall") !== id) return res.status(428).json({ error: "plugin_uninstall_confirmation_required" })
    try {
      // Keep the HTTP and agent uninstall paths on the same staged, rollback-safe lifecycle.
      return res.json(await uninstallPlugin(id))
    } catch (error) {
      const code = error instanceof Error ? error.message : "plugin_uninstall_failed"
      const status = code === "plugin_not_found" ? 404
        : code === "builtin_plugin_immutable" || code === "plugin_path_invalid" || code.startsWith("plugin_has_dependents:") ? 409
          : 500
      return res.status(status).json({ error: code })
    }
  })

  options.registerShutdownHandler?.(async () => { for (const id of [...runtimes.keys()]) await stopRuntime(id) })
  const startEnabledPlugins = async () => {
    for (const row of listRows()) {
      if (row.enabled !== 1) continue
      const manifest = JSON.parse(row.manifest_json) as PluginManifest
      const grants = unrestrictedGuestPlugins() ? [...manifest.permissions] : JSON.parse(row.grants_json) as string[]
      if (unrestrictedGuestPlugins() && JSON.stringify(grants) !== row.grants_json) {
        db.prepare("UPDATE plugin_installations SET grants_json=?,updated_at=? WHERE id=?").run(JSON.stringify(grants), now(), row.id)
      }
      try {
        await startRuntime(row, grants)
        db.prepare("UPDATE plugin_installations SET lifecycle_state='healthy',runtime_status='healthy',updated_at=?,last_error_code=NULL WHERE id=?").run(now(), row.id)
      } catch (error) {
        const code = error instanceof Error && /^[a-z0-9_:-]{1,100}$/i.test(error.message) ? error.message : "plugin_start_failed"
        db.prepare("UPDATE plugin_installations SET enabled=0,lifecycle_state='failed',runtime_status='failed',updated_at=?,last_error_code=? WHERE id=?").run(now(), code, row.id)
        audit(row.id, "startup", "failed", code)
      }
    }
  }
  return { router, startEnabledPlugins, sandboxAvailable, listAgentPlugins, listInstalledPlugins, listTrustedPluginPackages, installTrustedPluginPackage, setPluginEnabled, uninstallPlugin, describeAgentPlugin, invokeAgentPlugin }
}
