#!/usr/bin/env node
/**
 * Authenticated Playwright smoke for an explicitly supplied staging Gateway,
 * or a disposable locally supervised Gateway (`--autostart`).
 * Credentials are never printed or written to artifacts.
 */
import { chromium } from "playwright"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const autostart = process.argv.includes("--autostart") || process.env.MIKI_E2E_AUTOSTART === "true"
const suppliedBase = String(process.env.MIKI_E2E_BASE_URL || "").replace(/\/$/, "")
const password = process.env.MIKI_E2E_PASSWORD || (autostart ? randomBytes(32).toString("base64url") : "")
const results = []
const record = (name, ok, detail = "") => {
  const skipped = detail.startsWith("SKIPPED")
  results.push({ name, ok, skipped, detail })
  process.stdout.write(`${skipped ? "SKIP" : ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}\n`)
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("test_port_unavailable")
  const port = address.port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function startIsolatedGateway() {
  const projectRoot = process.cwd()
  const entry = path.join(projectRoot, "packages/gateway/dist/index.js")
  const dashboard = path.join(projectRoot, "packages/ui/frontend/dist/index.html")
  if (!existsSync(entry) || !existsSync(dashboard)) throw new Error("build_gateway_and_frontend_before_local_e2e")

  const root = mkdtempSync(path.join(os.tmpdir(), "miki-live-e2e-"))
  const dataDir = path.join(root, "data")
  const workspaceDir = path.join(root, "workspace")
  const configDir = path.join(root, "config")
  for (const dir of [dataDir, workspaceDir, configDir]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  const restartFile = path.join(root, "gateway.restart")
  const port = await reservePort()
  const base = `http://127.0.0.1:${port}`
  // Do not inherit provider, channel, cloud, or desktop credentials from the host shell.
  const env = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: root,
    TMPDIR: root,
    LANG: process.env.LANG || "C.UTF-8",
    NODE_ENV: "production",
    GATEWAY_HOST: "127.0.0.1",
    GATEWAY_PORT: String(port),
    MIKI_DATA_DIR: dataDir,
    MIKI_WORKSPACE_DIR: workspaceDir,
    MIKI_CONFIG_DIR: configDir,
    MIKI_GATEWAY_RESTART_FILE: restartFile,
    MIKI_MONITOR_RETENTION_DAYS: "30",
    MIKI_MONITOR_MAX_RUNS_PER_SESSION: "20",
  }

  let stopping = false
  let activeChild
  let supervisorError
  let restartCount = 0
  const supervisor = (async () => {
    while (!stopping) {
      try { unlinkSync(restartFile) } catch {}
      const child = spawn(process.execPath, [entry], { cwd: projectRoot, env, stdio: "ignore", windowsHide: true })
      activeChild = child
      const exit = await new Promise((resolve) => {
        child.once("error", () => resolve({ code: -1, signal: null }))
        child.once("exit", (code, signal) => resolve({ code: code ?? -1, signal }))
      })
      if (stopping) break
      if (existsSync(restartFile)) {
        restartCount += 1
        continue
      }
      supervisorError = new Error(`gateway_unexpected_exit_${exit.code}`)
      break
    }
  })()

  const deadline = Date.now() + 60_000
  let ready = false
  while (Date.now() < deadline && !stopping) {
    if (supervisorError) throw supervisorError
    try {
      const response = await fetch(`${base}/api/auth/status`, { signal: AbortSignal.timeout(2_000) })
      if (response.ok) { ready = true; break }
    } catch { /* Gateway has not bound its local port yet. */ }
    await wait(250)
  }
  if (!ready) {
    stopping = true
    activeChild?.kill("SIGTERM")
    await supervisor.catch(() => {})
    rmSync(root, { recursive: true, force: true })
    throw new Error("isolated_gateway_start_timeout")
  }

  return {
    base,
    root,
    get restartCount() { return restartCount },
    async stop() {
      stopping = true
      try { unlinkSync(restartFile) } catch {}
      if (activeChild && activeChild.exitCode === null) activeChild.kill("SIGTERM")
      await Promise.race([supervisor.catch(() => {}), wait(5_000)])
      if (activeChild && activeChild.exitCode === null) activeChild.kill("SIGKILL")
      rmSync(root, { recursive: true, force: true })
    },
  }
}

async function startMockProvider() {
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "not_found" } }))
      return
    }
    let body = ""
    for await (const chunk of request) body += chunk.toString("utf8")
    if (body.length > 64 * 1024) {
      response.writeHead(413).end()
      return
    }
    if (request.headers.authorization !== "Bearer miki-e2e-mock-key") {
      response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "mock_auth_rejected" } }))
      return
    }
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
      id: "chatcmpl-miki-e2e",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
    }))
  })
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("mock_provider_port_unavailable")
  return { base: `http://127.0.0.1:${address.port}/v1`, close: () => new Promise((resolve) => server.close(resolve)) }
}

let isolatedGateway
let mockProvider
let browser
try {
  if (!password) throw new Error("Set MIKI_E2E_PASSWORD, or use --autostart for a disposable isolated Gateway.")
  if (autostart && suppliedBase) throw new Error("Do not combine --autostart with MIKI_E2E_BASE_URL.")
  if (!autostart && (!suppliedBase || !/^https?:\/\//i.test(suppliedBase))) {
    throw new Error("Set MIKI_E2E_BASE_URL and MIKI_E2E_PASSWORD, or use `npm run test:e2e:local`.")
  }

  if (autostart) {
    isolatedGateway = await startIsolatedGateway()
    mockProvider = await startMockProvider()
    record("isolated-gateway-startup", true, "fresh temporary data/workspace/config roots")
  }
  const base = autostart ? isolatedGateway.base : suppliedBase
  const origin = new URL(base).origin

  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] })
  const context = await browser.newContext({ ignoreHTTPSErrors: process.env.MIKI_E2E_IGNORE_TLS === "true" })
  const page = await context.newPage()
  page.setDefaultTimeout(15_000)
  let pageErrors = 0
  page.on("pageerror", () => { pageErrors += 1 })

  const response = await page.goto(base, { waitUntil: "domcontentloaded" })
  record("dashboard-serves", Boolean(response?.ok()), response ? `HTTP ${response.status()}` : "no response")

  const initialAuthResponse = await context.request.get(new URL("/api/auth/status", base).href)
  const initialAuth = { status: initialAuthResponse.status(), body: await initialAuthResponse.json().catch(() => ({})) }
  if (initialAuth.status !== 200) throw new Error("auth_status_unavailable")
  if (initialAuth.body?.initialized === false) {
    const setupResponse = await context.request.post(new URL("/api/auth/setup", base).href, { data: { password, confirm: password } })
    const setup = { status: setupResponse.status(), body: await setupResponse.json().catch(() => ({})) }
    record("first-run-auth-setup", setup.status === 200 && setup.body?.ok === true, `HTTP ${setup.status}`)
    if (setup.status !== 200) throw new Error("authenticated_setup_failed")
  }

  const loginResponse = await context.request.post(new URL("/api/auth/login", base).href, { data: { password } })
  const login = { status: loginResponse.status(), body: await loginResponse.json().catch(() => ({})) }
  record("authenticated-login", login.status === 200 && login.body?.ok === true, `HTTP ${login.status}`)
  if (login.status !== 200) throw new Error("authenticated_login_failed")

  // Reload the UI after auth bootstrap so the SPA observes the shared session cookie.
  await page.goto(base, { waitUntil: "domcontentloaded" })
  const statusResponse = await context.request.get(new URL("/api/auth/status", base).href)
  const status = { status: statusResponse.status(), body: await statusResponse.json().catch(() => ({})) }
  record("auth-session-status", status.status === 200 && status.body?.authenticated === true, `HTTP ${status.status}`)

  const unauthContext = await browser.newContext()
  const unauthPage = await unauthContext.newPage()
  await unauthPage.goto(base, { waitUntil: "domcontentloaded" })
  const unauthorized = (await unauthContext.request.get(new URL("/api/plugins/installed", base).href)).status()
  record("protected-api-rejects-anonymous-session", unauthorized === 401, `HTTP ${unauthorized}`)
  await unauthContext.close()

  const protectedChecks = [
    ["monitor-history-api", "/api/monitor/history?limit=1"],
    ["installed-plugins-api", "/api/plugins/installed"],
    ["trusted-plugin-marketplace-api", "/api/plugins/marketplace"],
    ["gateway-status-api", "/api/gateway/status"],
  ]
  for (const [name, url] of protectedChecks) {
    const check = await page.evaluate(async (path) => { const r = await fetch(path); return { status: r.status } }, url)
    record(name, check.status === 200, `HTTP ${check.status}`)
  }

  const monitorSeed = await page.evaluate(async () => {
    const sessionId = "miki-e2e-history-session"
    const now = Date.now()
    const runs = {}
    const nodes = []
    for (let index = 0; index < 11; index++) {
      const id = `miki-e2e-history-${String(index).padStart(2, "0")}`
      const startedAt = now - index * 1_000
      runs[id] = { id, status: "completed", startedAt, endedAt: startedAt + 10 }
      nodes.push({ id: `${id}-node`, runId: id, type: "tool", label: "e2e_monitor_history", status: "completed", level: 0, parallel: false, createdAt: startedAt })
    }
    const imported = await fetch("/api/monitor/history/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ import_id: "miki-e2e-history-import", session_id: sessionId, history: { runs, nodes, edges: [] } }) })
    const importBody = await imported.json().catch(() => ({}))
    const firstResponse = await fetch(`/api/monitor/history?limit=10&session_id=${sessionId}`)
    const first = await firstResponse.json().catch(() => ({}))
    const cursor = first?.next_before
    if (!cursor) return { ok: false, reason: "first_page_cursor_missing", status: imported.status, count: importBody.count }
    const next = new URLSearchParams({ before_seq: String(cursor.seq), before_started_at: cursor.started_at, before_run_id: cursor.run_id })
    const secondResponse = await fetch(`/api/monitor/history?limit=10&session_id=${sessionId}&${next}`)
    const second = await secondResponse.json().catch(() => ({}))
    const firstIds = (first.runs ?? []).map((run) => run.id)
    const secondIds = (second.runs ?? []).map((run) => run.id)
    return { ok: imported.ok && importBody.count === 11 && firstResponse.ok && secondResponse.ok && firstIds.length === 10 && secondIds.length === 1 && new Set([...firstIds, ...secondIds]).size === 11 && second.next_before === null, status: imported.status, imported: importBody.count, firstPage: firstIds.length, secondPage: secondIds.length, sessionId }
  })
  record("monitor-history-import-and-compound-pagination", monitorSeed.ok, `imported=${monitorSeed.imported}; pages=${monitorSeed.firstPage}+${monitorSeed.secondPage}`)

  const websocketConnect = () => page.evaluate(() => new Promise((resolve) => {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:"
    const socket = new WebSocket(`${scheme}//${location.host}/miki/ws?session_id=miki-e2e-session`)
    const timeout = setTimeout(() => { socket.close(); resolve(false) }, 8_000)
    socket.addEventListener("open", () => { clearTimeout(timeout); socket.close(); resolve(true) }, { once: true })
    socket.addEventListener("error", () => { clearTimeout(timeout); resolve(false) }, { once: true })
  }))
  record("authenticated-websocket-connect", await websocketConnect(), "session-cookie handshake")

  const routes = [
    "/", "/drive", "/models", "/config", "/health",
    "/plugins?section=catalog", "/plugins?section=installed", "/plugins?section=core", "/plugins?section=health",
    "/channels", "/channels/telegram", "/memory", "/agent/monitor", "/agent/activity",
    "/agent/skills", "/agent/skills?view=discover", "/agent/tools", "/launcher-login", "/launcher-setup",
  ]
  for (const route of routes) {
    const nav = await page.goto(new URL(route, origin).href, { waitUntil: "domcontentloaded" })
    // SPA route chunks and React hydration may finish after DOMContentLoaded.
    await page.waitForFunction(() => document.body.innerText.trim().length > 0, undefined, { timeout: 8_000 }).catch(() => {})
    const visible = await page.locator("body").innerText({ timeout: 5_000 }).catch(() => "")
    record(`browser-route:${route}`, Boolean(nav?.ok()) && visible.trim().length > 0, nav ? `HTTP ${nav.status()}; rendered-text=${visible.trim().length}` : "no response")
  }

  const capture = await page.evaluate(async () => { const r = await fetch("/api/autonomy/screenshot", { cache: "no-store" }); const b = await r.json().catch(() => ({})); return { status: r.status, hasImage: typeof b.png_base64 === "string" && b.png_base64.length > 100, capturedAt: typeof b.captured_at === "string" } })
  const captureOk = capture.status === 200 && capture.hasImage && capture.capturedAt
  if (captureOk) record("desktop-capture-permission-and-freshness", true, `HTTP ${capture.status}; fresh timestamp present`)
  else if (process.env.MIKI_E2E_DESKTOP_REQUIRED !== "true" && [403, 404, 502].includes(capture.status)) record("desktop-capture-permission-and-freshness", true, `SKIPPED (no interactive desktop/capture permission; HTTP ${capture.status})`)
  else record("desktop-capture-permission-and-freshness", false, `HTTP ${capture.status}; image=${capture.hasImage}; timestamp=${capture.capturedAt}`)

  if (mockProvider) {
    // The provider stub intentionally accepts only its own fixed test key; a negative test proves auth errors surface.
    const positive = await page.evaluate(async (apiBase) => {
      const response = await fetch("/api/models/test-inline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "miki-e2e-mock", provider: "openai-compatible", api_base: apiBase, api_key: "miki-e2e-mock-key" }) })
      const body = await response.json().catch(() => ({}))
      return { status: response.status, success: body.success === true, completed: body.final_response_received === true }
    }, mockProvider.base)
    // Keep the failure key separate from the valid key used above.
    const negative = await page.evaluate(async (apiBase) => {
      const response = await fetch("/api/models/test-inline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "miki-e2e-mock", provider: "openai-compatible", api_base: apiBase, api_key: "wrong-e2e-key" }) })
      const body = await response.json().catch(() => ({}))
      return { status: response.status, success: body.success === true, category: body.error_category }
    }, mockProvider.base)
    record("mock-provider-completion", positive.status === 200 && positive.success && positive.completed, `HTTP ${positive.status}; completion=${positive.completed}`)
    record("mock-provider-auth-rejection", negative.status === 200 && !negative.success, `HTTP ${negative.status}; rejected=${!negative.success}`)
  } else if (process.env.MIKI_E2E_PROVIDER_ENABLED === "true") {
    const provider = { model: process.env.MIKI_E2E_PROVIDER_MODEL || "", provider: process.env.MIKI_E2E_PROVIDER || "openai-compatible", api_base: process.env.MIKI_E2E_PROVIDER_BASE || "", api_key: process.env.MIKI_E2E_PROVIDER_KEY || "" }
    if (!provider.model || !provider.api_key) throw new Error("provider_e2e_model_and_key_required")
    const probe = await page.evaluate(async (body) => { const r = await fetch("/api/models/test-inline", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const b = await r.json().catch(() => ({})); return { status: r.status, success: b.success === true, completed: b.final_response_received === true } }, provider)
    record("live-provider-completion", probe.status === 200 && probe.success && probe.completed, `HTTP ${probe.status}; completion=${probe.completed}`)
  } else record("live-provider-completion", true, "SKIPPED (no live provider credentials configured)")

  if (!autostart && process.env.MIKI_E2E_CHANNEL_SEND_ENABLED === "true") {
    const channel = process.env.MIKI_E2E_CHANNEL || "telegram"
    const recipient = process.env.MIKI_E2E_TEST_RECIPIENT || ""
    const key = `run-${Date.now()}-${randomBytes(4).toString("hex")}`
    if (!recipient || recipient === "*") throw new Error("channel_e2e_private_recipient_required")
    const sent = await page.evaluate(async ({ channelName, destination, id }) => {
      const r = await fetch(`/api/channels/${encodeURIComponent(channelName)}/test-delivery`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": id }, body: JSON.stringify({ recipient: destination, text: `MIKI-E2E:${id}` }) })
      const b = await r.json().catch(() => ({}))
      return { status: r.status, ok: b.ok === true, hasAck: typeof b.provider_ack_id === "string" }
    }, { channelName: channel, destination: recipient, id: key })
    record("live-channel-delivery", sent.status === 200 && sent.ok && sent.hasAck, `HTTP ${sent.status}; ack=${sent.hasAck}`)
  } else record("live-channel-delivery", true, "SKIPPED (requires an explicitly configured private test recipient and staging bot)")

  const runRestart = Boolean(isolatedGateway) || process.env.MIKI_E2E_RESTART_ENABLED === "true"
  if (runRestart) {
    const before = await page.evaluate(async () => { const r = await fetch("/api/gateway/status"); return r.json() })
    const requested = await page.evaluate(async () => { const r = await fetch("/api/gateway/restart", { method: "POST" }); return { status: r.status, body: await r.json().catch(() => ({})) } })
    if (requested.status === 202 && requested.body?.status === "restarting") {
      let restarted = false
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        await wait(500)
        try {
          // Use the browser's authenticated cookie jar after the Gateway process changes.
          // Node's global fetch does not share Playwright's miki_session cookie.
          const current = await page.evaluate(async () => {
            const response = await fetch("/api/gateway/status", { cache: "no-store", signal: AbortSignal.timeout(2_000) })
            return { ok: response.ok, body: await response.json().catch(() => ({})) }
          })
          if (current.ok && current.body?.gateway_status === "running" && current.body?.pid !== before.pid) {
            restarted = true
            break
          }
        } catch { /* supervisor is replacing the Gateway; retry */ }
      }
      record("supervised-runtime-restart", restarted, restarted ? "new gateway PID is healthy" : "gateway did not return with a new PID")
      if (restarted) {
        const preserved = await page.evaluate(async () => {
          const [auth, monitor, plugins] = await Promise.all([fetch("/api/auth/status"), fetch("/api/monitor/history?limit=1"), fetch("/api/plugins/installed")])
          const status = await auth.json().catch(() => ({}))
          return auth.ok && status.authenticated === true && monitor.ok && plugins.ok
        })
        record("restart-preserves-auth-and-durable-apis", preserved)
        const monitorPersisted = await page.evaluate(async (sessionId) => {
          const firstResponse = await fetch(`/api/monitor/history?limit=10&session_id=${encodeURIComponent(sessionId)}`, { cache: "no-store" })
          const first = await firstResponse.json().catch(() => ({}))
          const cursor = first?.next_before
          if (!firstResponse.ok || (first.runs ?? []).length !== 10 || !cursor) return false
          const query = new URLSearchParams({ before_seq: String(cursor.seq), before_started_at: cursor.started_at, before_run_id: cursor.run_id })
          const secondResponse = await fetch(`/api/monitor/history?limit=10&session_id=${encodeURIComponent(sessionId)}&${query}`, { cache: "no-store" })
          const second = await secondResponse.json().catch(() => ({}))
          return secondResponse.ok && (second.runs ?? []).length === 1 && second.runs[0]?.id === "miki-e2e-history-10"
        }, monitorSeed.sessionId)
        record("monitor-history-survives-runtime-restart", monitorPersisted)
        record("websocket-reconnect-after-restart", await websocketConnect(), "session-cookie handshake after PID change")
      }
    } else record("supervised-runtime-restart", false, `HTTP ${requested.status}; supported=${requested.body?.supported !== false}`)
  } else record("supervised-runtime-restart", true, "SKIPPED (requires a dedicated supervised staging Gateway)")

  await page.evaluate(async () => { await fetch("/api/auth/logout", { method: "POST" }) })
  const loggedOut = await page.evaluate(async () => { const r = await fetch("/api/auth/status"); const b = await r.json(); return r.status === 200 && b.authenticated === false })
  record("logout-invalidates-session", loggedOut)
  record("browser-console-page-errors", pageErrors === 0, `${pageErrors} uncaught page error(s)`)
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown_error"
  record("live-e2e-run", false, message.replace(/[A-Za-z0-9_-]{24,}/g, "[redacted]"))
} finally {
  await browser?.close().catch(() => {})
  await mockProvider?.close().catch(() => {})
  await isolatedGateway?.stop().catch(() => {})
}

const failed = results.filter((item) => !item.ok)
const skipped = results.filter((item) => item.skipped)
const passed = results.length - failed.length - skipped.length
process.stdout.write(`\n${passed} passed, ${skipped.length} skipped, ${failed.length} failed (${results.length} total).\n`)
if (failed.length) process.exitCode = 1
