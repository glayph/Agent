/**
 * Long-running command management for Miki.
 *
 * When a SQLite database and data directory are supplied, commands are durable:
 * process metadata and output cursors are persisted, stdout/stderr are written to
 * bounded log files, and a new gateway process reattaches to a still-live command
 * instead of executing it again. A process which cannot be proven to be the same
 * process is marked interrupted rather than risking a signal to a reused PID.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import {
  closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync,
} from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import crypto from "node:crypto"
import type Database from "better-sqlite3"

export type ProcessStatus = "running" | "exited" | "killed" | "failed_to_start" | "interrupted"

const MAX_BUFFER_CHARS = 400_000
const MAX_PERSISTED_LOG_BYTES = 4 * 1024 * 1024
const MAX_FINISHED_KEPT = 50
const PROCESS_POLL_MS = 500

// The supervisor is a separate, detached process. It runs the requested command
// with the same shell semantics, inherits output streams, and atomically records
// the exit code. It therefore survives gateway shutdown on all supported OSes.
const PROCESS_SUPERVISOR_SCRIPT = String.raw`const { spawn } = require("node:child_process");
const { writeFileSync, renameSync, readFileSync, unlinkSync } = require("node:fs");
const commandPath = process.env.MIKI_MANAGED_COMMAND_PATH || "";
const exitPath = process.env.MIKI_MANAGED_EXIT_CODE_PATH || "";
const childEnv = { ...process.env };
delete childEnv.MIKI_MANAGED_COMMAND_PATH;
delete childEnv.MIKI_MANAGED_EXIT_CODE_PATH;
let child;
let recorded = false;
function recordExit(code) {
  if (recorded) return;
  recorded = true;
  if (exitPath) {
    const temp = exitPath + ".tmp-" + process.pid;
    try { writeFileSync(temp, String(code), { mode: 0o600 }); renameSync(temp, exitPath); }
    catch (error) { try { process.stderr.write("Miki could not persist command exit status: " + error.message + "\n"); } catch {} }
  }
  process.exitCode = code;
}
try {
  const command = readFileSync(commandPath, "utf8");
  try { unlinkSync(commandPath); } catch {}
  child = spawn(command, { cwd: process.cwd(), env: childEnv, shell: true, windowsHide: true, stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => { try { child.kill(signal); } catch {} });
  child.once("error", (error) => { try { process.stderr.write(String(error.message || error) + "\n"); } catch {} recordExit(127); });
  child.once("close", (code, signal) => {
    const signalCodes = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGKILL: 137 };
    recordExit(Number.isInteger(code) ? code : (signalCodes[signal] || 1));
  });
} catch (error) {
  try { process.stderr.write(String(error.message || error) + "\n"); } catch {}
  recordExit(127);
}`

class OutputBuffer {
  private text = ""
  total = 0
  delivered = 0

  constructor(snapshot?: { text?: string; total?: number; delivered?: number }) {
    if (!snapshot) return
    const text = snapshot.text ?? ""
    this.total = Math.max(text.length, Number(snapshot.total ?? text.length) || 0)
    this.text = text.slice(-MAX_BUFFER_CHARS)
    this.delivered = Math.max(0, Math.min(this.total, Number(snapshot.delivered ?? 0) || 0))
  }

  push(chunk: string): void {
    if (!chunk) return
    this.total += chunk.length
    this.text += chunk
    if (this.text.length > MAX_BUFFER_CHARS) this.text = this.text.slice(this.text.length - MAX_BUFFER_CHARS)
  }

  private get startOffset(): number {
    return this.total - this.text.length
  }

  takeNew(maxChars: number): { text: string; omitted: number } {
    const from = Math.max(this.delivered, this.startOffset)
    let omitted = from - this.delivered
    let slice = this.text.slice(from - this.startOffset)
    if (slice.length > maxChars) {
      omitted += slice.length - maxChars
      slice = slice.slice(slice.length - maxChars)
    }
    this.delivered = this.total
    return { text: slice, omitted }
  }

  tail(maxChars: number): string {
    return this.text.length > maxChars ? this.text.slice(this.text.length - maxChars) : this.text
  }
}

export interface ManagedProcess {
  id: string
  command: string
  cwd: string
  pid?: number
  runId?: string
  sessionId?: string
  detached: boolean
  startedAt: number
  endedAt?: number
  status: ProcessStatus
  exitCode?: number | null
  signal?: string | null
  error?: string
  timedOut?: boolean
  stdout: OutputBuffer
  stderr: OutputBuffer
  announced: boolean
  stdoutLogPath?: string
  stderrLogPath?: string
  exitCodePath?: string
  stdoutObservedBytes: number
  stderrObservedBytes: number
  pidStartToken?: string
}

export interface StartOptions {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  runId?: string
  sessionId?: string
  detached?: boolean
  killAfterMs?: number
  onExit?: () => void
}

export interface ProcessManagerOptions {
  db?: Database.Database
  dataRoot?: string
  pollMs?: number
  log?: (message: string, details?: Record<string, unknown>) => void
}

type ProcessRow = {
  process_id: string; command: string; cwd: string; pid: number | null; run_id: string | null;
  session_id: string | null; detached: number; started_at: number; ended_at: number | null;
  status: ProcessStatus; exit_code: number | null; signal: string | null; error: string | null;
  timed_out: number; announced: number; stdout_path: string | null; stderr_path: string | null;
  stdout_observed_bytes: number; stderr_observed_bytes: number; stdout_total_chars: number;
  stderr_total_chars: number; stdout_delivered_chars: number; stderr_delivered_chars: number;
  pid_start_token: string | null; exit_code_path: string | null;
}

function linuxProcessIdentity(pid: number): { startToken: string; environment: string } | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    const end = stat.lastIndexOf(")")
    if (end < 0) return undefined
    const fields = stat.slice(end + 2).trim().split(/\s+/)
    const startToken = fields[19]
    if (!startToken) return undefined
    const environment = readFileSync(`/proc/${pid}/environ`, "utf8")
    return { startToken, environment }
  } catch {
    return undefined
  }
}

function externalProcessIdentity(pid: number): { startToken: string; commandLine: string } | undefined {
  try {
    if (process.platform === "win32") {
      const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if ($p) { [pscustomobject]@{Created=[string]$p.CreationDate;CommandLine=[string]$p.CommandLine} | ConvertTo-Json -Compress }`
      const raw = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: 4_000, windowsHide: true }).trim()
      if (!raw) return undefined
      const value = JSON.parse(raw) as { Created?: string; CommandLine?: string }
      if (!value.Created || !value.CommandLine) return undefined
      return { startToken: value.Created, commandLine: value.CommandLine }
    }
    const startToken = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", timeout: 2_000 }).trim()
    const commandLine = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", timeout: 2_000 }).trim()
    if (!startToken || !commandLine) return undefined
    return { startToken, commandLine }
  } catch {
    return undefined
  }
}

function getProcessStartToken(pid: number): string | undefined {
  if (process.platform === "linux") return linuxProcessIdentity(pid)?.startToken
  return externalProcessIdentity(pid)?.startToken
}

function processMatches(pid: number, id: string, token?: string, legacyCommand?: string): boolean {
  try { process.kill(pid, 0) } catch { return false }
  if (!token) return false
  if (process.platform === "linux") {
    const identity = linuxProcessIdentity(pid)
    return Boolean(identity && identity.startToken === token && identity.environment.split("\0").includes(`MIKI_MANAGED_PROCESS_ID=${id}`))
  }
  const identity = externalProcessIdentity(pid)
  if (!identity || identity.startToken !== token) return false
  // New supervisors receive the random process id as argv[1]. For a process
  // created by the previous release, retain the old command-line check, but only
  // after the exact process creation token has matched.
  return identity.commandLine.includes(id) || Boolean(legacyCommand && identity.commandLine.includes(legacyCommand.slice(0, 80)))
}

function readTail(file: string | undefined, maxBytes = MAX_PERSISTED_LOG_BYTES): string {
  if (!file) return ""
  try {
    const size = statSync(file).size
    const fd = openSync(file, "r")
    try {
      const length = Math.min(size, maxBytes)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, Math.max(0, size - length))
      return buffer.toString("utf8")
    } finally { closeSync(fd) }
  } catch { return "" }
}

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>()
  private readonly children = new Map<string, ChildProcess>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private readonly db?: Database.Database
  private readonly logDir?: string
  private readonly log?: ProcessManagerOptions["log"]
  private readonly pollMs: number
  private pollTimer?: ReturnType<typeof setInterval>
  private closed = false

  constructor(options: ProcessManagerOptions = {}) {
    this.db = options.db
    this.log = options.log
    this.pollMs = Math.max(100, Math.min(5_000, options.pollMs ?? PROCESS_POLL_MS))
    if (this.db && options.dataRoot) {
      this.logDir = path.join(options.dataRoot, "process-logs")
      mkdirSync(this.logDir, { recursive: true })
      this.initializeStore()
      this.restore()
      this.pollTimer = setInterval(() => this.refreshRunning(), this.pollMs)
      this.pollTimer.unref?.()
    }
  }

  private initializeStore(): void {
    this.db!.exec(`
      CREATE TABLE IF NOT EXISTS miki_background_processes (
        process_id TEXT PRIMARY KEY, command TEXT NOT NULL, cwd TEXT NOT NULL, pid INTEGER,
        run_id TEXT, session_id TEXT, detached INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL,
        exit_code INTEGER, signal TEXT, error TEXT, timed_out INTEGER NOT NULL DEFAULT 0,
        announced INTEGER NOT NULL DEFAULT 0, stdout_path TEXT, stderr_path TEXT,
        stdout_observed_bytes INTEGER NOT NULL DEFAULT 0, stderr_observed_bytes INTEGER NOT NULL DEFAULT 0,
        stdout_total_chars INTEGER NOT NULL DEFAULT 0, stderr_total_chars INTEGER NOT NULL DEFAULT 0,
        stdout_delivered_chars INTEGER NOT NULL DEFAULT 0, stderr_delivered_chars INTEGER NOT NULL DEFAULT 0,
        pid_start_token TEXT, exit_code_path TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_miki_background_process_session
        ON miki_background_processes(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_miki_background_process_status
        ON miki_background_processes(status, started_at DESC);
    `)
    // Existing installations created by an earlier version need a safe additive migration.
    const columns = this.db!.prepare("PRAGMA table_info(miki_background_processes)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "exit_code_path")) {
      this.db!.exec("ALTER TABLE miki_background_processes ADD COLUMN exit_code_path TEXT")
    }
  }

  private persist(proc: ManagedProcess): void {
    if (!this.db) return
    this.db.prepare(`
      INSERT INTO miki_background_processes (
        process_id,command,cwd,pid,run_id,session_id,detached,started_at,ended_at,status,
        exit_code,signal,error,timed_out,announced,stdout_path,stderr_path,stdout_observed_bytes,
        stderr_observed_bytes,stdout_total_chars,stderr_total_chars,stdout_delivered_chars,
        stderr_delivered_chars,pid_start_token,exit_code_path
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(process_id) DO UPDATE SET
        pid=excluded.pid,ended_at=excluded.ended_at,status=excluded.status,exit_code=excluded.exit_code,
        signal=excluded.signal,error=excluded.error,timed_out=excluded.timed_out,announced=excluded.announced,
        stdout_observed_bytes=excluded.stdout_observed_bytes,stderr_observed_bytes=excluded.stderr_observed_bytes,
        stdout_total_chars=excluded.stdout_total_chars,stderr_total_chars=excluded.stderr_total_chars,
        stdout_delivered_chars=excluded.stdout_delivered_chars,stderr_delivered_chars=excluded.stderr_delivered_chars,
        pid_start_token=excluded.pid_start_token,exit_code_path=excluded.exit_code_path
    `).run(
      proc.id, proc.command, proc.cwd, proc.pid ?? null, proc.runId ?? null, proc.sessionId ?? null,
      proc.detached ? 1 : 0, proc.startedAt, proc.endedAt ?? null, proc.status,
      proc.exitCode ?? null, proc.signal ?? null, proc.error ?? null, proc.timedOut ? 1 : 0,
      proc.announced ? 1 : 0, proc.stdoutLogPath ?? null, proc.stderrLogPath ?? null,
      proc.stdoutObservedBytes, proc.stderrObservedBytes, proc.stdout.total, proc.stderr.total,
      proc.stdout.delivered, proc.stderr.delivered, proc.pidStartToken ?? null, proc.exitCodePath ?? null,
    )
  }

  private readExitCode(proc: ManagedProcess): number | undefined {
    if (!proc.exitCodePath) return undefined
    try {
      const raw = readFileSync(proc.exitCodePath, "utf8").trim()
      if (!/^-?\d+$/.test(raw)) return undefined
      const value = Number(raw)
      return Number.isSafeInteger(value) && value >= 0 && value <= 0xFFFFFFFF ? value : undefined
    } catch { return undefined }
  }

  private restore(): void {
    if (!this.db) return
    // Never hide a live, detached process behind a UI/history page-size limit.
    // Reattach every running PID first; only terminal history is bounded in memory.
    const runningRows = this.db.prepare(`SELECT * FROM miki_background_processes
      WHERE status='running' ORDER BY started_at ASC`).all() as ProcessRow[]
    const terminalRows = this.db.prepare(`SELECT * FROM miki_background_processes
      WHERE status!='running' ORDER BY started_at DESC LIMIT 500`).all() as ProcessRow[]
    for (const row of [...runningRows, ...terminalRows]) {
      const id = row.process_id
      const proc: ManagedProcess = {
        id, command: row.command, cwd: row.cwd, ...(row.pid ? { pid: row.pid } : {}),
        ...(row.run_id ? { runId: row.run_id } : {}), ...(row.session_id ? { sessionId: row.session_id } : {}),
        detached: row.detached === 1, startedAt: row.started_at, ...(row.ended_at ? { endedAt: row.ended_at } : {}),
        status: row.status, ...(row.exit_code !== null ? { exitCode: row.exit_code } : {}),
        ...(row.signal ? { signal: row.signal } : {}), ...(row.error ? { error: row.error } : {}),
        ...(row.timed_out ? { timedOut: true } : {}), announced: row.announced === 1,
        stdoutLogPath: row.stdout_path ?? undefined, stderrLogPath: row.stderr_path ?? undefined,
        exitCodePath: row.exit_code_path ?? undefined,
        stdoutObservedBytes: row.stdout_observed_bytes, stderrObservedBytes: row.stderr_observed_bytes,
        pidStartToken: row.pid_start_token ?? undefined,
        stdout: new OutputBuffer({ text: readTail(row.stdout_path), total: row.stdout_total_chars, delivered: row.stdout_delivered_chars }),
        stderr: new OutputBuffer({ text: readTail(row.stderr_path), total: row.stderr_total_chars, delivered: row.stderr_delivered_chars }),
      }
      if (proc.status === "running") {
        if (proc.pid && processMatches(proc.pid, proc.id, proc.pidStartToken, proc.command)) {
          // A durable process is reattached, not re-executed. Output is read from its
          // existing log files, and completion is detected by PID identity polling.
          this.processes.set(id, proc)
          this.syncOutput(proc)
        } else {
          const exitCode = this.readExitCode(proc)
          if (exitCode !== undefined) this.finish(proc, { status: "exited", exitCode })
          else this.finish(proc, { status: "interrupted", error: "Miki restarted while this command was active; the process is no longer verifiably running. The command was not re-executed." })
          this.processes.set(id, proc)
        }
      } else {
        this.processes.set(id, proc)
      }
    }
    this.trim()
  }

  start(options: StartOptions): ManagedProcess {
    if (this.closed) throw new Error("ProcessManager is closed.")
    const id = `proc_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`
    const stdoutLogPath = this.logDir ? path.join(this.logDir, `${id}.stdout.log`) : undefined
    const stderrLogPath = this.logDir ? path.join(this.logDir, `${id}.stderr.log`) : undefined
    const exitCodePath = this.logDir ? path.join(this.logDir, `${id}.exit-code`) : undefined
    const commandPath = path.join(this.logDir ?? tmpdir(), `${id}.command`)
    if (exitCodePath) { try { unlinkSync(exitCodePath) } catch { /* stale id collision is extraordinarily unlikely */ } }
    if (stdoutLogPath) writeFileSync(stdoutLogPath, "", { mode: 0o600 })
    if (stderrLogPath) writeFileSync(stderrLogPath, "", { mode: 0o600 })
    const proc: ManagedProcess = {
      id, command: options.command, cwd: options.cwd,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      detached: options.detached ?? false, startedAt: Date.now(), status: "running",
      stdout: new OutputBuffer(), stderr: new OutputBuffer(), announced: false,
      stdoutLogPath, stderrLogPath, exitCodePath, stdoutObservedBytes: 0, stderrObservedBytes: 0,
    }
    this.processes.set(id, proc)
    this.persist(proc)
    let exitNotified = false
    const notifyExit = () => {
      if (exitNotified) return
      exitNotified = true
      try { options.onExit?.() } catch { /* cleanup is best effort */ }
    }
    let child: ChildProcess
    let stdoutFd: number | undefined
    let stderrFd: number | undefined
    try {
      writeFileSync(commandPath, options.command, { mode: 0o600 })
      const env = {
        ...options.env,
        MIKI_MANAGED_PROCESS_ID: id,
        MIKI_MANAGED_COMMAND_PATH: commandPath,
        MIKI_MANAGED_EXIT_CODE_PATH: exitCodePath ?? "",
      }
      if (stdoutLogPath && stderrLogPath) {
        stdoutFd = openSync(stdoutLogPath, "a")
        stderrFd = openSync(stderrLogPath, "a")
      }
      child = spawn(process.execPath, ["-e", PROCESS_SUPERVISOR_SCRIPT, id], {
        cwd: options.cwd,
        env,
        windowsHide: true,
        // A detached process group/job lets explicit background work survive a
        // gateway restart; kill() still terminates its entire process tree.
        detached: true,
        stdio: ["ignore", stdoutFd ?? "pipe", stderrFd ?? "pipe"],
      })
    } catch (error) {
      try { unlinkSync(commandPath) } catch { /* supervisor may already have consumed it */ }
      this.finish(proc, { status: "failed_to_start", error: error instanceof Error ? error.message : String(error) })
      notifyExit()
      return proc
    } finally {
      if (stdoutFd !== undefined) closeSync(stdoutFd)
      if (stderrFd !== undefined) closeSync(stderrFd)
    }
    this.children.set(id, child)
    if (child.pid) {
      proc.pid = child.pid
      proc.pidStartToken = getProcessStartToken(child.pid)
    }
    this.persist(proc)
    if (!stdoutLogPath) child.stdout?.on("data", (chunk) => proc.stdout.push(chunk.toString()))
    if (!stderrLogPath) child.stderr?.on("data", (chunk) => proc.stderr.push(chunk.toString()))
    child.on("error", (error) => {
      try { unlinkSync(commandPath) } catch { /* already consumed by the supervisor */ }
      if (this.closed) return
      this.finish(proc, { status: "failed_to_start", error: error.message })
      notifyExit()
    })
    child.on("close", (code, signal) => {
      try { unlinkSync(commandPath) } catch { /* supervisor normally removed it on startup */ }
      if (this.closed) return
      this.syncOutput(proc)
      this.finish(proc, { status: proc.status === "killed" ? "killed" : "exited", exitCode: code, signal })
      notifyExit()
    })
    if (options.detached) child.unref()
    if (Number.isFinite(options.killAfterMs) && options.killAfterMs! > 0) {
      const killAfterMs = Math.max(1, Math.floor(options.killAfterMs!))
      const deadline = Date.now() + killAfterMs
      let timer: ReturnType<typeof setTimeout> | undefined
      const checkDeadline = () => {
        if (proc.status !== "running") return
        const remaining = deadline - Date.now()
        if (remaining <= 0) {
          proc.timedOut = true
          proc.error = `Stopped after the ${Math.round(killAfterMs / 1000)}s limit the agent set for this command.`
          this.persist(proc)
          this.kill(id)
          return
        }
        // Node timers overflow above 2^31-1 ms; re-arm in safe slices so an
        // intentionally long explicit deadline is honoured rather than firing early.
        timer = setTimeout(checkDeadline, Math.min(remaining, 2_000_000_000))
        timer.unref?.()
      }
      checkDeadline()
      child.on("close", () => { if (timer) clearTimeout(timer) })
    }
    return proc
  }

  private syncOutput(proc: ManagedProcess): void {
    const readNew = (file: string | undefined, offset: number): { text: string; nextOffset: number } => {
      if (!file) return { text: "", nextOffset: offset }
      try {
        const size = statSync(file).size
        if (size < offset) offset = 0
        if (size <= offset) return { text: "", nextOffset: offset }
        const fd = openSync(file, "r")
        try {
          const length = size - offset
          const buffer = Buffer.alloc(length)
          const read = readSync(fd, buffer, 0, length, offset)
          return { text: buffer.subarray(0, read).toString("utf8"), nextOffset: size }
        } finally { closeSync(fd) }
      } catch { return { text: "", nextOffset: offset } }
    }
    const previousOutOffset = proc.stdoutObservedBytes
    const previousErrOffset = proc.stderrObservedBytes
    const out = readNew(proc.stdoutLogPath, proc.stdoutObservedBytes)
    const err = readNew(proc.stderrLogPath, proc.stderrObservedBytes)
    proc.stdout.push(out.text); proc.stderr.push(err.text)
    proc.stdoutObservedBytes = out.nextOffset; proc.stderrObservedBytes = err.nextOffset
    // Cap disk use per stream while preserving the newest output and cumulative
    // character offsets in SQLite so the agent sees an explicit omitted count.
    for (const file of [proc.stdoutLogPath, proc.stderrLogPath]) {
      if (!file) continue
      try {
        const size = statSync(file).size
        if (size > MAX_PERSISTED_LOG_BYTES) {
          const text = readTail(file, MAX_PERSISTED_LOG_BYTES)
          writeFileSync(file, text, { mode: 0o600 })
          const nextSize = statSync(file).size
          if (file === proc.stdoutLogPath) proc.stdoutObservedBytes = nextSize
          else proc.stderrObservedBytes = nextSize
        }
      } catch { /* a missing log is not fatal to the process */ }
    }
    if (out.text || err.text || previousOutOffset !== proc.stdoutObservedBytes || previousErrOffset !== proc.stderrObservedBytes) {
      this.persist(proc)
    }
  }

  refresh(proc: ManagedProcess): void {
    if (proc.status === "running") this.syncOutput(proc)
  }

  /** Persist output delivery cursors after a tool result has consumed fresh output. */
  save(proc: ManagedProcess): void {
    this.persist(proc)
  }

  private refreshRunning(): void {
    if (this.closed) return
    for (const proc of this.processes.values()) {
      if (proc.status !== "running") continue
      this.syncOutput(proc)
      if (this.children.has(proc.id)) {
        if (!proc.pidStartToken && proc.pid) {
          proc.pidStartToken = getProcessStartToken(proc.pid)
          this.persist(proc)
        }
        continue
      }
      if (!proc.pid || !processMatches(proc.pid, proc.id, proc.pidStartToken, proc.command)) {
        const exitCode = this.readExitCode(proc)
        if (exitCode !== undefined) this.finish(proc, { status: "exited", exitCode })
        else this.finish(proc, { status: "interrupted", error: "Managed process ended while Miki was offline or could no longer be verified. The command was not re-executed." })
      }
    }
  }

  private finish(proc: ManagedProcess, patch: { status: ProcessStatus; exitCode?: number | null; signal?: string | null; error?: string }): void {
    if (proc.endedAt) return
    proc.status = patch.status
    proc.endedAt = Date.now()
    if (patch.exitCode !== undefined) proc.exitCode = patch.exitCode
    if (patch.signal !== undefined) proc.signal = patch.signal
    if (patch.error) proc.error = patch.error
    this.children.delete(proc.id)
    this.persist(proc)
    for (const wake of this.waiters.get(proc.id) ?? []) wake()
    this.waiters.delete(proc.id)
    this.trim()
  }

  private trim(): void {
    const finished = [...this.processes.values()].filter((item) => item.endedAt).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_KEPT))) {
      if (!old.announced) continue
      this.processes.delete(old.id)
      if (this.db) this.db.prepare("DELETE FROM miki_background_processes WHERE process_id=?").run(old.id)
      for (const file of [old.stdoutLogPath, old.stderrLogPath, old.exitCodePath]) if (file) { try { unlinkSync(file) } catch { /* best effort */ } }
    }
  }

  get(id: string): ManagedProcess | undefined {
    const proc = this.processes.get(id)
    if (proc) this.refresh(proc)
    return proc
  }

  list(sessionId?: string): ManagedProcess[] {
    const values = [...this.processes.values()].filter((item) => !sessionId || item.sessionId === sessionId)
    for (const proc of values) this.refresh(proc)
    return values
  }

  waitForExit(id: string, ms: number, signal?: AbortSignal): Promise<boolean> {
    const proc = this.processes.get(id)
    if (!proc || proc.status !== "running") return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let done = false
      const settle = (exited: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearInterval(poll)
        signal?.removeEventListener("abort", onAbort)
        this.waiters.get(id)?.delete(wake)
        resolve(exited)
      }
      const wake = () => settle(true)
      const onAbort = () => settle(proc.status !== "running")
      const timer = setTimeout(() => settle(proc.status !== "running"), Math.max(0, ms))
      const poll = setInterval(() => {
        this.refreshRunning()
        if (proc.status !== "running") settle(true)
      }, this.pollMs)
      timer.unref?.(); poll.unref?.()
      const set = this.waiters.get(id) ?? new Set<() => void>()
      set.add(wake); this.waiters.set(id, set)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  kill(id: string): boolean {
    const proc = this.processes.get(id)
    if (!proc || proc.status !== "running" || !proc.pid) return false
    if (!this.children.has(id) && !processMatches(proc.pid, id, proc.pidStartToken, proc.command)) return false
    try {
      if (process.platform !== "win32") process.kill(-proc.pid, "SIGKILL")
      else execFileSync("taskkill.exe", ["/PID", String(proc.pid), "/T", "/F"], { timeout: 5_000, windowsHide: true, stdio: "ignore" })
      proc.status = "killed"
      if (!this.children.has(id)) this.finish(proc, { status: "killed" })
      else this.persist(proc)
      return true
    } catch (error) {
      this.log?.("process.kill_failed", { processId: id, error: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  killRunProcesses(runId: string): number {
    let killed = 0
    for (const proc of this.processes.values()) if (proc.runId === runId && !proc.detached && this.kill(proc.id)) killed += 1
    return killed
  }

  takeFinishedNotices(sessionId?: string): string[] {
    const notices: string[] = []
    for (const proc of this.processes.values()) {
      if (!proc.endedAt || proc.announced) continue
      if (sessionId && proc.sessionId && proc.sessionId !== sessionId) continue
      proc.announced = true
      this.persist(proc)
      notices.push(describeFinished(proc))
    }
    this.trim()
    return notices
  }

  runningSummary(sessionId?: string): string[] {
    return this.list(sessionId).filter((proc) => proc.status === "running")
      .map((proc) => `${proc.id}: "${shorten(proc.command, 80)}" running for ${Math.round((Date.now() - proc.startedAt) / 1000)}s`)
  }

  /** Stop foreground processes only. Explicit background jobs survive a graceful gateway shutdown. */
  killAll(): void {
    for (const proc of this.processes.values()) if (!proc.detached) this.kill(proc.id)
  }

  /** Stop foreground work, then close watchers while preserving explicit background jobs. */
  async close(): Promise<void> {
    if (this.closed) return
    this.killAll()
    const deadline = Date.now() + 4_000
    while (Date.now() < deadline) {
      const foregroundStillAttached = [...this.children.keys()].some((id) => !this.processes.get(id)?.detached)
      if (!foregroundStillAttached) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    // Flush durable state and establish a verifiable PID identity before the parent
    // gateway exits. Otherwise a very fast shutdown could leave a live child that
    // cannot safely be adopted by the next gateway process.
    for (const [id, child] of this.children) {
      const proc = this.processes.get(id)
      if (proc?.detached) {
        if (!proc.pidStartToken && proc.pid) {
          const tokenDeadline = Date.now() + 1_000
          while (!proc.pidStartToken && Date.now() < tokenDeadline) {
            proc.pidStartToken = getProcessStartToken(proc.pid)
            if (!proc.pidStartToken) await new Promise((resolve) => setTimeout(resolve, 25))
          }
        }
        this.syncOutput(proc)
        this.persist(proc)
        child.unref()
      } else if (proc && proc.status === "killed" && !proc.endedAt) {
        this.finish(proc, { status: "killed", error: proc.error ?? "Stopped during gateway shutdown." })
      }
    }
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = undefined
    this.closed = true
  }
}

export const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function describeFinished(proc: ManagedProcess): string {
  const seconds = Math.round(((proc.endedAt ?? Date.now()) - proc.startedAt) / 1000)
  const outcome = proc.status === "exited"
    ? proc.exitCode === 0 ? "finished successfully (exit code 0)" : `finished with exit code ${proc.exitCode ?? "unknown"}${proc.signal ? ` (signal ${proc.signal})` : ""}`
    : proc.status === "killed" ? `was stopped${proc.error ? `: ${proc.error}` : ""}`
      : proc.status === "interrupted" ? `was interrupted while Miki was offline${proc.error ? `: ${proc.error}` : ""}`
        : `could not start: ${proc.error ?? "unknown error"}`
  return `Command ${proc.id} ("${shorten(proc.command, 80)}") ${outcome} after ${seconds}s. Call terminal_status with process_id "${proc.id}" to read its output.`
}
