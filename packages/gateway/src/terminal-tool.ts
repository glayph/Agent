import { spawn } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import path from "node:path"
import type { EngineTool } from "@miki/core/engine"

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 30 * 60_000
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

function clip(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_OUTPUT_CHARS
    ? { text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[output truncated]`, truncated: true }
    : { text, truncated: false }
}

export interface TerminalToolOptions {
  root: () => string
  restrictToWorkspace: () => boolean
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

/** Run a shell command in the workspace. Always approval-gated. */
export function createTerminalTool(options: TerminalToolOptions): EngineTool {
  return {
    name: "terminal_run",
    description:
      "Run any shell command like a human at a terminal and return stdout, stderr and the exit code. Use it for builds, tests, git, package managers, scripts, installing software and inspecting or operating the machine. Runs from the workspace by default; pass cwd to run elsewhere. Has a timeout and an output limit.",
    risk: "destructive",
    get approval() { return terminalSafeMode() ? "required" : "auto" },
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to run." },
        cwd: { type: "string", description: "Working directory (relative to the workspace, or absolute). Default: workspace root." },
        timeout_seconds: { type: "integer", minimum: 1, maximum: MAX_TIMEOUT_MS / 1000, description: "Kill the command after this many seconds (default 120, max 1800)." },
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
      const timeoutMs = Math.min(
        MAX_TIMEOUT_MS,
        Math.max(1000, Number(input.timeout_seconds || 0) * 1000 || DEFAULT_TIMEOUT_MS),
      )
      const started = Date.now()
      return await new Promise((resolve, reject) => {
        const child = spawn(command, { cwd, shell: true, env: sanitizedEnv(), windowsHide: true, detached: process.platform !== "win32" })
        let stdout = ""
        let stderr = ""
        let timedOut = false
        const cap = MAX_OUTPUT_CHARS * 2
        child.stdout?.on("data", (chunk) => { if (stdout.length < cap) stdout += chunk.toString() })
        child.stderr?.on("data", (chunk) => { if (stderr.length < cap) stderr += chunk.toString() })
        const kill = () => {
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL")
            else child.kill("SIGKILL")
          } catch { /* already exited */ }
        }
        const timer = setTimeout(() => { timedOut = true; kill() }, timeoutMs)
        const onAbort = () => kill()
        context.signal.addEventListener("abort", onAbort, { once: true })
        child.on("error", (error) => {
          clearTimeout(timer)
          context.signal.removeEventListener("abort", onAbort)
          reject(error)
        })
        child.on("close", (code, signal) => {
          clearTimeout(timer)
          context.signal.removeEventListener("abort", onAbort)
          const out = clip(stdout)
          const err = clip(stderr)
          resolve({
            command,
            cwd,
            exit_code: code,
            signal,
            timed_out: timedOut,
            duration_ms: Date.now() - started,
            stdout: out.text,
            stderr: err.text,
            truncated: out.truncated || err.truncated,
          })
        })
      })
    },
  }
}
