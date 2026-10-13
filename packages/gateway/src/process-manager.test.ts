import { describe, expect, it } from "@jest/globals"
import { mkdtempSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { ProcessManager } from "./process-manager.js"
import { createTerminalTools } from "./terminal-tool.js"

const cwd = () => mkdtempSync(path.join(os.tmpdir(), "miki-proc-"))
const ctx = (signal = new AbortController().signal) => ({ runId: "run-1", sessionId: "sess-1", callId: "c", signal })
const tools = () => {
  const processes = new ProcessManager()
  const dir = cwd()
  const [run, status, kill] = createTerminalTools({ root: () => dir, restrictToWorkspace: () => false, processes })
  return { processes, run, status, kill }
}
type R = Record<string, any>

describe("ProcessManager", () => {
  it("resolves waits the moment the process exits (event-driven), not at the deadline", async () => {
    const pm = new ProcessManager()
    const proc = pm.start({ command: "sleep 0.3; echo done", cwd: cwd(), env: process.env })
    const started = Date.now()
    const exited = await pm.waitForExit(proc.id, 20_000)
    expect(exited).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(proc.status).toBe("exited")
    expect(proc.exitCode).toBe(0)
  })
  it("returns false when the wait slice ends first and keeps the command running", async () => {
    const pm = new ProcessManager()
    const proc = pm.start({ command: "sleep 5", cwd: cwd(), env: process.env })
    expect(await pm.waitForExit(proc.id, 200)).toBe(false)
    expect(proc.status).toBe("running")
    pm.kill(proc.id)
    expect(await pm.waitForExit(proc.id, 3000)).toBe(true)
    expect(proc.status).toBe("killed")
  })
  it("queues a finish notice exactly once", async () => {
    const pm = new ProcessManager()
    const proc = pm.start({ command: "exit 3", cwd: cwd(), env: process.env, sessionId: "s" })
    await pm.waitForExit(proc.id, 5000)
    const first = pm.takeFinishedNotices("s")
    expect(first).toHaveLength(1)
    expect(first[0]).toMatch(/exit code 3/)
    expect(pm.takeFinishedNotices("s")).toHaveLength(0)
    expect(pm.takeFinishedNotices("other-session")).toHaveLength(0)
  })
})

describe("terminal tools", () => {
  it("returns output and exit code for a quick command", async () => {
    const { run } = tools()
    const r = (await run.execute({ command: "echo hello" }, ctx())) as R
    expect(r).toMatchObject({ status: "exited", exit_code: 0, timed_out: false })
    expect(r.stdout.trim()).toBe("hello")
  })
  it("does NOT kill a slow command: reports running, then status waits for it and returns only new output", async () => {
    const { run, status, processes } = tools()
    const first = (await run.execute({ command: "echo start; sleep 2; echo end", wait_seconds: 1 }, ctx())) as R
    expect(first.status).toBe("running")
    expect(first.new_stdout).toContain("start")
    expect(first.message).toMatch(/STILL RUNNING/)
    const second = (await status.execute({ process_id: first.process_id, wait_seconds: 30 }, ctx())) as R
    expect(second).toMatchObject({ status: "exited", exit_code: 0 })
    expect(second.stdout).toContain("end")
    expect(second.stdout).not.toContain("start") // only output not seen before
    expect(processes.takeFinishedNotices("sess-1")).toHaveLength(0) // already reported in the tool result
  }, 20_000)
  it("background commands return immediately and finish with a system notice", async () => {
    const { run, processes } = tools()
    const r = (await run.execute({ command: "sleep 3; echo bg", background: true }, ctx())) as R
    expect(r.status).toBe("running")
    await processes.waitForExit(r.process_id, 10_000)
    const notices = processes.takeFinishedNotices("sess-1")
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatch(/finished successfully/)
  }, 20_000)
  it("terminal_status lists commands and terminal_kill stops one", async () => {
    const { run, status, kill } = tools()
    const r = (await run.execute({ command: "sleep 30", background: true }, ctx())) as R
    const list = (await status.execute({}, ctx())) as { processes: R[] }
    expect(list.processes.find((p) => p.process_id === r.process_id)?.status).toBe("running")
    const killed = (await kill.execute({ process_id: r.process_id }, ctx())) as R
    expect(killed.status).toBe("killed")
  }, 20_000)
  it("an optional hard limit asked for by the agent stops the command and reports timed_out", async () => {
    const { run } = tools()
    const r = (await run.execute({ command: "sleep 5", timeout_seconds: 1 }, ctx())) as R
    expect(r.timed_out).toBe(true)
  }, 20_000)
  it("cancelling the run stops a foreground command instead of orphaning it", async () => {
    const { run, processes } = tools()
    const controller = new AbortController()
    const pending = run.execute({ command: "sleep 30" }, ctx(controller.signal)) as Promise<R>
    setTimeout(() => controller.abort(), 300)
    const r = await pending
    expect(r.status).toBe("killed")
    expect(processes.runningSummary("sess-1")).toHaveLength(0)
  }, 20_000)
  it("is not subject to the engine's default 60s tool timeout", () => {
    const { run, status } = tools()
    expect(run.timeoutMs).toBeGreaterThan(60_000)
    expect(status.timeoutMs).toBeGreaterThan(60_000)
  })
})
