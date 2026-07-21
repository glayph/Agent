import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";
import { resolveLiteLLMMasterKey } from "@hiro/config/security";

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
  return { command, shell: platform === "win32" && windowsScriptRequiresShell(command) };
}

export function resolveLiteLLMCommand(options: ResolveLiteLLMCommandOptions = {}): LiteLLMCommand {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? fs.existsSync;
  const pathApi = pathApiForPlatform(platform);
  const candidates: string[] = [];

  if (platform === "win32") {
    if (env.Hiro_PYTHON_DIR) {
      candidates.push(pathApi.join(env.Hiro_PYTHON_DIR, "Scripts", "litellm.exe"));
      candidates.push(pathApi.join(env.Hiro_PYTHON_DIR, "Scripts", "litellm.cmd"));
      candidates.push(pathApi.join(env.Hiro_PYTHON_DIR, "Scripts", "litellm.bat"));
    }
    if (env.APPDATA) {
      candidates.push(pathApi.join(env.APPDATA, "Python", "Python313", "Scripts", "litellm.exe"));
      candidates.push(pathApi.join(env.APPDATA, "Python", "Scripts", "litellm.exe"));
    }
    if (env.LOCALAPPDATA) {
      candidates.push(pathApi.join(env.LOCALAPPDATA, "Programs", "Python", "Python313", "Scripts", "litellm.exe"));
    }
  }

  const pathCommandNames = platform === "win32" ? ["litellm.exe", "litellm.cmd", "litellm.bat"] : ["litellm"];
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

export type LiteLLMStatus = "starting" | "running" | "stopped" | "error" | "restarting";

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
}

export function createLiteLLMState(): LiteLLMState {
  return { process: null, status: "stopped", lastError: null, lastExitCode: null, startedAt: null };
}

export function resolveLiteLLMConfigPath(workspaceDir: string): string {
  const configured = process.env.LITELLM_CONFIG_PATH;
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(workspaceDir, configured);
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
  const logStream = fs.createWriteStream(logFile, { flags: "a" });
  const masterKey = resolveLiteLLMMasterKey({ workspaceDir: config.workspaceDir });

  logStream.write(`\n--- Gateway spawning LiteLLM Proxy at ${new Date().toISOString()} ---\n`);

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
  proc.stderr?.on("data", (d: Buffer) => logStream.write(`[STDERR] ${d.toString()}`));
  proc.stderr?.on("error", (err: Error) => log("LiteLLM stderr error:", err));

  proc.on("exit", (code) => {
    log(`LiteLLM Proxy exited with code ${code}`);
    state.status = code === 0 ? "stopped" : "error";
    state.lastExitCode = code;
    logStream.write(`\n--- LiteLLM exited code ${code} at ${new Date().toISOString()} ---\n`);
    logStream.end();
  });

  proc.on("error", (err: Error) => {
    log("Failed to spawn LiteLLM Proxy:", err.message);
    state.status = "error";
    state.lastError = err.message;
    logStream.write(`\n--- LiteLLM spawn error: ${err.message} ---\n`);
  });

  state.process = proc;
  return proc;
}

export async function waitForLiteLLM(port: number, log: (...args: unknown[]) => void, timeout = 30000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/readiness`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) { log("LiteLLM Proxy is healthy"); return; }
    } catch { /* not ready yet */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log("LiteLLM Proxy health check timed out, continuing anyway...");
}

export async function probeLiteLLM(port: number, masterKey: string): Promise<{ healthy: boolean; models?: number; error?: string }> {
  try {
    const res = await fetch(`${liteLLMBaseUrl(port).replace(/\/+$/, "")}/models`, {
      signal: AbortSignal.timeout(2500),
      headers: { Authorization: `Bearer ${masterKey}` },
    });
    if (!res.ok) return { healthy: false, error: `HTTP ${res.status}` };
    const body = (await res.json()) as { data?: unknown[] };
    return { healthy: true, models: Array.isArray(body.data) ? body.data.length : undefined };
  } catch (err) {
    return { healthy: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function liteLLMStatusPayload(
  state: LiteLLMState,
  config: LiteLLMConfig,
): Promise<Record<string, unknown>> {
  if (process.env["Hiro_ENABLE_LITELLM"] === "false") {
    return {
      status: "disabled", healthy: false, pid: null, started_at: null,
      base_url: liteLLMBaseUrl(config.litellmPort), port: config.litellmPort,
      executable: null, executable_shell: false,
      config_path: resolveLiteLLMConfigPath(config.workspaceDir),
      config_exists: fs.existsSync(resolveLiteLLMConfigPath(config.workspaceDir)),
      log_path: liteLLMLogFile(config.workspaceDir),
      models_endpoint_count: undefined, last_exit_code: null,
      error: "LiteLLM supervisor disabled by Hiro_ENABLE_LITELLM=false.",
    };
  }
  const probe = await probeLiteLLM(config.litellmPort, resolveLiteLLMMasterKey({ workspaceDir: config.workspaceDir }));
  const litellmCommand = resolveLiteLLMCommand();
  return {
    status: probe.healthy ? "running" : state.status, healthy: probe.healthy,
    pid: state.process?.pid ?? null, started_at: state.startedAt,
    base_url: liteLLMBaseUrl(config.litellmPort), port: config.litellmPort,
    executable: litellmCommand.command, executable_shell: litellmCommand.shell,
    config_path: resolveLiteLLMConfigPath(config.workspaceDir),
    config_exists: fs.existsSync(resolveLiteLLMConfigPath(config.workspaceDir)),
    log_path: liteLLMLogFile(config.workspaceDir),
    models_endpoint_count: probe.models, last_exit_code: state.lastExitCode,
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
