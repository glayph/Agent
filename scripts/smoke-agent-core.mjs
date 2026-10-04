#!/usr/bin/env node
// End-to-end check of the agent engine through the real gateway.
//
// A tiny OpenAI-compatible server stands in for the model provider, so this
// verifies the Miki side: HTTP control endpoints, approvals, the WebSocket
// agent loop, tool execution, persistence and cancellation. It does not test
// model quality. The fake provider never writes user-facing text itself except
// to echo what the tools returned, which is what proves the loop feeds tool
// results back to the model.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import WebSocket from "ws"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "miki-smoke-"))
const workspace = path.join(tmp, "workspace")
fs.mkdirSync(workspace)
fs.writeFileSync(path.join(workspace, "hello.txt"), "hello from the workspace")

// ---- fake model provider ---------------------------------------------------
const llmRequests = []
const llm = http.createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => (body += chunk))
  req.on("end", () => {
    const payload = JSON.parse(body)
    llmRequests.push(payload)
    const messages = payload.messages
    const last = messages[messages.length - 1]
    const system = String(messages[0]?.content ?? "")
    const reply = (message) =>
      res.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }),
      )
    const call = (name, args) => reply({ role: "assistant", content: null, tool_calls: [{ id: `call_${Date.now()}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] })
    if (system.includes("planning module"))
      return reply({ role: "assistant", content: JSON.stringify({ steps: [{ title: "List the workspace", tool: "workspace_list" }, { title: "Report" }] }) })
    if (last.role === "tool") return reply({ role: "assistant", content: `TOOL RESULT SEEN: ${last.content}` })
    const text = String(last.content)
    if (text.includes("HANG")) return // never answers: used for the cancel test
    if (text.includes("LISTFILES")) return call("workspace_list", {})
    if (text.includes("WRITEFILE")) return call("file_write", { path: "notes/out.txt", content: "written by the agent" })
    if (text.includes("READSECRET")) return call("file_read", { path: ".env" })
    if (text.includes("RUNJOB")) return call("file_run", { path: "job.js", args: ["from-agent"] })
    if (text.includes("DELETEDIR")) return call("file_delete", { path: "trash", recursive: true })
    if (text.includes("MKMOVE")) return call("file_move", { path: "hello.txt", destination: "moved-by-agent.txt" })
    return reply({ role: "assistant", content: `PLAIN ANSWER to: ${text}` })
  })
})
await new Promise((resolve) => llm.listen(0, "127.0.0.1", resolve))
const llmPort = llm.address().port

// ---- gateway ---------------------------------------------------------------
const gatewayPort = 20000 + Math.floor(Math.random() * 20000)
const base = `http://127.0.0.1:${gatewayPort}`
const gateway = spawn(process.execPath, [path.join(root, "packages/gateway/dist/index.js")], {
  cwd: root,
  env: {
    ...process.env,
    GATEWAY_PORT: String(gatewayPort),
    GATEWAY_HOST: "127.0.0.1",
    MIKI_DATA_DIR: path.join(tmp, "data"),
    MIKI_WORKSPACE_DIR: workspace,
    OPENAI_API_KEY: "test-key",
    OPENAI_API_BASE: `http://127.0.0.1:${llmPort}/v1`,
    MIKI_MODEL: "fake-model",
  },
  stdio: ["ignore", "pipe", "pipe"],
})
let gatewayLog = ""
gateway.stdout.on("data", (d) => (gatewayLog += d))
gateway.stderr.on("data", (d) => (gatewayLog += d))

let passed = 0
const check = async (name, fn) => {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.error(`FAIL  ${name}\n      ${error.message}`)
    console.error(gatewayLog.split("\n").slice(-15).join("\n"))
    await cleanup(1)
  }
}
async function cleanup(code) {
  gateway.kill("SIGTERM")
  llm.close()
  llm.closeAllConnections?.()
  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(code === 0 ? `\nAll ${passed} checks passed.` : "\nSmoke test failed.")
  process.exit(code)
}

for (let i = 0; i < 100; i += 1) {
  try {
    if ((await fetch(`${base}/gateway/health`)).ok) break
  } catch {
    await new Promise((r) => setTimeout(r, 100))
  }
}

let cookie = ""
const api = async (method, url, body, { auth = true } = {}) => {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try { json = JSON.parse(text) } catch { json = undefined }
  return { status: response.status, json, headers: response.headers }
}

// WebSocket helper: send one message and collect events until the run ends.
function chat(sessionId, content, { onEvent } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/miki/ws?session_id=${sessionId}`, { headers: { Cookie: cookie } })
    const events = []
    const timer = setTimeout(() => { ws.close(); reject(new Error(`chat timed out; events: ${events.map((e) => e.type).join(",")}`)) }, 15000)
    ws.on("error", reject)
    ws.on("message", (raw) => {
      const event = JSON.parse(raw.toString())
      events.push(event)
      onEvent?.(event, ws)
      if (event.type === "connection.ready") ws.send(JSON.stringify({ type: "message.send", id: "t1", payload: { content } }))
      if (event.type === "node.run_end") { clearTimeout(timer); ws.close(); resolve(events) }
    })
  })
}

console.log("Agent core smoke test")

await check("protected endpoints reject unauthenticated callers", async () => {
  assert.equal((await api("GET", "/api/test", undefined, { auth: false })).status, 401)
  assert.equal((await api("GET", "/api/control/approvals", undefined, { auth: false })).status, 401)
  assert.equal((await api("POST", "/api/control/execute", {}, { auth: false })).status, 401)
  for (const [method, url] of [["GET", "/api/files/roots"], ["GET", "/api/files?path=/"], ["GET", "/api/files/download?path=/etc/hostname"], ["POST", "/api/files/run"], ["POST", "/api/files/upload"]])
    assert.equal((await api(method, url, method === "POST" ? {} : undefined, { auth: false })).status, 401, `${method} ${url}`)
})

await check("dashboard setup issues a session", async () => {
  const response = await api("POST", "/api/auth/setup", { password: "correct-horse-1", confirm: "correct-horse-1" }, { auth: false })
  assert.equal(response.status, 200)
  cookie = response.headers.get("set-cookie").split(";")[0]
})

await check("the WebSocket refuses connections without the session cookie", async () => {
  await assert.rejects(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${gatewayPort}/miki/ws`)
      ws.on("open", resolve)
      ws.on("error", reject)
    }),
  )
})

await check("GET /api/test reports engine readiness", async () => {
  const { status, json } = await api("GET", "/api/test")
  assert.equal(status, 200)
  assert.equal(json.ok, true)
  assert.ok(json.checks.find((c) => c.name === "tools").detail.includes("file_read"))
})

await check("POST /api/test runs a real model turn", async () => {
  const { status, json } = await api("POST", "/api/test", { prompt: "ping" })
  assert.equal(status, 200)
  assert.equal(json.status, "completed")
  assert.equal(json.answer, "PLAIN ANSWER to: ping")
  assert.equal(json.usage.totalTokens, 10)
})

await check("POST /api/test with tools runs the tool loop", async () => {
  const { json } = await api("POST", "/api/test", { prompt: "LISTFILES", tools: true })
  assert.equal(json.status, "completed")
  assert.equal(json.toolCalls[0].name, "workspace_list")
  assert.equal(json.toolCalls[0].status, "succeeded")
  assert.ok(json.answer.includes("hello.txt"))
})

await check("/api/control capabilities, state and operations are real", async () => {
  const caps = await api("GET", "/api/control/capabilities")
  assert.ok(caps.json.capabilities.some((c) => c.id === "tool_state"))
  const state = await api("GET", "/api/control/state")
  assert.equal(state.json.state.tool_state.filesystem, true)
  assert.ok(state.json.state.runtime.engine.tools.includes("file_write"))
})

await check("/api/control/plan returns a validated plan and rejects unknown operations", async () => {
  const plan = await api("POST", "/api/control/plan", { capability: "tool_state", action: "set", input: { name: "memory", enabled: false } })
  assert.equal(plan.status, 200)
  assert.equal(plan.json.plan.status, "approval_required")
  assert.equal(plan.json.plan.approvalRequired, true)
  const bad = await api("POST", "/api/control/plan", { capability: "nope", action: "x" })
  assert.equal(bad.json.plan.status, "failed")
})

let approvalId
await check("/api/control/execute requires approval, then applies the change once approved", async () => {
  const request = { capability: "tool_state", action: "set", input: { name: "memory", enabled: false }, context: { origin: "api" } }
  const first = await api("POST", "/api/control/execute", request)
  assert.equal(first.status, 202)
  assert.equal(first.json.outcome.status, "approval_required")
  approvalId = first.json.outcome.evidence.find((e) => e.id === "approval").data.request_id
  const pending = await api("GET", "/api/control/approvals")
  assert.equal(pending.json.requests.filter((r) => r.status === "pending").length, 1)
  // Not applied yet.
  assert.equal((await api("GET", "/api/control/state")).json.state.tool_state.memory, true)
  // Approving a different operation's request must not authorize this one.
  const approved = await api("POST", `/api/control/approvals/${approvalId}/approve`, { decidedBy: "smoke" })
  assert.equal(approved.json.request.status, "approved")
  const mismatched = await api("POST", "/api/control/execute", { ...request, input: { name: "memory", enabled: true }, approvalRequestId: approvalId })
  assert.notEqual(mismatched.json.outcome.status, "succeeded")
  const second = await api("POST", "/api/control/execute", { ...request, approvalRequestId: approvalId })
  assert.equal(second.status, 200, JSON.stringify(second.json))
  assert.equal(second.json.outcome.status, "succeeded")
  assert.equal((await api("GET", "/api/control/state")).json.state.tool_state.memory, false)
  const toolsList = await api("GET", "/api/tools")
  assert.equal(toolsList.json.tools.find((t) => t.config_key === "memory").status, "disabled")
  // The approval is single-use.
  const replay = await api("POST", "/api/control/execute", { ...request, approvalRequestId: approvalId })
  assert.notEqual(replay.json.outcome.status, "succeeded")
})

await check("disabling a tool group removes its tools from the agent", async () => {
  const names = (await api("GET", "/api/control/state")).json.state.runtime.engine.tools
  assert.ok(!names.includes("memory_search"))
  assert.ok(names.includes("file_read"))
})

await check("chat: the agent loop calls a tool and answers from its result", async () => {
  const events = await chat("s-list", "LISTFILES please")
  const types = events.map((e) => e.type)
  assert.ok(types.includes("node.run_start"))
  const toolCreate = events.find((e) => e.type === "message.create" && e.payload.kind === "tool_calls")
  assert.equal(toolCreate.payload.tool_calls[0].function.name, "workspace_list")
  assert.ok(events.some((e) => e.type === "message.update" && e.payload.message_id === toolCreate.payload.message_id))
  const final = events.find((e) => e.type === "message.create" && e.payload.kind === "normal")
  assert.ok(final.payload.content.includes("hello.txt"), final.payload.content)
  const end = events.find((e) => e.type === "node.run_end")
  assert.equal(end.payload.status, "completed")
  // Persisted for the next turn.
  const session = await api("GET", "/api/sessions/s-list")
  assert.ok(session.json.messages.some((m) => m.role === "assistant" && m.content.includes("hello.txt")))
})

await check("chat: a write waits for approval, runs after approval, and the file exists", async () => {
  let approved = false
  const events = await chat("s-write", "WRITEFILE now", {
    onEvent: async (event) => {
      if (event.type === "message.create" || event.type === "message.update") {
        const status = event.payload.tool_calls?.[0]?.extra_content?.tool_feedback_explanation
        if (status === "awaiting_approval" && !approved) {
          approved = true
          const pending = (await api("GET", "/api/control/approvals")).json.requests.find((r) => r.status === "pending" && r.action === "file_write")
          await api("POST", `/api/control/approvals/${pending.id}/approve`, {})
        }
      }
    },
  })
  assert.ok(approved, "the call should have asked for approval")
  assert.equal(events.find((e) => e.type === "node.run_end").payload.status, "completed")
  assert.equal(fs.readFileSync(path.join(workspace, "notes", "out.txt"), "utf8"), "written by the agent")
})

await check("chat: a denied write never touches the filesystem", async () => {
  fs.rmSync(path.join(workspace, "notes"), { recursive: true, force: true })
  const events = await chat("s-deny", "WRITEFILE again", {
    onEvent: async (event) => {
      if (event.payload?.tool_calls?.[0]?.extra_content?.tool_feedback_explanation === "awaiting_approval") {
        const pending = (await api("GET", "/api/control/approvals")).json.requests.find((r) => r.status === "pending" && r.action === "file_write")
        await api("POST", `/api/control/approvals/${pending.id}/deny`, { reason: "not now" })
      }
    },
  })
  assert.equal(fs.existsSync(path.join(workspace, "notes", "out.txt")), false)
  assert.ok(events.some((e) => e.payload?.tool_calls?.[0]?.extra_content?.tool_feedback_explanation?.startsWith("denied")))
})

await check("chat: secret files are blocked and the model is told why", async () => {
  fs.writeFileSync(path.join(workspace, ".env"), "OPENAI_API_KEY=sk-should-never-leak-123456789012")
  const events = await chat("s-secret", "READSECRET")
  const final = events.find((e) => e.type === "message.create" && e.payload.kind === "normal")
  assert.ok(final.payload.content.includes("blocked"), final.payload.content)
  assert.ok(!JSON.stringify(events).includes("should-never-leak"))
})

await check("chat: stop button (cancel_task) cancels a run stuck on the model", async () => {
  const events = await chat("s-cancel", "HANG forever", {
    onEvent: (event, ws) => {
      if (event.type === "node.run_start") setTimeout(() => ws.send(JSON.stringify({ type: "cancel_task", task_id: event.payload.run_id })), 200)
    },
  })
  assert.equal(events.find((e) => e.type === "node.run_end").payload.status, "cancelled")
})

await check("DELETE /api/tasks/:id cancels an active run over HTTP", async () => {
  const events = await chat("s-http-cancel", "HANG again", {
    onEvent: async (event) => {
      if (event.type === "node.run_start") setTimeout(() => api("DELETE", `/api/tasks/${event.payload.run_id}`), 200)
    },
  })
  assert.equal(events.find((e) => e.type === "node.run_end").payload.status, "cancelled")
  assert.equal((await api("DELETE", "/api/tasks/run_does_not_exist")).status, 404)
})

await check("multi-step goals are planned by the model before execution", async () => {
  const before = llmRequests.length
  const events = await chat("s-plan", "First LISTFILES in the workspace and then read the config file, then check the setting")
  const plan = events.find((e) => e.type === "message.create" && e.payload.thought_category === "Plan")
  assert.ok(plan.payload.content.includes("List the workspace"), JSON.stringify(plan?.payload))
  assert.ok(llmRequests.length > before + 1)
})

// ---- Files / Drive ----------------------------------------------------------
const abs = (name) => path.join(workspace, name)
const getBytes = async (url) => {
  const response = await fetch(`${base}${url}`, { headers: { Cookie: cookie } })
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) }
}

await check("files: roots report the workspace as writable and runnable", async () => {
  const { json } = await api("GET", "/api/files/roots")
  const ws = json.roots.find((r) => r.kind === "workspace")
  assert.equal(ws.canWrite, true)
  assert.equal(ws.canRun, true)
})

await check("files: create, list, read and write with a conflict guard", async () => {
  const made = await api("POST", "/api/files/create", { parentPath: workspace, name: "docs", type: "directory" })
  assert.equal(made.status, 201, JSON.stringify(made.json))
  const file = await api("POST", "/api/files/create", { parentPath: abs("docs"), name: "a.txt", type: "file", content: "one" })
  assert.equal(file.status, 201)
  const listing = await api("GET", `/api/files?path=${encodeURIComponent(abs("docs"))}`)
  assert.deepEqual(listing.json.entries.map((e) => e.name), ["a.txt"])
  const read = await api("GET", `/api/files/read?path=${encodeURIComponent(abs("docs/a.txt"))}`)
  assert.equal(read.json.content, "one")
  const stale = await api("PUT", "/api/files/write", { path: abs("docs/a.txt"), content: "two", expectedModifiedAt: "2001-01-01T00:00:00.000Z" })
  assert.equal(stale.status, 409)
  const ok = await api("PUT", "/api/files/write", { path: abs("docs/a.txt"), content: "two", expectedModifiedAt: read.json.modifiedAt })
  assert.equal(ok.status, 200)
  assert.equal(fs.readFileSync(abs("docs/a.txt"), "utf8"), "two")
})

await check("files: upload (multipart), download and duplicate-name protection", async () => {
  const form = new FormData()
  form.set("parentPath", abs("docs"))
  form.set("file", new Blob(["uploaded bytes \u2713"]), "up.txt")
  const upload = await fetch(`${base}/api/files/upload`, { method: "POST", headers: { Cookie: cookie }, body: form })
  assert.equal(upload.status, 201)
  assert.equal(fs.readFileSync(abs("docs/up.txt"), "utf8"), "uploaded bytes \u2713")
  const again = new FormData()
  again.set("parentPath", abs("docs"))
  again.set("file", new Blob(["x"]), "up.txt")
  assert.equal((await fetch(`${base}/api/files/upload`, { method: "POST", headers: { Cookie: cookie }, body: again })).status, 409)
  const traversal = new FormData()
  traversal.set("parentPath", abs("docs"))
  traversal.set("file", new Blob(["x"]), "../../escape.txt")
  assert.notEqual((await fetch(`${base}/api/files/upload`, { method: "POST", headers: { Cookie: cookie }, body: traversal })).status, 201)
  assert.equal(fs.existsSync(path.join(tmp, "escape.txt")), false)
  const download = await getBytes(`/api/files/download?path=${encodeURIComponent(abs("docs/up.txt"))}`)
  assert.equal(download.status, 200)
  assert.ok(download.headers.get("content-disposition").includes("attachment"))
  assert.equal(download.bytes.toString("utf8"), "uploaded bytes \u2713")
})

await check("files: archive download returns a gzip tarball of the selection", async () => {
  const archive = await getBytes(`/api/files/download-archive?paths=${encodeURIComponent(abs("docs"))}`)
  assert.equal(archive.status, 200)
  assert.equal(archive.bytes[0], 0x1f)
  assert.equal(archive.bytes[1], 0x8b)
  assert.ok(archive.headers.get("content-disposition").includes("docs.tar.gz"))
})

await check("files: preview serves images inline and rejects plain text", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
  fs.writeFileSync(abs("pic.png"), png)
  const preview = await getBytes(`/api/files/preview?path=${encodeURIComponent(abs("pic.png"))}`)
  assert.equal(preview.status, 200)
  assert.equal(preview.headers.get("content-type"), "image/png")
  assert.deepEqual(preview.bytes, png)
  assert.equal((await getBytes(`/api/files/preview?path=${encodeURIComponent(abs("docs/a.txt"))}`)).status, 415)
})

await check("files: rename, copy folder, move and delete", async () => {
  assert.equal((await api("PATCH", "/api/files/rename", { path: abs("docs/a.txt"), newName: "b.txt" })).status, 200)
  // Copying onto an existing name must be refused, never overwrite.
  assert.equal((await api("POST", "/api/files/copy", { paths: [abs("docs")], destinationPath: workspace })).status, 409)
  fs.mkdirSync(abs("backup"))
  const copy = await api("POST", "/api/files/copy", { paths: [abs("docs")], destinationPath: abs("backup") })
  assert.ok([200, 201].includes(copy.status), JSON.stringify(copy.json))
  assert.equal(fs.readFileSync(abs("backup/docs/b.txt"), "utf8"), "two")
  const moved = await api("POST", "/api/files/move", { paths: [abs("docs/b.txt")], destinationPath: workspace })
  assert.ok([200, 201].includes(moved.status), JSON.stringify(moved.json))
  assert.ok(fs.existsSync(abs("b.txt")))
  assert.equal((await api("DELETE", "/api/files", { path: abs("docs"), recursive: false })).status, 400)
  assert.equal((await api("DELETE", "/api/files", { path: abs("docs"), recursive: true })).status, 200)
  assert.equal(fs.existsSync(abs("docs")), false)
})

await check("files: the data directory and credential files are hidden and untouchable", async () => {
  const names = (await api("GET", `/api/files?path=${encodeURIComponent(workspace)}`)).json.entries.map((e) => e.name)
  assert.ok(!names.includes(".env"), names.join(","))
  assert.equal((await api("GET", `/api/files/read?path=${encodeURIComponent(abs(".env"))}`)).status, 403)
  assert.equal((await api("GET", `/api/files/read?path=${encodeURIComponent("/etc/hostname")}`)).status, 403)
})

fs.writeFileSync(abs("job.js"), 'console.log("job ok", process.argv.slice(2).join(" "))')
fs.writeFileSync(abs("broken.js"), 'console.error("script exploded");process.exit(4)')
fs.writeFileSync(abs("slow.js"), "setInterval(() => {}, 1000)")

await check("files: /api/files/run really executes a script (no longer disabled)", async () => {
  const run = await api("POST", "/api/files/run", { path: abs("job.js") })
  assert.equal(run.status, 200, JSON.stringify(run.json))
  assert.equal(run.json.status, "ok")
  assert.equal(run.json.result.stdout.trim(), "job ok")
  assert.equal(run.json.result.exitCode, 0)
  assert.ok(!JSON.stringify(run.json).includes("disabled by the safe workspace policy"))
})

await check("files: a failing script returns 422 with the error line; bad targets are rejected", async () => {
  const bad = await api("POST", "/api/files/run", { path: abs("broken.js") })
  assert.equal(bad.status, 422)
  assert.ok(bad.json.error.includes("code 4") && bad.json.error.includes("script exploded"), bad.json.error)
  assert.equal((await api("POST", "/api/files/run", { path: "/etc/hostname" })).status, 403)
  assert.equal((await api("POST", "/api/files/run", { path: abs("pic.png") })).status, 400)
  assert.equal((await api("POST", "/api/files/run", { path: abs(".env") })).status, 403)
})

await check("files: runs are recorded in the audit table", async () => {
  const Database = (await import("better-sqlite3")).default
  const db = new Database(path.join(tmp, "data", "miki-runtime.sqlite"), { readonly: true })
  const rows = db.prepare("SELECT file,status,source,exit_code FROM file_runs ORDER BY id").all()
  db.close()
  assert.ok(rows.some((r) => r.file === "job.js" && r.status === "ok" && r.source === "dashboard" && r.exit_code === 0), JSON.stringify(rows))
  assert.ok(rows.some((r) => r.file === "broken.js" && r.status === "failed" && r.exit_code === 4))
})

await check("agent: file_run waits for approval, then returns real script output to the model", async () => {
  let asked = false
  const events = await chat("s-run", "RUNJOB please", {
    onEvent: async (event) => {
      if (event.payload?.tool_calls?.[0]?.extra_content?.tool_feedback_explanation === "awaiting_approval" && !asked) {
        asked = true
        const pending = (await api("GET", "/api/control/approvals")).json.requests.find((r) => r.status === "pending" && r.action === "file_run")
        await api("POST", `/api/control/approvals/${pending.id}/approve`, {})
      }
    },
  })
  assert.ok(asked)
  const final = events.find((e) => e.type === "message.create" && e.payload.kind === "normal")
  assert.ok(final.payload.content.includes("job ok from-agent"), final.payload.content)
})

await check("agent: a denied file_run never executes", async () => {
  fs.writeFileSync(abs("job.js"), `require("fs").writeFileSync(${JSON.stringify(abs("ran.marker"))}, "x")`)
  await chat("s-run-deny", "RUNJOB again", {
    onEvent: async (event) => {
      if (event.payload?.tool_calls?.[0]?.extra_content?.tool_feedback_explanation === "awaiting_approval") {
        const pending = (await api("GET", "/api/control/approvals")).json.requests.find((r) => r.status === "pending" && r.action === "file_run")
        await api("POST", `/api/control/approvals/${pending.id}/deny`, {})
      }
    },
  })
  assert.equal(fs.existsSync(abs("ran.marker")), false)
})

await check("agent: file_delete needs approval; file_move organizes files", async () => {
  fs.mkdirSync(abs("trash/inner"), { recursive: true })
  fs.writeFileSync(abs("trash/inner/x.txt"), "x")
  let asked = false
  await chat("s-del", "DELETEDIR now", {
    onEvent: async (event) => {
      if (event.payload?.tool_calls?.[0]?.extra_content?.tool_feedback_explanation === "awaiting_approval" && !asked) {
        asked = true
        assert.equal(fs.existsSync(abs("trash")), true, "must not be deleted before approval")
        const pending = (await api("GET", "/api/control/approvals")).json.requests.find((r) => r.status === "pending" && r.action === "file_delete")
        await api("POST", `/api/control/approvals/${pending.id}/approve`, {})
      }
    },
  })
  assert.ok(asked)
  assert.equal(fs.existsSync(abs("trash")), false)
  // file_move is a config_write tool, so it is approved the same way.
  fs.writeFileSync(abs("hello.txt"), "move me")
  await chat("s-move", "MKMOVE", {
    onEvent: async (event) => {
      if (event.payload?.tool_calls?.[0]?.extra_content?.tool_feedback_explanation === "awaiting_approval") {
        const pending = (await api("GET", "/api/control/approvals")).json.requests.find((r) => r.status === "pending" && r.action === "file_move")
        await api("POST", `/api/control/approvals/${pending.id}/approve`, {})
      }
    },
  })
  assert.equal(fs.readFileSync(abs("moved-by-agent.txt"), "utf8"), "move me")
})

await cleanup(0)
