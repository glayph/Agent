import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import { resolveLiteLLMMasterKey } from "@hiro/config/security";
import { createRotatingLogStream } from "./log-rotation.js";

export interface LiteLLMCommand {
  command: string;
  shell: boolean;
}

export interface ResolveLiteLLMCommandOptions {
  env?: NodeJS.ProcessEnv;
  platform?: string;
  fileExists?: (candidate: string) => boolean;
}

type PathApi = Pick<typeof path, "delimiter" | "join">;

function pathApiForPlatform(platform: string): PathApi {
  return platform === "win32" ? path.win32 : path.posix;
}

function pathValueFromEnv(env: NodeJS.ProcessEnv): string {
  return env.PATH || env.Path || env.path || "";
}

function pathEntries(env: NodeJS.ProcessEnv, platform: string): string[] {
  const pathApi = pathApiForPlatform(platform);
  return pathValueFromEnv(env)
    .split(pathApi.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function windowsScriptRequiresShell(command: string): boolean {
  return /\.(?:cmd|bat)$/i.test(command);
}

function commandForPlatform(command: string, platform: string): LiteLLMCommand {
  return {
    command,
    shell: platform === "win32" && windowsScriptRequiresShell(command),
  };
}

export function resolveLiteLLMCommand(
  options: ResolveLiteLLMCommandOptions = {},
): LiteLLMCommand {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? fs.existsSync;
  const pathApi = pathApiForPlatform(platform);
  const candidates: string[] = [];

  if (platform === "win32") {
    if (env.Hiro_PYTHON_DIR) {
      candidates.push(
        pathApi.join(env.Hiro_PYTHON_DIR, "Scripts", "litellm.exe"),
      );
      candidates.push(
        pathApi.join(env.Hiro_PYTHON_DIR, "Scripts", "litellm.cmd"),
      );
      candidates.push(
        pathApi.join(env.Hiro_PYTHON_DIR, "Scripts", "litellm.bat"),
      );
    }
    // Dynamically scan APPDATA\Python\Python3XX\Scripts\ for any installed Python version
    if (env.APPDATA) {
      const pythonBase = pathApi.join(env.APPDATA, "Python");
      try {
        const entries = fs.readdirSync(pythonBase, { withFileTypes: true });
        const versionDirs = entries
          .filter(
            (e: fs.Dirent) => e.isDirectory() && /^Python3\d+$/i.test(e.name),
          )
          .map((e: fs.Dirent) => pathApi.join(pythonBase, e.name))
          .sort()
          .reverse(); // newest version first
        for (const versionDir of versionDirs) {
          candidates.push(pathApi.join(versionDir, "Scripts", "litellm.exe"));
          candidates.push(pathApi.join(versionDir, "Scripts", "litellm.cmd"));
          candidates.push(pathApi.join(versionDir, "Scripts", "litellm.bat"));
        }
      } catch {
        /* APPDATA\Python may not exist */
      }
      // Also try flat APPDATA\Python\Scripts layout
      candidates.push(pathApi.join(pythonBase, "Scripts", "litellm.exe"));
    }
    // Dynamically scan LOCALAPPDATA\Programs\Python\Python3XX\Scripts\
    if (env.LOCALAPPDATA) {
      const pythonBase = pathApi.join(env.LOCALAPPDATA, "Programs", "Python");
      try {
        const entries = fs.readdirSync(pythonBase, { withFileTypes: true });
        const versionDirs = entries
          .filter(
            (e: fs.Dirent) => e.isDirectory() && /^Python3\d+$/i.test(e.name),
          )
          .map((e: fs.Dirent) => pathApi.join(pythonBase, e.name))
          .sort()
          .reverse();
        for (const versionDir of versionDirs) {
          candidates.push(pathApi.join(versionDir, "Scripts", "litellm.exe"));
        }
      } catch {
        /* LOCALAPPDATA\Programs\Python may not exist */
      }
    }
  }

  const pathCommandNames =
    platform === "win32"
      ? ["litellm.exe", "litellm.cmd", "litellm.bat"]
      : ["litellm"];
  for (const entry of pathEntries(env, platform)) {
    for (const name of pathCommandNames) {
      candidates.push(pathApi.join(entry, name));
    }
  }

  for (const candidate of candidates) {
    if (fileExists(candidate)) return commandForPlatform(candidate, platform);
  }

  return { command: "litellm", shell: platform === "win32" };
}

export type LiteLLMStatus =
  | "starting"
  | "running"
  | "stopped"
  | "error"
  | "restarting";

export interface LiteLLMConfig {
  workspaceDir: string;
  runtimeRoot: string;
  litellmPort: number;
}

export interface LiteLLMState {
  process: child_process.ChildProcess | null;
  status: LiteLLMStatus;
  lastError: string | null;
  lastExitCode: number | null;
  startedAt: string | null;
  /** Auto-restart tracking */
  restartAttempts: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  supervisorEnabled: boolean;
  onAutoRestart?: () => void;
}

export function createLiteLLMState(): LiteLLMState {
  return {
    process: null,
    status: "stopped",
    lastError: null,
    lastExitCode: null,
    startedAt: null,
    restartAttempts: 0,
    restartTimer: null,
    supervisorEnabled: true,
  };
}

export function resolveLiteLLMConfigPath(workspaceDir: string): string {
  const configured = process.env.LITELLM_CONFIG_PATH;
  if (configured) {
    return path.isAbsolute(configured)
      ? configured
      : path.resolve(workspaceDir, configured);
  }
  return path.join(workspaceDir, "config", "litellm.yaml");
}

export function liteLLMBaseUrl(port: number): string {
  return process.env.LITELLM_BASE_URL || `http://127.0.0.1:${port}/v1`;
}

export function liteLLMLogFile(workspaceDir: string): string {
  return path.join(workspaceDir, "data", "litellm_proxy.log");
}

export function startLiteLLM(
  state: LiteLLMState,
  config: LiteLLMConfig,
  log: (...args: unknown[]) => void,
): child_process.ChildProcess {
  const logFile = liteLLMLogFile(config.workspaceDir);
  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  const logStream = createRotatingLogStream(logFile);
  const masterKey = resolveLiteLLMMasterKey({
    workspaceDir: config.workspaceDir,
  });

  logStream.write(
    `\n--- Gateway spawning LiteLLM Proxy at ${new Date().toISOString()} ---\n`,
  );

  const litellmCommand = resolveLiteLLMCommand();
  const execPath = litellmCommand.command;
  const configPath = resolveLiteLLMConfigPath(config.workspaceDir);
  const args: string[] = [];
  if (fs.existsSync(configPath)) args.push("--config", configPath);
  args.push("--port", String(config.litellmPort));

  log(`Spawning LiteLLM Proxy using: ${execPath} ${args.join(" ")}`);
  state.status = "starting";
  state.lastError = null;
  state.lastExitCode = null;
  state.startedAt = new Date().toISOString();

  const proc = child_process.spawn(execPath, args, {
    cwd: config.workspaceDir,
    env: {
      ...process.env,
      LITELLM_MASTER_KEY: masterKey,
      PYTHONIOENCODING: process.env.PYTHONIOENCODING || "utf-8",
      PYTHONUTF8: process.env.PYTHONUTF8 || "1",
    },
    shell: litellmCommand.shell,
  });

  proc.stdout?.on("data", (d: Buffer) => logStream.write(d.toString()));
  proc.stdout?.on("error", (err: Error) => log("LiteLLM stdout error:", err));
  proc.stderr?.on("data", (d: Buffer) =>
    logStream.write(`[STDERR] ${d.toString()}`),
  );
  proc.stderr?.on("error", (err: Error) => log("LiteLLM stderr error:", err));

  proc.on("exit", (code) => {
    log(`LiteLLM Proxy exited with code ${code}`);
    state.status = code === 0 ? "stopped" : "error";
    state.lastExitCode = code;
    logStream.write(
      `\n--- LiteLLM exited code ${code} at ${new Date().toISOString()} ---\n`,
    );
    logStream.end();
    // Auto-restart if supervisor is enabled and exit was unexpected
    if (state.supervisorEnabled && code !== 0 && code !== null) {
      scheduleLiteLLMRestart(state, config, log);
    }
  });

  proc.on("error", (err: Error) => {
    log("Failed to spawn LiteLLM Proxy:", err.message);
    state.status = "error";
    state.lastError = err.message;
    logStream.write(`\n--- LiteLLM spawn error: ${err.message} ---\n`);
    if (state.supervisorEnabled) {
      scheduleLiteLLMRestart(state, config, log);
    }
  });

  state.process = proc;
  return proc;
}

export async function waitForLiteLLM(
  port: number,
  log: (...args: unknown[]) => void,
  timeout = 30000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/readiness`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        log("LiteLLM Proxy is healthy");
        return;
      }
    } catch {
      /* not ready yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log("LiteLLM Proxy health check timed out, continuing anyway...");
}

export async function probeLiteLLM(
  port: number,
  masterKey: string,
): Promise<{ healthy: boolean; models?: number; error?: string }> {
  try {
    const res = await fetch(
      `${liteLLMBaseUrl(port).replace(/\/+$/, "")}/models`,
      {
        signal: AbortSignal.timeout(2500),
        headers: { Authorization: `Bearer ${masterKey}` },
      },
    );
    if (!res.ok) return { healthy: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: unknown[] };
    return {
      healthy: true,
      models: Array.isArray(body.data) ? body.data.length : undefined,
    };
  } catch (err) {
    return {
      healthy: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function liteLLMStatusPayload(
  state: LiteLLMState,
  config: LiteLLMConfig,
): Promise<Record<string, unknown>> {
  if (process.env["Hiro_ENABLE_LITELLM"] === "false") {
    return {
      status: "disabled",
      healthy: false,
      pid: null,
      started_at: null,
      base_url: liteLLMBaseUrl(config.litellmPort),
      port: config.litellmPort,
      executable: null,
      executable_shell: false,
      config_path: resolveLiteLLMConfigPath(config.workspaceDir),
      config_exists: fs.existsSync(
        resolveLiteLLMConfigPath(config.workspaceDir),
      ),
      log_path: liteLLMLogFile(config.workspaceDir),
      models_endpoint_count: undefined,
      last_exit_code: null,
      error: "LiteLLM supervisor disabled by Hiro_ENABLE_LITELLM=false.",
    };
  }
  const probe = await probeLiteLLM(
    config.litellmPort,
    resolveLiteLLMMasterKey({ workspaceDir: config.workspaceDir }),
  );
  const litellmCommand = resolveLiteLLMCommand();
  return {
    status: probe.healthy ? "running" : state.status,
    healthy: probe.healthy,
    pid: state.process?.pid ?? null,
    started_at: state.startedAt,
    base_url: liteLLMBaseUrl(config.litellmPort),
    port: config.litellmPort,
    executable: litellmCommand.command,
    executable_shell: litellmCommand.shell,
    config_path: resolveLiteLLMConfigPath(config.workspaceDir),
    config_exists: fs.existsSync(resolveLiteLLMConfigPath(config.workspaceDir)),
    log_path: liteLLMLogFile(config.workspaceDir),
    models_endpoint_count: probe.models,
    last_exit_code: state.lastExitCode,
    error: probe.error || state.lastError,
  };
}

export async function restartLiteLLM(
  state: LiteLLMState,
  config: LiteLLMConfig,
  log: (...args: unknown[]) => void,
): Promise<void> {
  state.status = "restarting";
  if (state.process) {
    state.process.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (!state.process.killed) state.process.kill("SIGKILL");
  }
  state.process = startLiteLLM(state, config, log);
  await waitForLiteLLM(config.litellmPort, log, 15000);
}

// ── LiteLLM Automatic Restart Supervisor ─────────────────────────────────────

/**
 * Maximum LiteLLM restart attempts. 0 = unbounded.
 * Controlled by LITELLM_MAX_RESTARTS env var.
 */
function maxLiteLLMRestarts(): number {
  const raw = process.env["LITELLM_MAX_RESTARTS"];
  if (!raw || !raw.trim()) return 0; // unbounded by default
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Schedule an automatic LiteLLM restart with exponential backoff.
 * Backoff: 5s * 2^attempt, capped at 5 minutes.
 * Respects LITELLM_MAX_RESTARTS (0 = unbounded).
 */
export function scheduleLiteLLMRestart(
  state: LiteLLMState,
  config: LiteLLMConfig,
  log: (...args: unknown[]) => void,
): void {
  if (state.restartTimer) return; // already scheduled
  const maxRestarts = maxLiteLLMRestarts();
  if (maxRestarts > 0 && state.restartAttempts >= maxRestarts) {
    log(`LiteLLM auto-restart limit reached (${maxRestarts}). Giving up.`);
    state.status = "error";
    return;
  }
  state.restartAttempts++;
  // Backoff: 5s, 10s, 20s, 40s … capped at 5 minutes
  const backoffMs = Math.min(
    5000 * Math.pow(2, state.restartAttempts - 1),
    5 * 60 * 1000,
  );
  log(
    `LiteLLM crashed — scheduling restart in ${Math.round(backoffMs / 1000)}s (attempt ${state.restartAttempts})`,
  );
  state.status = "restarting";

  state.restartTimer = setTimeout(async () => {
    state.restartTimer = null;
    if (!state.supervisorEnabled) return;
    log(`LiteLLM auto-restart attempt ${state.restartAttempts} starting…`);
    try {
      state.process = startLiteLLM(state, config, log);
      await waitForLiteLLM(config.litellmPort, log, 30000);
      // Verify it's actually healthy
      const masterKey = resolveLiteLLMMasterKey({
        workspaceDir: config.workspaceDir,
      });
      const probe = await probeLiteLLM(config.litellmPort, masterKey);
      if (probe.healthy) {
        log(
          `LiteLLM auto-restart succeeded (attempt ${state.restartAttempts})`,
        );
        state.restartAttempts = 0; // reset on success
        state.status = "running";
        state.onAutoRestart?.();
      } else {
        log(`LiteLLM restarted but not healthy: ${probe.error}`);
        scheduleLiteLLMRestart(state, config, log);
      }
    } catch (err) {
      log(
        `LiteLLM auto-restart failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      scheduleLiteLLMRestart(state, config, log);
    }
  }, backoffMs);
  // Don't keep Node alive solely for this timer
  (
    state.restartTimer as ReturnType<typeof setTimeout> & { unref?: () => void }
  ).unref?.();
}

/**
 * Disable the LiteLLM supervisor (e.g., during gateway shutdown).
 */
export function stopLiteLLMSupervisor(state: LiteLLMState): void {
  state.supervisorEnabled = false;
  if (state.restartTimer) {
    clearTimeout(state.restartTimer);
    state.restartTimer = null;
  }
}
