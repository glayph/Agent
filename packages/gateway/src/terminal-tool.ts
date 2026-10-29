import { randomBytes } from "node:crypto"
import { existsSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { EngineTool } from "@miki/core/engine"
import { ProcessManager, type ManagedProcess, shorten } from "./process-manager.js"

/**
 * The agent re-checks a running command in slices of at most this long. Short slices keep the agent responsive:
 * a message the user sends while a command runs is read at the next slice, not after minutes.
 */
const MAX_WAIT_SECONDS = 30
/** Engine-side safety margin for one slice: the tool itself never blocks longer than MAX_WAIT_SECONDS. */
// Must stay above the engine's default 60 s tool timeout, or a slice would be cut off before the command is checked.
const SLICE_TOOL_TIMEOUT_MS = Math.max(MAX_WAIT_SECONDS + 30, 120) * 1000
const MAX_TIMEOUT_SECONDS = 24 * 3600
const MAX_OUTPUT_CHARS = 60_000

/**
 * Like a human at a terminal: by default no command blocklist, no approval prompt, any working
 * directory and the user's full environment. The group toggle in Tools is the on/off switch.
 *
 * MIKI_TERMINAL_SAFE=true adds guard rails for an unattended agent: a blocklist of catastrophic
 * commands, a workspace-only starting directory and an environment without secrets. Safe mode never
 * asks for approval (an overnight goal must not stall on a prompt): a command is blocked or it runs.
 * The workspace-only starting directory can also be switched on alone with
 * `agents.defaults.restrict_to_workspace: true`.
 *
 * These guard rails are a tripwire, not a sandbox. A pattern list cannot recognise every way to say
 * "delete everything", and the starting directory does not stop a command from changing directory.
 * To really confine the agent, run Miki as an unprivileged user inside a VM or container.
 */
export const terminalSafeMode = (): boolean => String(process.env.MIKI_TERMINAL_SAFE ?? "").toLowerCase() === "true"

/** Commands refused in safe mode. Best effort: obvious accidents, not a security boundary. */
const BLOCKED_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(?:-{1,2}[a-z-]+\s+)*?(?:-[a-z]*r[a-z]*|--recursive)\s+(?:-{1,2}[a-z-]+\s+)*(?:\/\*?|~\/?\*?|\$HOME\/?\*?|\*)(?=[\s;&|"'`)]|$)/i, why: "recursive delete of a root/home path" },
  { re: /\bfind\s+(?:\/|~|\$HOME)(?:\s|\/)[^|;&]*(?:-delete\b|-exec\s+rm\b)/i, why: "bulk delete from a root/home path" },
  { re: /\b(?:chmod|chown)\s+-[a-z]*R[a-z]*\s+\S+\s+(?:\/|~|\$HOME)\/?(?=[\s;&|"'`)]|$)/, why: "recursive permission change of a root/home path" },
  { re: />\s*\/dev\/(?:sd|hd|vd|xvd|nvme|mmcblk)/i, why: "raw device write" },
  { re: /\b(?:base64|openssl\s+enc)\b[^;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|pwsh|powershell)\b/i, why: "piping decoded data into a shell" },
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


/** Known non-interactive coding-agent CLIs. `{P}` is replaced by a reference to the prompt environment variable. */
const CODING_AGENTS: Record<string, { bin: string; args: string }> = {
  claude: { bin: "claude", args: "-p {P}" },
  codex: { bin: "codex", args: "exec {P}" },
  gemini: { bin: "gemini", args: "-p {P}" },
}

function onPath(bin: string): boolean {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""]
  for (const dir of String(process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      try { if (statSync(path.join(dir, bin + ext)).isFile()) return true } catch { /* not here */ }
    }
  }
  return false
}

export type CodingAgentCommand = { name: string; command: string; /** Windows only: file (relative to the cwd) the prompt must be written to before the command starts. */ promptFile?: string }

/**
 * Command line for delegating to an installed coding agent.
 *
 * POSIX: the prompt travels in the MIKI_DELEGATE_PROMPT environment variable and the command expands
 * it inside double quotes, so the shell never parses it.
 * Windows: cmd.exe expands %VAR% BEFORE it parses the line, so `&` or `|` inside an expanded prompt
 * would run as commands. There the prompt is written to a file with a generated name (hex only, so it
 * needs no quoting) and the command only tells the agent to read that file. The caller writes the
 * file before starting the command and deletes it afterwards.
 *
 * MIKI_CODING_AGENT_COMMAND may hold a custom command that reads $MIKI_DELEGATE_PROMPT. On Windows
 * its author is responsible for handling %MIKI_DELEGATE_PROMPT% safely.
 */
export function resolveCodingAgent(preferred?: string, platform: NodeJS.Platform = process.platform): CodingAgentCommand | { error: string } {
  const custom = String(process.env.MIKI_CODING_AGENT_COMMAND ?? "").trim()
  if (custom && !preferred) return { name: "custom", command: custom }
  const names = preferred ? [preferred.toLowerCase()] : Object.keys(CODING_AGENTS)
  for (const name of names) {
    const spec = Object.hasOwn(CODING_AGENTS, name) ? CODING_AGENTS[name] : undefined
    if (spec && onPath(spec.bin)) {
      if (platform === "win32") {
        const promptFile = `.miki-delegate-${randomBytes(8).toString("hex")}.txt`
        const instruction = `"Read the complete task in the file ${promptFile} in the current directory and carry it out."`
        return { name, command: `${spec.bin} ${spec.args.replace("{P}", instruction)}`, promptFile }
      }
      return { name, command: `${spec.bin} ${spec.args.replace("{P}", '"$MIKI_DELEGATE_PROMPT"')}` }
    }
  }
  return { error: preferred ? `Coding agent "${preferred}" is not installed on PATH (supported: ${Object.keys(CODING_AGENTS).join(", ")}).` : `No coding agent CLI found on PATH (looked for: ${Object.keys(CODING_AGENTS).join(", ")}). Install one or set MIKI_CODING_AGENT_COMMAND.` }
}

export interface TerminalToolOptions {
  root: () => string
  /** True keeps the starting directory of commands inside the workspace. Safe mode forces it on. */
  restrictToWorkspace: () => boolean
  /** Shared registry of running/finished commands. One per gateway; a private one is created when omitted. */
  processes?: ProcessManager
}

function isInside(base: string, target: string): boolean {
  const rel = path.relative(base, target)
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

function resolveCwd(root: string, requested: unknown, restrict: boolean): string {
  const base = path.resolve(root)
  const target = typeof requested === "string" && requested.trim() ? path.resolve(base, requested) : base
  const confine = restrict || terminalSafeMode()
  if (confine && !isInside(base, target)) throw new Error("cwd must stay inside the workspace.")
  if (!existsSync(target) || !statSync(target).isDirectory()) throw new Error(`cwd does not exist: ${target}`)
  if (!confine) return target
  // Compare real paths: a symlink inside the workspace must not lead out of it.
  const realTarget = realpathSync(target)
  let realBase = base
  try { realBase = realpathSync(base) } catch { /* workspace root missing: lexical check above already applied */ }
  if (!isInside(realBase, realTarget)) throw new Error("cwd must stay inside the workspace.")
  return realTarget
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
  // Safe mode is designed for unattended autonomy: known-dangerous commands are blocked rather
  // than prompting for a human approval that would stall an overnight goal. So no tool here ever
  // asks for approval, in either mode.
  const approvalMode = () => "auto" as const

  const run: EngineTool = {
    name: "terminal_run",
    description:
      "Run any shell command like a human at a terminal (builds, tests, git, package managers, scripts, installs, system inspection). " +
      `This machine runs ${process.platform === "win32" ? "Windows: commands run in cmd.exe, so use Windows commands (or powershell -Command) and Windows paths" : process.platform === "darwin" ? "macOS: commands run in sh (zsh-compatible), so use POSIX commands" : "Linux: commands run in sh (POSIX)"}. ` +
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
    repeatSafe: true,
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

  const delegate: EngineTool = {
    name: "delegate_coding_agent",
    description:
      "Hand a substantial coding or build task to an installed coding-agent CLI (claude, codex or gemini) instead of writing the code yourself. " +
      "Give a complete, self-contained prompt and the project directory. Works like terminal_run: if status is \"running\", follow it with terminal_status; verify the result (files, tests) before reporting success.",
    risk: "destructive",
    get approval() { return approvalMode() },
    timeoutMs: SLICE_TOOL_TIMEOUT_MS,
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Full task description for the coding agent." },
        cwd: { type: "string", description: "Project directory (default: workspace root)." },
        agent: { type: "string", enum: Object.keys(CODING_AGENTS), description: "Which CLI to use. Default: first installed." },
        wait_seconds: { type: "integer", minimum: 1, maximum: MAX_WAIT_SECONDS },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const prompt = typeof input.prompt === "string" ? input.prompt.trim() : ""
      if (!prompt) throw new Error("prompt is required.")
      const resolved = resolveCodingAgent(typeof input.agent === "string" ? input.agent : undefined)
      if ("error" in resolved) throw new Error(resolved.error)
      // The command is assembled by Miki (or set by the owner in MIKI_CODING_AGENT_COMMAND), never by the model, so it is not run through the blocklist.
      const cwd = resolveCwd(options.root(), input.cwd, options.restrictToWorkspace())
      let promptPath: string | undefined
      if (resolved.promptFile) {
        promptPath = path.join(cwd, resolved.promptFile)
        writeFileSync(promptPath, prompt, { encoding: "utf8", mode: 0o600, flag: "wx" })
      }
      const cleanup = () => { if (promptPath) { try { rmSync(promptPath, { force: true }) } catch { /* best effort */ } } }
      let proc: ManagedProcess
      try {
        proc = processes.start({
          command: resolved.command,
          cwd,
          env: { ...sanitizedEnv(), MIKI_DELEGATE_PROMPT: prompt },
          runId: context.runId,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          detached: false,
          onExit: cleanup,
        })
      } catch (error) {
        cleanup()
        throw error
      }
      await processes.waitForExit(proc.id, clampSeconds(input.wait_seconds, MAX_WAIT_SECONDS, 1, MAX_WAIT_SECONDS) * 1000, context.signal)
      return { agent: resolved.name, ...describeProcess(proc) }
    },
  }

  return [run, status, kill, delegate]
}

/** Back-compat: the terminal_run tool alone (tests and callers that only need the runner). */
export function createTerminalTool(options: TerminalToolOptions): EngineTool {
  return createTerminalTools(options)[0]
}
