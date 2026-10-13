/**
 * Long-running command management for an autonomous agent.
 *
 * A command is never killed just because it is slow. Instead:
 *  - it keeps running in the background under an id,
 *  - the agent is told when it exits (event-driven: waits resolve the moment the
 *    process closes, and a finish notice is queued for the next agent turn),
 *  - while it is still running the agent re-checks it in bounded slices (about
 *    every 60 seconds) and sees only the NEW output each time,
 *  - killing is always an explicit decision (terminal_kill), or an optional hard
 *    timeout the agent asked for.
 */
import { spawn, type ChildProcess } from "node:child_process"

export type ProcessStatus = "running" | "exited" | "killed" | "failed_to_start"

/** Output kept per stream; the tail is what an operator would look at. */
const MAX_BUFFER_CHARS = 400_000

class OutputBuffer {
  private text = ""
  /** Total characters ever produced (including those trimmed away). */
  total = 0
  /** Characters already delivered to the agent. */
  delivered = 0

  push(chunk: string): void {
    this.total += chunk.length
    this.text += chunk
    if (this.text.length > MAX_BUFFER_CHARS) this.text = this.text.slice(this.text.length - MAX_BUFFER_CHARS)
  }

  private get startOffset(): number {
    return this.total - this.text.length
  }

  /** Output the agent has not seen yet, clipped to `maxChars` (keeps the end). */
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
  /** Started with background:true or kept alive on purpose: survives the end of the run that started it. */
  detached: boolean
  startedAt: number
  endedAt?: number
  status: ProcessStatus
  exitCode?: number | null
  signal?: string | null
  error?: string
  /** Stopped by the hard limit the agent explicitly asked for. */
  timedOut?: boolean
  stdout: OutputBuffer
  stderr: OutputBuffer
  /** The finish notice was already delivered (in a tool result or a system notice). */
  announced: boolean
}

export interface StartOptions {
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  runId?: string
  sessionId?: string
  detached?: boolean
  /** Optional hard limit the agent explicitly asked for. Default: none. */
  killAfterMs?: number
}

const MAX_FINISHED_KEPT = 50

export class ProcessManager {
  private readonly processes = new Map<string, ManagedProcess>()
  private readonly children = new Map<string, ChildProcess>()
  private readonly waiters = new Map<string, Set<() => void>>()
  private counter = 0

  start(options: StartOptions): ManagedProcess {
    const id = `proc_${(++this.counter).toString(36)}_${Date.now().toString(36)}`
    const proc: ManagedProcess = {
      id,
      command: options.command,
      cwd: options.cwd,
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      detached: options.detached ?? false,
      startedAt: Date.now(),
      status: "running",
      stdout: new OutputBuffer(),
      stderr: new OutputBuffer(),
      announced: false,
    }
    this.processes.set(id, proc)
    let child: ChildProcess
    try {
      child = spawn(options.command, { cwd: options.cwd, shell: true, env: options.env, windowsHide: true, detached: process.platform !== "win32" })
    } catch (error) {
      this.finish(proc, { status: "failed_to_start", error: error instanceof Error ? error.message : String(error) })
      return proc
    }
    this.children.set(id, child)
    if (child.pid) proc.pid = child.pid
    child.stdout?.on("data", (chunk) => proc.stdout.push(chunk.toString()))
    child.stderr?.on("data", (chunk) => proc.stderr.push(chunk.toString()))
    child.on("error", (error) => this.finish(proc, { status: "failed_to_start", error: error.message }))
    // "close" fires after the process exited AND its output streams are drained: output is complete here.
    child.on("close", (code, signal) => this.finish(proc, { status: proc.status === "killed" ? "killed" : "exited", exitCode: code, signal }))
    if (options.killAfterMs && options.killAfterMs > 0) {
      const timer = setTimeout(() => {
        if (proc.status === "running") {
          proc.timedOut = true
          proc.error = `Stopped after the ${Math.round(options.killAfterMs! / 1000)}s limit the agent set for this command.`
          this.kill(id)
        }
      }, options.killAfterMs)
      ;(timer as { unref?: () => void }).unref?.()
      child.on("close", () => clearTimeout(timer))
    }
    return proc
  }

  private finish(proc: ManagedProcess, patch: { status: ProcessStatus; exitCode?: number | null; signal?: string | null; error?: string }): void {
    if (proc.endedAt) return
    proc.status = patch.status
    proc.endedAt = Date.now()
    if (patch.exitCode !== undefined) proc.exitCode = patch.exitCode
    if (patch.signal !== undefined) proc.signal = patch.signal
    if (patch.error) proc.error = patch.error
    this.children.delete(proc.id)
    for (const wake of this.waiters.get(proc.id) ?? []) wake()
    this.waiters.delete(proc.id)
    this.trim()
  }

  private trim(): void {
    const finished = [...this.processes.values()].filter((item) => item.endedAt).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0))
    for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED_KEPT))) {
      if (old.announced) this.processes.delete(old.id)
    }
  }

  get(id: string): ManagedProcess | undefined {
    return this.processes.get(id)
  }

  list(sessionId?: string): ManagedProcess[] {
    return [...this.processes.values()].filter((item) => !sessionId || item.sessionId === sessionId)
  }

  /**
   * Resolve as soon as the process exits (event-driven), or after `ms`, or when `signal` aborts.
   * Resolves true when the process is no longer running.
   */
  waitForExit(id: string, ms: number, signal?: AbortSignal): Promise<boolean> {
    const proc = this.processes.get(id)
    if (!proc || proc.status !== "running") return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let done = false
      const settle = (exited: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal?.removeEventListener("abort", onAbort)
        this.waiters.get(id)?.delete(wake)
        resolve(exited)
      }
      const wake = () => settle(true)
      const onAbort = () => settle(proc.status !== "running")
      const timer = setTimeout(() => settle(proc.status !== "running"), Math.max(0, ms))
      ;(timer as { unref?: () => void }).unref?.()
      const set = this.waiters.get(id) ?? new Set<() => void>()
      set.add(wake)
      this.waiters.set(id, set)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  kill(id: string): boolean {
    const proc = this.processes.get(id)
    const child = this.children.get(id)
    if (!proc || !child || proc.status !== "running") return false
    proc.status = "killed"
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
      else child.kill("SIGKILL")
    } catch {
      /* already exited */
    }
    return true
  }

  /** Kill the not-detached processes a run started (user pressed Stop). Background ones keep running. */
  killRunProcesses(runId: string): number {
    let killed = 0
    for (const proc of this.processes.values()) {
      if (proc.runId === runId && !proc.detached && this.kill(proc.id)) killed += 1
    }
    return killed
  }

  /**
   * Finished processes of this session the agent has not been told about yet. Used to
   * build the "system notice" at the start of the agent's next turn (or next run).
   */
  takeFinishedNotices(sessionId?: string): string[] {
    const notices: string[] = []
    for (const proc of this.processes.values()) {
      if (!proc.endedAt || proc.announced) continue
      if (sessionId && proc.sessionId && proc.sessionId !== sessionId) continue
      proc.announced = true
      notices.push(describeFinished(proc))
    }
    return notices
  }

  /** Running processes, for the model's situational awareness. */
  runningSummary(sessionId?: string): string[] {
    return this.list(sessionId)
      .filter((proc) => proc.status === "running")
      .map((proc) => `${proc.id}: "${shorten(proc.command, 80)}" running for ${Math.round((Date.now() - proc.startedAt) / 1000)}s`)
  }

  /** Stop everything still running (gateway shutdown). */
  killAll(): void {
    for (const id of [...this.children.keys()]) this.kill(id)
  }
}

export const shorten = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

export function describeFinished(proc: ManagedProcess): string {
  const seconds = Math.round(((proc.endedAt ?? Date.now()) - proc.startedAt) / 1000)
  const outcome =
    proc.status === "exited"
      ? proc.exitCode === 0
        ? "finished successfully (exit code 0)"
        : `finished with exit code ${proc.exitCode ?? "unknown"}${proc.signal ? ` (signal ${proc.signal})` : ""}`
      : proc.status === "killed"
        ? `was stopped${proc.error ? `: ${proc.error}` : ""}`
        : `could not start: ${proc.error ?? "unknown error"}`
  return `Command ${proc.id} ("${shorten(proc.command, 80)}") ${outcome} after ${seconds}s. Call terminal_status with process_id "${proc.id}" to read its output.`
}
