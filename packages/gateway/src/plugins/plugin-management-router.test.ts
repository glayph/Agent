import { execFileSync } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import express from "express"
import Database from "better-sqlite3"
import { afterEach, describe, expect, it } from "vitest"
import { createPluginManagementRouter } from "./plugin-management-router.js"

const temporary: string[] = []
function fixtureArchive(manifest: Record<string, unknown>, entry = "export function createPlugin(){ return { start(){}, stop(){}, health(){ return { ok: true, status: 'ready' } } } }") {
  const root = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-test-"))
  temporary.push(root)
  writeFileSync(path.join(root, "miki-plugin.json"), JSON.stringify(manifest))
  writeFileSync(path.join(root, "index.mjs"), entry)
  const archive = path.join(root, "package.zip")
  execFileSync("zip", ["-q", archive, "miki-plugin.json", "index.mjs"], { cwd: root })
  const bytes = readFileSync(archive)
  return { archiveBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") }
}

async function appFor(dataRoot: string, allowUnrestrictedGuestPlugins = false) {
  const db = new Database(":memory:")
  const app = express()
  app.use(express.json({ limit: "12mb" }))
  const manager = createPluginManagementRouter({ db, dataRoot, configDir: dataRoot, requireAuth: (_req, _res, next) => next(), now: () => new Date().toISOString(), builtinIds: new Set(["tools.core-registry"]), allowUnrestrictedGuestPlugins: () => allowUnrestrictedGuestPlugins })
  app.use("/api/plugins", manager.router)
  const server = app.listen(0, "127.0.0.1")
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject) })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test server did not bind")
  return { db, app, manager, server, base: `http://127.0.0.1:${address.port}/api/plugins` }
}
const manifest = (id = "test.echo", permissions: string[] = [], dependencies: string[] = [], version = "1.0.0") => ({ id, displayName: "Test Echo", version, apiVersion: "1.0", entrypoint: "index.mjs", capabilities: ["tool"], permissions, ...(dependencies.length ? { dependencies } : {}), platform: ["linux", "any"] })

afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe("external plugin lifecycle API", () => {
  it("reports the exact unavailable state when no trusted plugin registry is configured", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-no-registry-")); temporary.push(dataRoot)
    const { db, server, manager } = await appFor(dataRoot)
    try {
      expect(manager.listTrustedPluginPackages()).toMatchObject({ configured: false, packages: [], unavailable_reason: "registry_not_configured", warnings: [expect.stringContaining("No trusted plugin registry")] })
      expect(manager.listInstalledPlugins()).toEqual([])
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  })

  it("installs from the trusted registry through the agent management API but leaves code disabled", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-agent-install-")); temporary.push(dataRoot)
    const registryDir = path.join(dataRoot, "plugins")
    const packageDir = path.join(registryDir, "packages")
    mkdirSync(packageDir, { recursive: true })
    const archive = fixtureArchive(manifest("trusted.agent"))
    const bytes = Buffer.from(archive.archiveBase64, "base64")
    const keyPair = generateKeyPairSync("ed25519")
    writeFileSync(path.join(registryDir, "trusted-public-key.pem"), keyPair.publicKey.export({ type: "spki", format: "pem" }))
    writeFileSync(path.join(packageDir, "trusted.agent.zip"), bytes)
    writeFileSync(path.join(registryDir, "registry.json"), JSON.stringify({ packages: [{
      id: "trusted.agent", manifest: manifest("trusted.agent"), archive: "packages/trusted.agent.zip",
      sha256: createHash("sha256").update(bytes).digest("hex"), signature: sign(null, bytes, keyPair.privateKey).toString("base64"),
    }] }))
    const { db, server, manager } = await appFor(dataRoot)
    try {
      const installed = await manager.installTrustedPluginPackage("trusted.agent") as { id: string; enabled: boolean }
      expect(installed).toMatchObject({ id: "trusted.agent", enabled: false })
      const inventory = manager.listInstalledPlugins()
      expect(inventory).toHaveLength(1)
      expect(inventory[0]).toMatchObject({ id: "trusted.agent", available_to_invoke: false, blocked_reason: expect.any(String) })
      await expect(manager.installTrustedPluginPackage("trusted.agent")).rejects.toThrow("plugin_already_installed")
      await expect(manager.uninstallPlugin("trusted.agent")).resolves.toMatchObject({ removed: true, id: "trusted.agent" })
      expect((db.prepare("SELECT COUNT(*) AS n FROM plugin_installations").get() as { n: number }).n).toBe(0)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  }, 20_000)


  it("explains why an invalid signature causes a trusted plugin package to be hidden", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-invalid-signature-")); temporary.push(dataRoot)
    const registryDir = path.join(dataRoot, "plugins")
    const packageDir = path.join(registryDir, "packages")
    mkdirSync(packageDir, { recursive: true })
    const archive = fixtureArchive(manifest("trusted.bad-signature"))
    const bytes = Buffer.from(archive.archiveBase64, "base64")
    const keyPair = generateKeyPairSync("ed25519")
    writeFileSync(path.join(registryDir, "trusted-public-key.pem"), keyPair.publicKey.export({ type: "spki", format: "pem" }))
    writeFileSync(path.join(packageDir, "trusted.bad-signature.zip"), bytes)
    writeFileSync(path.join(registryDir, "registry.json"), JSON.stringify({ packages: [{
      id: "trusted.bad-signature", manifest: manifest("trusted.bad-signature"), archive: "packages/trusted.bad-signature.zip",
      sha256: createHash("sha256").update(bytes).digest("hex"), signature: Buffer.alloc(64, 7).toString("base64"),
    }] }))
    const { db, server, manager } = await appFor(dataRoot)
    try {
      const marketplace = manager.listTrustedPluginPackages() as { packages: unknown[]; warnings: string[] }
      expect(marketplace.packages).toHaveLength(0)
      expect(marketplace.warnings.join(" ")).toMatch(/signature verification failed/i)
      await expect(manager.installTrustedPluginPackage("trusted.bad-signature")).rejects.toThrow(/signature verification failed/i)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  })

  it("restores the package directory when the uninstall registry mutation fails", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-uninstall-rollback-")); temporary.push(dataRoot)
    const { db, server, base, manager } = await appFor(dataRoot)
    try {
      const archive = fixtureArchive(manifest("test.rollback"))
      await expect(fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: archive.archiveBase64, sha256: archive.sha256 }) })).resolves.toMatchObject({ status: 201 })
      const row = db.prepare("SELECT install_path FROM plugin_installations WHERE id=?").get("test.rollback") as { install_path: string }
      const packageRoot = row.install_path
      db.exec("CREATE TRIGGER block_plugin_delete BEFORE DELETE ON plugin_installations BEGIN SELECT RAISE(ABORT, 'delete_blocked'); END;")
      const response = await fetch(`${base}/test.rollback`, { method: "DELETE", headers: { "x-confirm-plugin-uninstall": "test.rollback" } })
      expect(response.status).toBe(500)
      expect(await response.json()).toMatchObject({ error: expect.stringMatching(/delete_blocked/i) })
      expect(db.prepare("SELECT COUNT(*) AS n FROM plugin_installations WHERE id=?").get("test.rollback")).toMatchObject({ n: 1 })
      expect(existsSync(packageRoot)).toBe(true)
      expect(manager.listInstalledPlugins()[0]).toMatchObject({ id: "test.rollback", enabled: false })
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  })

  it("exposes an optional method catalogue through the plugin runtime describe protocol", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-describe-")); temporary.push(dataRoot)
    const { db, server, base, manager } = await appFor(dataRoot, true)
    try {
      const entry = `export function createPlugin(){ return { start(){}, stop(){}, health(){ return { ok: true, status: 'ready' } }, describe(){ return { methods: [{ name: 'lookup', description: 'Read a record by identifier.', risk: 'read', parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }] } }, handle(method, payload){ if(method === 'large') return { data: 'x'.repeat(70000) }; if(method !== 'lookup') throw new Error('unknown_method'); return { id: payload.id } } } }`
      const archive = fixtureArchive(manifest("test.describe"), entry)
      const installed = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: archive.archiveBase64, sha256: archive.sha256 }) })
      expect(installed.status).toBe(201)
      const enabled = await fetch(`${base}/test.describe`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, granted_permissions: [] }) })
      expect(enabled.status).toBe(200)
      await expect(manager.describeAgentPlugin("test.describe")).resolves.toMatchObject({
        plugin_id: "test.describe", available: true,
        description: { methods: [expect.objectContaining({ name: "lookup", risk: "read" })] },
      })
      await expect(manager.invokeAgentPlugin("test.describe", "tool.lookup", { id: "abc" })).resolves.toMatchObject({ result: { id: "abc" } })
      await expect(manager.invokeAgentPlugin("test.describe", "tool.large", {})).resolves.toMatchObject({ result: { data: "x".repeat(70_000) } })
      db.prepare("UPDATE plugin_installations SET lifecycle_state='failed',runtime_status='failed' WHERE id=?").run("test.describe")
      await expect(manager.invokeAgentPlugin("test.describe", "tool.lookup", { id: "abc" })).rejects.toThrow("plugin_not_enabled_or_healthy")
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  })

  it("installs a valid package without relying on system unzip or zipinfo commands", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-no-zip-cli-")); temporary.push(dataRoot)
    const archive = fixtureArchive(manifest("test.no-zip-cli"))
    const previousPath = process.env.PATH
    const emptyPath = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-empty-path-")); temporary.push(emptyPath)
    process.env.PATH = emptyPath
    const { db, server, base } = await appFor(dataRoot, true)
    try {
      const response = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: archive.archiveBase64, sha256: archive.sha256 }) })
      expect(response.status, await response.clone().text()).toBe(201)
      expect((await response.json() as { plugin: { id: string } }).plugin.id).toBe("test.no-zip-cli")
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      await new Promise<void>((resolve) => server.close(() => resolve()))
      db.close()
    }
  })

  it("installs a checksummed local archive, enables it in a network-isolated runtime, checks health, disables and uninstalls", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-data-")); temporary.push(dataRoot); mkdirSync(dataRoot, { recursive: true })
    const { db, server, base } = await appFor(dataRoot)
    try {
      const archive = fixtureArchive(manifest())
      const installed = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: archive.archiveBase64, sha256: archive.sha256 }) })
      expect(installed.status, await installed.clone().text()).toBe(201)
      expect((await installed.json() as { plugin: { id: string; enabled: boolean } }).plugin).toMatchObject({ id: "test.echo", enabled: false })
      const enabled = await fetch(`${base}/test.echo`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, granted_permissions: [] }) })
      expect(enabled.status, await enabled.clone().text()).toBe(200)
      expect((await enabled.json() as { plugin: { enabled: boolean; runtime_status: string; lifecycle_state: string } }).plugin).toMatchObject({ enabled: true, runtime_status: "healthy", lifecycle_state: "healthy" })
      const health = await fetch(`${base}/test.echo/health`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      expect(health.status).toBe(200)
      expect(await health.json()).toMatchObject({ ok: true, status: "ready", source: "live_probe" })
      const disabled = await fetch(`${base}/test.echo`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false, granted_permissions: [] }) })
      expect((await disabled.json() as { plugin: { enabled: boolean; runtime_status: string } }).plugin).toMatchObject({ enabled: false, runtime_status: "disabled" })
      const removed = await fetch(`${base}/test.echo`, { method: "DELETE", headers: { "x-confirm-plugin-uninstall": "test.echo" } })
      expect(removed.status).toBe(200)
      expect((await removed.json() as { removed: boolean }).removed).toBe(true)
      expect((db.prepare("SELECT COUNT(*) AS n FROM plugin_installations").get() as { n: number }).n).toBe(0)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  }, 20_000)

  it("rejects bad checksums, immutable built-ins, missing permission grants, and unsupported privileged permissions", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-data-")); temporary.push(dataRoot)
    const { db, server, base } = await appFor(dataRoot)
    try {
      const bad = fixtureArchive(manifest())
      const checksum = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: bad.archiveBase64, sha256: "0".repeat(64) }) })
      expect(checksum.status).toBe(400)
      expect(await checksum.json()).toMatchObject({ error: "package_checksum_mismatch" })

      const builtin = fixtureArchive(manifest("tools.core-registry"))
      const builtinResponse = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: builtin.archiveBase64, sha256: builtin.sha256 }) })
      expect(builtinResponse.status).toBe(400)
      expect(await builtinResponse.json()).toMatchObject({ error: "builtin_plugin_immutable" })

      const privileged = fixtureArchive(manifest("test.network", ["network"]))
      const installed = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: privileged.archiveBase64, sha256: privileged.sha256 }) })
      expect(installed.status, await installed.clone().text()).toBe(201)
      const denied = await fetch(`${base}/test.network`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, granted_permissions: ["network"] }) })
      expect(denied.status).toBe(409)
      expect(await denied.json()).toMatchObject({ error: "permission_not_supported_by_sandbox" })

      const fsPermission = fixtureArchive(manifest("test.fs", ["filesystem-write"]))
      const fsInstalled = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: fsPermission.archiveBase64, sha256: fsPermission.sha256 }) })
      expect(fsInstalled.status).toBe(201)
      const noGrant = await fetch(`${base}/test.fs`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, granted_permissions: [] }) })
      expect(noGrant.status).toBe(403)
      expect(await noGrant.json()).toMatchObject({ error: "permission_grant_required" })
      const invalidGrant = await fetch(`${base}/test.fs`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ granted_permissions: ["unknown-capability"] }) })
      expect(invalidGrant.status).toBe(400)
      expect(await invalidGrant.json()).toMatchObject({ error: "plugin_permission_invalid" })
      const unrequestedGrant = await fetch(`${base}/test.fs`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ granted_permissions: ["filesystem-write", "browser"] }) })
      expect(unrequestedGrant.status).toBe(400)
      expect(await unrequestedGrant.json()).toMatchObject({ error: "plugin_permission_not_requested", permissions: ["browser"] })
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  }, 20_000)



  it("runs plugins with all declared permissions and no extra confirmation inside the isolated guest mode", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-auto-grant-data-")); temporary.push(dataRoot)
    const { db, server, base, manager } = await appFor(dataRoot, true)
    try {
      const pluginEntry = "export function createPlugin(){ return { start(){}, handle(method, payload){ return { method, payload, invoked: true } } } }"
      const archive = fixtureArchive(manifest("test.fs-auto", ["filesystem-write", "network", "shell", "secrets"]), pluginEntry)
      const installed = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: archive.archiveBase64, sha256: archive.sha256 }) })
      expect(installed.status).toBe(201)
      const enabled = await fetch(`${base}/test.fs-auto`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true }) })
      expect(enabled.status, await enabled.clone().text()).toBe(200)
      expect((await enabled.json() as { plugin: { enabled: boolean; granted_permissions: string[]; execution_mode: string } }).plugin).toMatchObject({ enabled: true, granted_permissions: ["filesystem-write", "network", "shell", "secrets"], execution_mode: "guest_unrestricted" })
      const installedList = await fetch(`${base}/installed`)
      expect(await installedList.json()).toMatchObject({ execution_mode: "guest_unrestricted", sandbox_supported: false })
      await expect(manager.invokeAgentPlugin("test.fs-auto", "browser.navigate", { url: "http://127.0.0.1/" })).resolves.toEqual({
        plugin: "test.fs-auto", method: "browser.navigate", result: { method: "browser.navigate", payload: { url: "http://127.0.0.1/" }, invoked: true },
      })
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  }, 20_000)

  it("exposes enabled sandboxed plugins to the autonomous agent and audits invocations", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-agent-data-")); temporary.push(dataRoot)
    const { db, server, base, manager } = await appFor(dataRoot)
    try {
      if (!manager.sandboxAvailable) return
      const entry = "export function createPlugin(){ return { start(){}, handle(method, payload){ return { method, payload, invoked: true } } } }"
      const archive = fixtureArchive({ ...manifest("test.agent", [], [], "1.0.0"), monitorIconKey: "gmail" }, entry)
      const installed = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: archive.archiveBase64, sha256: archive.sha256 }) })
      expect(installed.status).toBe(201)
      const enabled = await fetch(`${base}/test.agent`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: true, granted_permissions: [] }) })
      expect(enabled.status).toBe(200)
      const catalog = manager.listAgentPlugins()
      expect(catalog).toEqual([expect.objectContaining({ id: "test.agent", capabilities: ["tool"], monitorIconKey: "gmail" })])
      await expect(manager.invokeAgentPlugin("test.agent", "tool.echo", { value: "hello" })).resolves.toEqual({
        plugin: "test.agent", method: "tool.echo", result: { method: "tool.echo", payload: { value: "hello" }, invoked: true },
      })
      await expect(manager.invokeAgentPlugin("test.agent", "browser.navigate", {})).rejects.toThrow("plugin_capability_not_declared")
      expect((db.prepare("SELECT COUNT(*) AS n FROM plugin_audit WHERE plugin_id='test.agent' AND event='agent_invoke' AND status='success'").get() as { n: number }).n).toBe(1)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  }, 20_000)



  it("accepts only bundled local Monitoring icon keys in plugin manifests", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-monitor-icons-")); temporary.push(dataRoot)
    const { db, server, base } = await appFor(dataRoot)
    try {
      const invalid = fixtureArchive({ ...manifest("test.bad-icon"), monitorIconKey: "https://example.invalid/icon.svg" })
      const rejected = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: invalid.archiveBase64, sha256: invalid.sha256 }) })
      expect(rejected.status).toBe(400)
      expect(await rejected.json()).toMatchObject({ error: "manifest_monitor_icon_invalid" })

      const valid = fixtureArchive({ ...manifest("test.good-icon"), monitorIconKey: "github" })
      const accepted = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: valid.archiveBase64, sha256: valid.sha256 }) })
      expect(accepted.status).toBe(201)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  })

  it("lists and installs only registry packages with a valid Ed25519 signature", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-data-")); temporary.push(dataRoot)
    const registryDir = path.join(dataRoot, "plugins")
    const packageDir = path.join(registryDir, "packages")
    mkdirSync(packageDir, { recursive: true })
    const archive = fixtureArchive(manifest("trusted.echo"))
    const bytes = Buffer.from(archive.archiveBase64, "base64")
    const keyPair = generateKeyPairSync("ed25519")
    writeFileSync(path.join(registryDir, "trusted-public-key.pem"), keyPair.publicKey.export({ type: "spki", format: "pem" }))
    writeFileSync(path.join(packageDir, "trusted.echo.zip"), bytes)
    writeFileSync(path.join(registryDir, "registry.json"), JSON.stringify({ packages: [{
      id: "trusted.echo", manifest: manifest("trusted.echo"), archive: "packages/trusted.echo.zip",
      sha256: createHash("sha256").update(bytes).digest("hex"), signature: sign(null, bytes, keyPair.privateKey).toString("base64"),
    }] }))
    const { db, server, base } = await appFor(dataRoot)
    try {
      const marketplace = await fetch(`${base}/marketplace`)
      expect(marketplace.status).toBe(200)
      expect(await marketplace.json()).toMatchObject({ packages: [{ id: "trusted.echo", trusted: true, installed: false }], total: 1 })
      const installed = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registry_id: "trusted.echo" }) })
      expect(installed.status, await installed.clone().text()).toBe(201)
      expect((await installed.json() as { plugin: { id: string; source: string } }).plugin).toMatchObject({ id: "trusted.echo", source: "trusted_registry" })
      expect((db.prepare("SELECT digest FROM plugin_installations WHERE id='trusted.echo'").get() as { digest: string }).digest).toBe(archive.sha256)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  }, 20_000)

  it("excludes packages with invalid registry signatures and refuses to install them", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-data-")); temporary.push(dataRoot)
    const registryDir = path.join(dataRoot, "plugins")
    const packageDir = path.join(registryDir, "packages")
    mkdirSync(packageDir, { recursive: true })
    const archive = fixtureArchive(manifest("tampered.echo"))
    const bytes = Buffer.from(archive.archiveBase64, "base64")
    const keyPair = generateKeyPairSync("ed25519")
    writeFileSync(path.join(registryDir, "trusted-public-key.pem"), keyPair.publicKey.export({ type: "spki", format: "pem" }))
    writeFileSync(path.join(packageDir, "tampered.echo.zip"), bytes)
    writeFileSync(path.join(registryDir, "registry.json"), JSON.stringify({ packages: [{
      id: "tampered.echo", manifest: manifest("tampered.echo"), archive: "packages/tampered.echo.zip",
      sha256: createHash("sha256").update(bytes).digest("hex"), signature: Buffer.alloc(64).toString("base64"),
    }] }))
    const { db, server, base } = await appFor(dataRoot)
    try {
      expect(await (await fetch(`${base}/marketplace`)).json()).toMatchObject({ packages: [], total: 0 })
      const response = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ registry_id: "tampered.echo" }) })
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ error: "trusted_plugin_package_not_found" })
      expect((db.prepare("SELECT COUNT(*) AS n FROM plugin_installations").get() as { n: number }).n).toBe(0)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  }, 20_000)

  it("rejects dependency cycles during an otherwise valid plugin upgrade", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-data-")); temporary.push(dataRoot)
    const { db, server, base } = await appFor(dataRoot)
    const install = async (packageManifest: Record<string, unknown>) => {
      const archive = fixtureArchive(packageManifest)
      return fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: archive.archiveBase64, sha256: archive.sha256 }) })
    }
    try {
      expect((await install(manifest("test.alpha"))).status).toBe(201)
      expect((await install(manifest("test.beta", [], ["test.alpha"]))).status).toBe(201)
      const cycle = await install(manifest("test.alpha", [], ["test.beta"], "2.0.0"))
      expect(cycle.status).toBe(409)
      expect(await cycle.json()).toMatchObject({ error: "plugin_dependency_cycle" })
      expect((db.prepare("SELECT version FROM plugin_installations WHERE id='test.alpha'").get() as { version: string }).version).toBe("1.0.0")
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  }, 20_000)

  it("rejects traversal and symlink archives without installing files", async () => {
    const dataRoot = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-data-")); temporary.push(dataRoot)
    const { db, server, base } = await appFor(dataRoot)
    const root = mkdtempSync(path.join(os.tmpdir(), "miki-plugin-hostile-")); temporary.push(root)
    try {
      writeFileSync(path.join(root, "miki-plugin.json"), JSON.stringify(manifest()))
      writeFileSync(path.join(root, "index.mjs"), "export default {}")
      const outside = path.join(root, "outside.txt"); writeFileSync(outside, "no")
      const archivePath = path.join(root, "bad.zip")
      execFileSync("zip", ["-q", archivePath, "miki-plugin.json", "index.mjs"], { cwd: root })
      const goodBytes = readFileSync(archivePath)
      // A checksum-valid archive containing a traversal entry must be rejected before extraction.
      const evilPath = path.join(root, "evil.zip")
      // Construct a ZIP member with traversal using zip's stdin path mode.
      execFileSync("bash", ["-lc", `printf 'no' | zip -q '${evilPath}' -`], { cwd: root })
      execFileSync("zipnote", ["-w", evilPath], { input: "@ -\n@=../outside.txt\n" })
      const evilBytes = readFileSync(evilPath)
      const response = await fetch(`${base}/install`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archive_base64: evilBytes.toString("base64"), sha256: createHash("sha256").update(evilBytes).digest("hex") }) })
      expect(response.status).toBe(400)
      expect((await response.json() as { error: string }).error).toMatch(/paths_invalid|package_install_failed/)
      expect(goodBytes.length).toBeLessThan(evilBytes.length + 100_000)
      expect((db.prepare("SELECT COUNT(*) AS n FROM plugin_installations").get() as { n: number }).n).toBe(0)
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  }, 20_000)
})
