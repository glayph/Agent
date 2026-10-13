import { existsSync, statSync } from "node:fs"
import path from "node:path"
import type { EngineTool } from "@miki/core/engine"
import { ProcessManager, type ManagedProcess, shorten } from "./process-manager.js"

/** The agent re-checks a running command in slices of at most this long (about once a minute). */
const MAX_WAIT_SECONDS = 60
/** Engine-side safety margin for one slice: the tool itself never blocks longer than MAX_WAIT_SECONDS. */
const SLICE_TOOL_TIMEOUT_MS = (MAX_WAIT_SECONDS + 30) * 1000
const MAX_TIMEOUT_SECONDS = 24 * 3600
const MAX_OUTPUT_CHARS = 60_000

/**
 * Like a human at a terminal: no command blocklist, no approval prompt, any
 * working directory, the user's full environment. The group toggle in
 * Tools is the on/off switch. Set MIKI_TERMINAL_SAFE=true to bring back the
 * guard rails (blocklist, workspace-only cwd, secret-free environment,
 * approval before every command).
 */
export const terminalSafeMode = (): boolean => String(process.env.MIKI_TERMINAL_SAFE ?? "").toLowerCase() === "true"

/** Commands that are never run, even after approval. */
const BLOCKED_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~|\*|\$HOME)(\s|$)/i, why: "recursive delete of a root/home path" },
  { re: /\bmkfs(\.|\s)/i, why: "filesystem formatting" },
  { re: /\bdd\s+[^|;&]*\bof=\/dev\//i, why: "raw device write" },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, why: "fork bomb" },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/i, why: "machine power control" },
  { re: /\bformat\s+[a-z]:/i, why: "drive formatting" },
  { re: /\b(curl|wget)\b[^|;&]*\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell)\b/i, why: "piping a download into a shell" },
]

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE)/i

export function blockedReason(command: string): string | undefined {
  if (!terminalSafeMode()) return undefined
  return BLOCKED_PATTERNS.find((item) => item.re.test(command))?.why
}

function sanitizedEnv(): NodeJS.ProcessEnv {
  if (!terminalSafeMode()) return { ...process.env }
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!SECRET_ENV.test(key)) env[key] = value
  }
  return env
}

export interface TerminalToolOptions {
  root: () => string
  restrictToWorkspace: () => boolean
  /** Shared registry of running/finished commands. One per gateway; a private one is created when omitted. */
  processes?: ProcessManager
}

function resolveCwd(root: string, requested: unknown, restrict: boolean): string {
  const base = path.resolve(root)
  const target = typeof requested === "string" && requested.trim() ? path.resolve(base, requested) : base
  if (restrict && terminalSafeMode()) {
    const rel = path.relative(base, target)
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("cwd must stay inside the workspace.")
  }
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`cwd does not exist: ${target}`)
  return target
}

const clampSeconds = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Number(value)
  return Math.min(max, Math.max(min, Number.isFinite(n) && n !== 0 ? n : fallback))
}

/** Snapshot of a process for the model: final result when finished, a progress report while running. */
export function describeProcess(proc: ManagedProcess): Record<string, unknown> {
  const out = proc.stdout.takeNew(MAX_OUTPUT_CHARS)
  const err = proc.stderr.takeNew(MAX_OUTPUT_CHARS)
  const omitted = out.omitted + err.omitted
  const base = { command: proc.command, cwd: proc.cwd, process_id: proc.id, duration_ms: (proc.endedAt ?? Date.now()) - proc.startedAt }
  if (proc.status === "running") {
    return {
      ...base,
      status: "running",
      elapsed_seconds: Math.round(base.duration_ms / 1000),
      new_stdout: out.text,
      new_stderr: err.text,
      ...(omitted ? { output_omitted_chars: omitted } : {}),
      message:
        `The command is STILL RUNNING and has not been stopped. Do not assume it succeeded or failed. ` +
        `Call terminal_status with process_id "${proc.id}" to wait for it (it returns the moment the command exits, or after ~${MAX_WAIT_SECONDS}s with the newest output), ` +
        `terminal_kill to stop it, or continue other work: you will also get a system notice as soon as it finishes.`,
    }
  }
  proc.announced = true
  return {
    ...base,
    status: proc.status,
    exit_code: proc.exitCode ?? null,
    signal: proc.signal ?? null,
    timed_out: Boolean(proc.timedOut),
    stdout: out.text,
    stderr: err.text,
    truncated: omitted > 0,
    ...(proc.error ? { error: proc.error } : {}),
  }
}

/**
 * Terminal tools for an autonomous agent: terminal_run starts a command and waits for it in a
 * bounded slice, terminal_status waits again / reports progress, terminal_kill stops it. A slow
 * command is never killed by a timeout; the agent is told when it ends.
 */
export function createTerminalTools(options: TerminalToolOptions): EngineTool[] {
  const processes = options.processes ?? new ProcessManager()
  const approvalMode = () => (terminalSafeMode() ? ("required" as const) : ("auto" as const))

  const run: EngineTool = {
    name: "terminal_run",
    description:
      "Run any shell command like a human at a terminal (builds, tests, git, package managers, scripts, installs, system inspection). " +
      `It waits up to wait_seconds (default ${MAX_WAIT_SECONDS}) for the command to finish and returns stdout, stderr and the exit code. ` +
      "A command that is still running is NOT killed: you get status \"running\" with a process_id and the output so far; then use terminal_status to wait again, " +
      "or terminal_kill to stop it. Use background:true for servers or very long jobs you do not need to wait for.",
    risk: "destructive",
    get approval() { return approvalMode() },
    timeoutMs: SLICE_TOOL_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        cwd: { type: "string", description: "Working directory (relative to the workspace, or absolute). Default: workspace root." },
        wait_seconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS, description: `How long to wait for the command before reporting that it is still running (default ${MAX_WAIT_SECONDS}).` },
        background: { type: "boolean", description: "Start the command and return immediately; it keeps running after this run ends. Use for dev servers and long jobs." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_SECONDS, description: "OPTIONAL hard limit: stop the command after this many seconds. Leave unset unless you want it stopped automatically." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const command = typeof input.command === "string" ? input.command.trim() : ""
      if (!command) throw new Error("command is required.")
      const blocked = blockedReason(command)
      if (blocked) throw new Error(`Command blocked by terminal policy (${blocked}).`)
      const cwd = resolveCwd(options.root(), input.cwd, options.restrictToWorkspace())
      const background = input.background === true
      const hardLimit = input.timeout_seconds ? clampSeconds(input.timeout_seconds, 0, 1, MAX_TIMEOUT_SECONDS) * 1000 : undefined
      const proc = processes.start({
        command,
        cwd,
        env: sanitizedEnv(),
        runId: context.runId,
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        detached: background,
        ...(hardLimit ? { killAfterMs: hardLimit } : {}),
      })
      // Background: only wait briefly so an immediate failure (typo, missing binary) is reported right away.
      const waitMs = background ? 1500 : clampSeconds(input.wait_seconds, MAX_WAIT_SECONDS, 1, MAX_WAIT_SECONDS) * 1000
      await processes.waitForExit(proc.id, waitMs, context.signal)
      if (context.signal.aborted && proc.status === "running" && !background) {
        // The run was cancelled (Stop pressed): do not leave an orphaned foreground command behind.
        processes.kill(proc.id)
        await processes.waitForExit(proc.id, 2000)
      }
      return describeProcess(proc)
    },
  }

  const status: EngineTool = {
    name: "terminal_status",
    description:
      "Check a command started with terminal_run. Waits until the command exits (returns immediately when it does) or up to wait_seconds, " +
      "and returns only the NEW output since your last check. Without process_id it lists the commands of this session.",
    risk: "read",
    approval: "auto",
    timeoutMs: SLICE_TOOL_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        process_id: { type: "string", description: "process_id returned by terminal_run. Omit to list all commands." },
        wait_seconds: { type: "integer", minimum: 0, maximum: MAX_WAIT_SECONDS, description: `Wait up to this long for the command to exit (default ${MAX_WAIT_SECONDS}, 0 = just report).` },
      },
      additionalProperties: false,
    },
    async execute(input, context) {
      const id = typeof input.process_id === "string" ? input.process_id.trim() : ""
      if (!id) {
        return {
          processes: processes.list(context.sessionId).map((proc) => ({
            process_id: proc.id,
            command: shorten(proc.command, 120),
            status: proc.status,
            elapsed_seconds: Math.round(((proc.endedAt ?? Date.now()) - proc.startedAt) / 1000),
            ...(proc.status === "running" ? {} : { exit_code: proc.exitCode ?? null }),
          })),
        }
      }
      const proc = processes.get(id)
      if (!proc) throw new Error(`Unknown process_id "${id}". Call terminal_status without process_id to list commands.`)
      const wait = input.wait_seconds === 0 ? 0 : clampSeconds(input.wait_seconds, MAX_WAIT_SECONDS, 0, MAX_WAIT_SECONDS)
      if (wait > 0) await processes.waitForExit(id, wait * 1000, context.signal)
      return describeProcess(proc)
    },
  }

  const kill: EngineTool = {
    name: "terminal_kill",
    description: "Stop a running command started with terminal_run (and its child processes).",
    risk: "destructive",
    get approval() { return approvalMode() },
    parameters: {
      type: "object",
      properties: { process_id: { type: "string", description: "process_id returned by terminal_run." } },
      required: ["process_id"],
      additionalProperties: false,
    },
    async execute(input) {
      const id = typeof input.process_id === "string" ? input.process_id.trim() : ""
      const proc = processes.get(id)
      if (!proc) throw new Error(`Unknown process_id "${id}".`)
      processes.kill(id)
      await processes.waitForExit(id, 3000)
      return describeProcess(proc)
    },
  }

  return [run, status, kill]
}

/** Back-compat: the terminal_run tool alone (tests and callers that only need the runner). */
export function createTerminalTool(options: TerminalToolOptions): EngineTool {
  return createTerminalTools(options)[0]
}
