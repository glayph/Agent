import { execFileSync } from "node:child_process"
import { createHash, generateKeyPairSync, sign } from "node:crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
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

async function appFor(dataRoot: string) {
  const db = new Database(":memory:")
  const app = express()
  app.use(express.json({ limit: "12mb" }))
  const manager = createPluginManagementRouter({ db, dataRoot, configDir: dataRoot, requireAuth: (_req, _res, next) => next(), now: () => new Date().toISOString(), builtinIds: new Set(["tools.core-registry"]) })
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
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); db.close() }
  }, 20_000)


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
