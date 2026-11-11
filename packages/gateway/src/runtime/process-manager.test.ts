import { describe, expect, it } from "@jest/globals"
import { mkdtempSync, existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import Database from "better-sqlite3"
import { ProcessManager } from "./process-manager.js"
import { createTerminalTools } from "../plugins/tools/terminal-tool.js"

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
  it("calls onExit once when the command finishes, is killed, or cannot start", async () => {
    const pm = new ProcessManager()
    let calls = 0
    const onExit = () => { calls += 1 }
    const done = pm.start({ command: "echo hi", cwd: cwd(), env: process.env, onExit })
    await pm.waitForExit(done.id, 5000)
    expect(calls).toBe(1)
    const slow = pm.start({ command: "sleep 30", cwd: cwd(), env: process.env, onExit })
    pm.kill(slow.id)
    // kill() marks the process killed at once; the OS reports the exit a moment later.
    for (let waited = 0; calls < 2 && waited < 5000; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(calls).toBe(2)
    const broken = pm.start({ command: "echo hi", cwd: path.join(os.tmpdir(), "miki-does-not-exist-xyz"), env: process.env, onExit })
    await pm.waitForExit(broken.id, 5000)
    for (let waited = 0; calls < 3 && waited < 5000; waited += 25) await new Promise((resolve) => setTimeout(resolve, 25))
    expect(calls).toBe(3)
  })
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
  it("adds the exit-code path column to databases created by older versions", async () => {
    const dir = cwd()
    const db = new Database(path.join(dir, "legacy.sqlite"))
    db.exec(`CREATE TABLE miki_background_processes (
      process_id TEXT PRIMARY KEY, command TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER,
      run_id TEXT, session_id TEXT, detached INTEGER NOT NULL DEFAULT 0,
      started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL,
      exit_code INTEGER, signal TEXT, error TEXT, timed_out INTEGER NOT NULL DEFAULT 0,
      announced INTEGER NOT NULL DEFAULT 0, stdout_path TEXT, stderr_path TEXT,
      stdout_observed_bytes INTEGER NOT NULL DEFAULT 0, stderr_observed_bytes INTEGER NOT NULL DEFAULT 0,
      stdout_total_chars INTEGER NOT NULL DEFAULT 0, stderr_total_chars INTEGER NOT NULL DEFAULT 0,
      stdout_delivered_chars INTEGER NOT NULL DEFAULT 0, stderr_delivered_chars INTEGER NOT NULL DEFAULT 0,
      pid_start_token TEXT
    )`)
    const manager = new ProcessManager({ db, dataRoot: dir })
    const columns = db.prepare("PRAGMA table_info(miki_background_processes)").all() as Array<{ name: string }>
    expect(columns.some((column) => column.name === "exit_code_path")).toBe(true)
    await manager.close()
    db.close()
  })

  it("restores every active process instead of applying the terminal-history page size", async () => {
    const dir = cwd()
    const db = new Database(path.join(dir, "many-processes.sqlite"))
    const seed = new ProcessManager({ db, dataRoot: dir })
    const insert = db.prepare(`INSERT INTO miki_background_processes
      (process_id,command,cwd,detached,started_at,status,announced,stdout_observed_bytes,stderr_observed_bytes,
       stdout_total_chars,stderr_total_chars,stdout_delivered_chars,stderr_delivered_chars)
      VALUES(?,?,?,?,?,'running',0,0,0,0,0,0,0)`)
    for (let index = 0; index < 510; index++) {
      insert.run(`restored-${index}`, "unverifiable", dir, 1, Date.now() + index)
    }
    await seed.close()
    const restored = new ProcessManager({ db, dataRoot: dir })
    expect(restored.list()).toHaveLength(510)
    expect(restored.list().every((proc) => proc.status === "interrupted")).toBe(true)
    await restored.close()
    db.close()
  })

  it("persists detached jobs and recovers the real exit code without re-running the command", async () => {
    const dir = cwd()
    const dbFile = path.join(dir, "miki.sqlite")
    const db1 = new Database(dbFile)
    const first = new ProcessManager({ db: db1, dataRoot: dir, pollMs: 100 })
    const marker = path.join(dir, "ran-once.txt")
    const command = `sleep 2; printf 'persisted-output'; printf 'ran' >> '${marker.replace(/'/g, "'\\''")}' ; exit 7`
    const proc = first.start({ command, cwd: dir, env: process.env, detached: true, sessionId: "durable-session" })
    expect(proc.pid).toBeGreaterThan(0)
    await first.close()
    db1.close()

    // The original gateway manager is closed, but its detached process continues.
    const db2 = new Database(dbFile)
    const second = new ProcessManager({ db: db2, dataRoot: dir, pollMs: 100 })
    const recovered = second.get(proc.id)
    expect(recovered).toBeDefined()
    expect(recovered?.status).toBe("running")
    expect(await second.waitForExit(proc.id, 8_000)).toBe(true)
    expect(recovered?.status).toBe("exited")
    expect(recovered?.exitCode).toBe(7)
    expect(recovered?.stdout.takeNew(200).text).toContain("persisted-output")
    expect(existsSync(marker)).toBe(true)
    expect((await import("node:fs")).readFileSync(marker, "utf8")).toBe("ran")
    await second.close()
    db2.close()
  }, 15_000)
  it("recovers a command that completed while the gateway was offline", async () => {
    const dir = cwd()
    const dbFile = path.join(dir, "miki.sqlite")
    const db1 = new Database(dbFile)
    const first = new ProcessManager({ db: db1, dataRoot: dir, pollMs: 100 })
    const proc = first.start({ command: "sleep 0.5; printf offline-finished; exit 9", cwd: dir, env: process.env, detached: true })
    await first.close()
    db1.close()
    await new Promise((resolve) => setTimeout(resolve, 1_000))

    const db2 = new Database(dbFile)
    const second = new ProcessManager({ db: db2, dataRoot: dir, pollMs: 100 })
    const recovered = second.get(proc.id)
    expect(recovered?.status).toBe("exited")
    expect(recovered?.exitCode).toBe(9)
    expect(recovered?.stdout.takeNew(200).text).toContain("offline-finished")
    await second.close()
    db2.close()
  }, 10_000)

  it("marks an un-verifiable process as interrupted and never replays it", async () => {
    const dir = cwd()
    const dbFile = path.join(dir, "miki.sqlite")
    const db1 = new Database(dbFile)
    const first = new ProcessManager({ db: db1, dataRoot: dir })
    const proc = first.start({ command: "sleep 30", cwd: dir, env: process.env, detached: true })
    await first.close()
    db1.prepare("UPDATE miki_background_processes SET pid=99999999,pid_start_token='not-a-real-process' WHERE process_id=?").run(proc.id)
    db1.close()
    const db2 = new Database(dbFile)
    const second = new ProcessManager({ db: db2, dataRoot: dir })
    expect(second.get(proc.id)?.status).toBe("interrupted")
    expect(second.get(proc.id)?.error).toMatch(/was not re-executed/)
    // Clean up the original detached command without relying on the deliberately corrupted PID.
    if (proc.pid) {
      try {
        if (process.platform === "win32") execFileSync("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
        else process.kill(-proc.pid, "SIGKILL")
      } catch { /* already exited */ }
    }
    await second.close()
    db2.close()
  }, 10_000)

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
