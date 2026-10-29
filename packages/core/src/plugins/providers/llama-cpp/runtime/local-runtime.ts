import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

export interface LocalLlamaModelConfig {
  runtime: "llama.cpp";
  model_path?: string;
  model_format: "gguf";
  display_name?: string;
  context_size?: number;
  gpu_layers?: number | "auto";
  batch_size?: number;
  ubatch_size?: number;
  parallel?: number;
  threads?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  min_p?: number;
  seed?: number;
  chat_template?: string;
  use_mmap?: boolean;
  use_mlock?: boolean;
  flash_attention?: boolean;
  enabled: boolean;
  auto_start?: boolean;
  executable_path?: string;
  port?: number;
  allowed_model_dirs?: string[];
}

export interface LocalRuntimeHealth {
  provider: "llama.cpp";
  ready: boolean;
  configured: boolean;
  executable_available: boolean;
  pid?: number;
  port?: number;
  base_url?: string;
  model?: string;
  model_path?: string;
  last_error?: string;
}

export type LocalRuntimeTransition = {
  selected_model: string;
  local: boolean;
  action: "started" | "already_ready" | "stopped" | "unchanged" | "unavailable";
  health: LocalRuntimeHealth;
  error?: string;
};

type LocalModelEntry = {
  model_name?: string;
  provider?: string;
  model?: string;
  api_base?: string;
  local?: Partial<LocalLlamaModelConfig>;
};

const DEFAULT_BASE_URL = "http://127.0.0.1:39200/v1";
const DEFAULT_CONTEXT_SIZE = Math.max(
  8_192,
  Number.parseInt(
    (process.env.MIKI_LOCAL_CONTEXT_SIZE || "16384").replace(/_/g, ""),
    10,
  ) || 16_384,
);
const LOCAL_RUNTIME_PLATFORM = `${process.platform}-${process.arch}`;
const LOCAL_RUNTIME_EXECUTABLE =
  process.platform === "win32" ? "llama-server.exe" : "llama-server";
const configuredModels = new Map<string, LocalModelEntry>();
let managedProcess: ChildProcess | undefined;
// pid of a llama-server this module started and then adopted again (for example after the gateway was killed and restarted).
let managedPid = 0;
let managedKey = "";
let managedBaseUrl = "";
let managedError = "";
// Model switches and starts run one after another, in the order they arrive: a later request never starts while an
// earlier one is still stopping or loading a model, and the last request is the one that stays running. A request
// joins the pending start only when it is for the same model as the most recent request (nothing else was queued after it).
let ensureTail: Promise<unknown> = Promise.resolve();
let lastEnsure: { key: string; run: Promise<{ baseUrl: string; model: string }> } | undefined;

/** What is recorded about the llama-server this module started, so the next gateway can find and reuse or stop it. */
interface RuntimeRecord {
  pid: number;
  port: number;
  base_url: string;
  model_path: string;
  key: string;
  executable: string;
  started_at: string;
}
// A server started by the model manager is external to this core process. Keep
// the last successful health probe so synchronous provider readiness checks do
// not incorrectly report that healthy loopback runtime as unavailable.
let externalReadyBaseUrl = "";

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function normalizeLocalModelConfig(
  value: unknown,
  existing?: Partial<LocalLlamaModelConfig>,
): LocalLlamaModelConfig | undefined {
  if (value === null || value === "") return undefined;
  const input =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const modelPath = stringOrUndefined(input.model_path) ?? existing?.model_path;
  const executablePath =
    stringOrUndefined(input.executable_path) ?? existing?.executable_path;
  const port = numberOrUndefined(input.port) ?? existing?.port;
  if (
    port !== undefined &&
    (!Number.isInteger(port) || port < 1024 || port > 65535)
  ) {
    throw new Error("local.port must be an integer between 1024 and 65535");
  }
  if (modelPath && !path.isAbsolute(modelPath)) {
    throw new Error("local.model_path must be an absolute GGUF path");
  }
  return {
    runtime: "llama.cpp",
    model_path: modelPath,
    model_format: "gguf",
    display_name:
      stringOrUndefined(input.display_name) ?? existing?.display_name,
    context_size:
      numberOrUndefined(input.context_size) ??
      existing?.context_size ??
      DEFAULT_CONTEXT_SIZE,
    gpu_layers: numberOrUndefined(input.gpu_layers) ?? existing?.gpu_layers,
    batch_size: numberOrUndefined(input.batch_size) ?? existing?.batch_size,
    ubatch_size: numberOrUndefined(input.ubatch_size) ?? existing?.ubatch_size,
    parallel: numberOrUndefined(input.parallel) ?? existing?.parallel,
    threads: numberOrUndefined(input.threads) ?? existing?.threads,
    temperature: numberOrUndefined(input.temperature) ?? existing?.temperature,
    top_p: numberOrUndefined(input.top_p) ?? existing?.top_p,
    top_k: numberOrUndefined(input.top_k) ?? existing?.top_k,
    min_p: numberOrUndefined(input.min_p) ?? existing?.min_p,
    seed: numberOrUndefined(input.seed) ?? existing?.seed,
    chat_template:
      stringOrUndefined(input.chat_template) ?? existing?.chat_template,
    use_mmap: booleanOrUndefined(input.use_mmap) ?? existing?.use_mmap,
    use_mlock: booleanOrUndefined(input.use_mlock) ?? existing?.use_mlock,
    flash_attention:
      booleanOrUndefined(input.flash_attention) ?? existing?.flash_attention,
    enabled: booleanOrUndefined(input.enabled) ?? existing?.enabled ?? true,
    auto_start:
      booleanOrUndefined(input.auto_start) ?? existing?.auto_start ?? true,
    executable_path: executablePath,
    port,
    allowed_model_dirs: Array.isArray(input.allowed_model_dirs)
      ? input.allowed_model_dirs.filter(
          (item): item is string =>
            typeof item === "string" && path.isAbsolute(item),
        )
      : existing?.allowed_model_dirs,
  };
}

/**
 * Returns the model_name of the first currently-configured llama.cpp local
 * model, if any. Used as a fallback target for freshness probes (e.g.
 * testConnection) that need *some* real, configured model to re-check
 * instead of a hardcoded placeholder id that may not exist in this
 * installation (see: BUG - testConnection always probed the literal
 * string "local-model" regardless of what the user actually configured).
 */
export function firstConfiguredLocalModel(): string | undefined {
  return configuredModels.keys().next().value;
}

export function fallbackConfiguredLocalModel(
  selectedModel?: string,
): string | undefined {
  const selected = selectedModel?.toLowerCase();
  for (const [key, entry] of configuredModels) {
    if (selected && key === selected) continue;
    const config = localConfig(entry);
    if (config.enabled && config.model_path)
      return entry.model_name || entry.model || key;
  }
  return undefined;
}

export function configureLocalModels(models: unknown[]): void {
  configuredModels.clear();
  for (const raw of models) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as LocalModelEntry;
    const provider = String(entry.provider || "").toLowerCase();
    if (
      provider !== "llama.cpp" &&
      provider !== "llama-cpp" &&
      provider !== "llamacpp" &&
      provider !== "local-llama" &&
      provider !== "local"
    )
      continue;
    const keys = [entry.model_name, entry.model].filter((key): key is string =>
      Boolean(key),
    );
    for (const key of keys) configuredModels.set(key.toLowerCase(), entry);
  }
}

function localEntry(model: string): LocalModelEntry | undefined {
  const lower = model.toLowerCase();
  return (
    configuredModels.get(lower) ||
    configuredModels.get(lower.replace(/^llama\.cpp\//, "")) ||
    configuredModels.get(lower.replace(/^llama-cpp\//, "")) ||
    configuredModels.get(lower.replace(/^llamacpp\//, "")) ||
    configuredModels.get(lower.replace(/^local-llama\//, "")) ||
    configuredModels.get(lower.replace(/^local\//, ""))
  );
}

function localConfig(entry?: LocalModelEntry): LocalLlamaModelConfig {
  return (
    normalizeLocalModelConfig(entry?.local, undefined) || {
      runtime: "llama.cpp",
      model_format: "gguf",
      enabled: true,
      auto_start: true,
    }
  );
}

function localBaseUrl(entry?: LocalModelEntry): string {
  const configured = stringOrUndefined(entry?.api_base);
  const env = stringOrUndefined(process.env.MIKI_LLAMA_BASE_URL);
  return (configured || env || DEFAULT_BASE_URL).replace(/\/$/, "");
}

function executableOnPath(command: string): string | undefined {
  if (path.isAbsolute(command)) return command;
  const pathValue = process.env.PATH || "";
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue through PATH entries.
    }
  }
  return undefined;
}

function packagedExecutable(): string | undefined {
  const workspaceRoot = path.resolve(
    process.env.MIKI_WORKSPACE_DIR || process.cwd(),
  );
  const runtimeRoot = path.resolve(
    process.env.MIKI_RUNTIME_ROOT || workspaceRoot,
  );
  const candidates = [
    path.join(
      runtimeRoot,
      "packages",
      "core",
      "dist",
      "llm",
      "local",
      "native",
      LOCAL_RUNTIME_PLATFORM,
      LOCAL_RUNTIME_EXECUTABLE,
    ),
    path.join(
      runtimeRoot,
      "packages",
      "core",
      "src",
      "llm",
      "local",
      "native",
      LOCAL_RUNTIME_PLATFORM,
      LOCAL_RUNTIME_EXECUTABLE,
    ),
    path.join(
      workspaceRoot,
      "packages",
      "core",
      "dist",
      "llm",
      "local",
      "native",
      LOCAL_RUNTIME_PLATFORM,
      LOCAL_RUNTIME_EXECUTABLE,
    ),
    path.join(
      workspaceRoot,
      "packages",
      "core",
      "src",
      "llm",
      "local",
      "native",
      LOCAL_RUNTIME_PLATFORM,
      LOCAL_RUNTIME_EXECUTABLE,
    ),
    // Current plugin-owned runtime location. Keep the legacy llm/local paths
    // above for packaged and older installations.
    path.join(
      runtimeRoot,
      "packages",
      "core",
      "src",
      "plugins",
      "providers",
      "llama-cpp",
      "runtime",
      "native",
      LOCAL_RUNTIME_PLATFORM,
      LOCAL_RUNTIME_EXECUTABLE,
    ),
    path.join(
      workspaceRoot,
      "packages",
      "core",
      "src",
      "plugins",
      "providers",
      "llama-cpp",
      "runtime",
      "native",
      LOCAL_RUNTIME_PLATFORM,
      LOCAL_RUNTIME_EXECUTABLE,
    ),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate));
}

function localExecutable(config: LocalLlamaModelConfig): string | undefined {
  const explicitOverride =
    stringOrUndefined(process.env.MIKI_LLAMA_SERVER_BIN) ||
    stringOrUndefined(process.env.LLAMA_SERVER_BIN);
  if (explicitOverride)
    return executableOnPath(explicitOverride) || explicitOverride;
  // The bundled artifact is the application default. Legacy per-model paths are
  // used only when this installation has no bundled artifact at all.
  return (
    packagedExecutable() ||
    (config.executable_path
      ? executableOnPath(config.executable_path) || config.executable_path
      : undefined) ||
    executableOnPath("llama-server")
  );
}

function allowedModelPath(
  modelPath: string,
  config: LocalLlamaModelConfig,
): boolean {
  const resolved = path.resolve(modelPath);
  const dirs = config.allowed_model_dirs?.length
    ? config.allowed_model_dirs
    : [path.dirname(resolved)];
  return dirs.some((dir) => {
    const root = path.resolve(dir);
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(
  baseUrl: string,
  timeoutMs = Number.parseInt(process.env.MIKI_LLAMA_START_TIMEOUT_MS || "120000", 10),
  stillStarting?: () => boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "runtime did not become ready";
  while (Date.now() < deadline) {
    if (stillStarting && !stillStarting())
      throw new Error("llama-server exited before it was ready");
    try {
      const response = await fetch(`${baseUrl}/models`, {
        signal: AbortSignal.timeout(1200),
      });
      if (response.ok) return;
      lastError = `runtime returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(lastError);
}

/** "ready" when the server answers OK, "loading" when it answers but is not ready yet, "down" when nothing answers. */
async function probeServer(baseUrl: string): Promise<"ready" | "loading" | "down"> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(1200),
    });
    return response.ok ? "ready" : "loading";
  } catch {
    return "down";
  }
}

/** The GGUF path a llama-server reports for itself (GET /props), or undefined when it does not say. */
async function servedModelPath(baseUrl: string): Promise<string | undefined> {
  try {
    const response = await fetch(new URL("/props", baseUrl), {
      signal: AbortSignal.timeout(1200),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { model_path?: unknown };
    return typeof body.model_path === "string" && body.model_path.trim()
      ? body.model_path
      : undefined;
  } catch {
    return undefined;
  }
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

function runtimeRecordPath(): string {
  const dataDir = process.env.MIKI_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dataDir, "llama-runtime.json");
}

function readRuntimeRecord(): RuntimeRecord | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeRecordPath(), "utf8")) as Partial<RuntimeRecord>;
    if (
      Number.isInteger(parsed.pid) &&
      typeof parsed.base_url === "string" &&
      typeof parsed.key === "string" &&
      typeof parsed.model_path === "string" &&
      typeof parsed.executable === "string"
    )
      return parsed as RuntimeRecord;
  } catch {
    // No record yet, or it is unreadable: nothing is adopted.
  }
  return undefined;
}

function writeRuntimeRecord(record: RuntimeRecord): void {
  try {
    fs.mkdirSync(path.dirname(runtimeRecordPath()), { recursive: true });
    fs.writeFileSync(runtimeRecordPath(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch {
    // Best effort: without the record the next gateway simply starts its own server.
  }
}

function clearRuntimeRecord(pid?: number): void {
  const record = readRuntimeRecord();
  if (pid !== undefined && record && record.pid !== pid) return;
  try {
    fs.rmSync(runtimeRecordPath(), { force: true });
  } catch {
    // Nothing to clear.
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A pid from an old record may have been reused by another program. On Linux the command line tells them apart. */
function recordedServerIsOurs(record: RuntimeRecord): boolean {
  if (!processAlive(record.pid)) return false;
  const cmdline = `/proc/${record.pid}/cmdline`;
  if (!fs.existsSync(cmdline)) return true;
  try {
    return fs.readFileSync(cmdline, "utf8").includes(path.basename(record.executable));
  } catch {
    return false;
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await sleep(200);
  }
  return !processAlive(pid);
}

async function terminatePid(pid: number): Promise<void> {
  if (!processAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already exited.
  }
  if (await waitForPidExit(pid, 10_000)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already exited.
  }
  await waitForPidExit(pid, 5_000);
}

function hasManagedServer(): boolean {
  return Boolean(managedProcess) || managedPid > 0;
}

/** Synchronous stop, for process exit and places that cannot wait. */
function stopManagedProcess(): void {
  const processToStop = managedProcess;
  const pid = managedPid;
  managedProcess = undefined;
  managedPid = 0;
  managedKey = "";
  managedBaseUrl = "";
  if (processToStop) {
    try {
      processToStop.kill("SIGTERM");
    } catch {
      // The child may have exited between the state check and termination.
    }
    clearRuntimeRecord(processToStop.pid);
  } else if (pid > 0) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
    clearRuntimeRecord(pid);
  }
}

/** Stops the managed server and returns only once it has exited, so a replacement can bind the same port. */
async function stopManagedAndWait(): Promise<void> {
  const processToStop = managedProcess;
  const pid = managedPid;
  managedProcess = undefined;
  managedPid = 0;
  managedKey = "";
  managedBaseUrl = "";
  if (processToStop) {
    if (processToStop.exitCode === null && processToStop.signalCode === null) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            processToStop.kill("SIGKILL");
          } catch {
            // Already exited.
          }
        }, 10_000);
        const giveUp = setTimeout(resolve, 15_000);
        killTimer.unref?.();
        giveUp.unref?.();
        processToStop.once("exit", () => {
          clearTimeout(killTimer);
          clearTimeout(giveUp);
          resolve();
        });
        try {
          processToStop.kill("SIGTERM");
        } catch {
          clearTimeout(killTimer);
          clearTimeout(giveUp);
          resolve();
        }
      });
    }
    clearRuntimeRecord(processToStop.pid);
    return;
  }
  if (pid > 0) {
    await terminatePid(pid);
    clearRuntimeRecord(pid);
  }
}

async function waitForPortClosed(baseUrl: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeServer(baseUrl)) === "down") return;
    await sleep(200);
  }
  throw new Error(`${baseUrl} is still answered by another process; stop it or change this model's port.`);
}

function runtimeArgs(
  config: LocalLlamaModelConfig,
  modelPath: string,
  port: number,
): string[] {
  const args = [
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
    "--no-ui",
    "--model",
    modelPath,
    "--alias",
    "local-model",
  ];
  if (config.context_size !== undefined)
    args.push("--ctx-size", String(config.context_size));
  if (config.gpu_layers !== undefined)
    args.push("--gpu-layers", String(config.gpu_layers));
  if (config.batch_size !== undefined)
    args.push("--batch-size", String(config.batch_size));
  if (config.ubatch_size !== undefined)
    args.push("--ubatch-size", String(config.ubatch_size));
  if (config.parallel !== undefined)
    args.push("--parallel", String(config.parallel));
  if (config.threads !== undefined)
    args.push("--threads", String(config.threads));
  if (config.use_mmap === false) args.push("--no-mmap");
  if (config.use_mlock === true) args.push("--mlock");
  if (config.flash_attention !== undefined)
    args.push("--flash-attn", config.flash_attention ? "on" : "off");
  return args;
}

function runtimeKey(
  config: LocalLlamaModelConfig,
  executable: string,
  modelPath: string,
  port: number,
): string {
  return JSON.stringify({
    executable,
    modelPath,
    port,
    args: runtimeArgs(config, modelPath, port),
  });
}

async function ensureLocalRuntimeImpl(
  model: string,
): Promise<{ baseUrl: string; model: string }> {
  const entry = localEntry(model);
  const config = localConfig(entry);
  if (!config.enabled)
    throw new Error("The selected llama.cpp model is disabled.");
  const baseUrl = localBaseUrl(entry);
  const configuredPort =
    config.port || Number.parseInt(process.env.MIKI_LLAMA_PORT || "39200", 10);
  const modelPath = config.model_path;
  const executable = localExecutable(config);
  const desiredKey =
    modelPath && executable
      ? runtimeKey(config, executable, modelPath, configuredPort)
      : "";
  const ready = () => ({
    baseUrl,
    model: model.replace(/^(llama\.cpp|llama-cpp|llamacpp|local-llama)\//i, ""),
  });

  // Fast path: the server this module runs already serves exactly this model and settings.
  if (hasManagedServer() && desiredKey && managedKey === desiredKey && managedBaseUrl === baseUrl) {
    if ((await probeServer(baseUrl)) === "ready") {
      managedError = "";
      externalReadyBaseUrl = baseUrl;
      return ready();
    }
  }
  // A server this module runs for another model or other settings is stopped first, so the next one starts on a free port.
  if (hasManagedServer() && managedKey !== desiredKey) await stopManagedAndWait();

  let state = await probeServer(baseUrl);
  if (state === "loading") {
    try {
      await waitForReady(baseUrl);
    } catch (error) {
      throw new Error(`llama.cpp runtime failed to start: ${error instanceof Error ? error.message : String(error)}`);
    }
    state = "ready";
  }
  if (state === "ready") {
    const record = readRuntimeRecord();
    const recordOwned = Boolean(
      record && record.base_url === baseUrl && recordedServerIsOurs(record),
    );
    if (recordOwned && record && desiredKey && record.key === desiredKey) {
      // Our server from before (the gateway was killed or restarted) with the same model and settings: reuse it.
      managedPid = record.pid;
      managedKey = desiredKey;
      managedBaseUrl = baseUrl;
      managedError = "";
      externalReadyBaseUrl = baseUrl;
      return ready();
    }
    if (recordOwned && record) {
      // Our server, but for another model or other settings: stop it and start the selected model below.
      await terminatePid(record.pid);
      clearRuntimeRecord(record.pid);
    } else {
      // A server this module did not start. It is accepted only when it reports the selected model.
      const served = await servedModelPath(baseUrl);
      if (served && modelPath && !samePath(served, modelPath))
        throw new Error(
          `Another llama.cpp server on ${baseUrl} is serving ${served}, not the selected model. Stop it, or give this model its own port.`,
        );
      managedError = "";
      externalReadyBaseUrl = baseUrl;
      return ready();
    }
  }

  if (config.auto_start === false)
    throw new Error(`llama.cpp runtime is not reachable at ${baseUrl}.`);
  if (!modelPath)
    throw new Error(
      "No GGUF model_path is configured for the selected llama.cpp model.",
    );
  if (!fs.existsSync(modelPath) || !fs.statSync(modelPath).isFile())
    throw new Error(`GGUF model not found: ${modelPath}`);
  if (!modelPath.toLowerCase().endsWith(".gguf"))
    throw new Error("local.model_path must point to a .gguf file.");
  if (!allowedModelPath(modelPath, config))
    throw new Error("GGUF model path is outside the configured local allowlist.");
  if (!executable)
    throw new Error(
      "Miki's bundled llama.cpp runtime is unavailable. Run npm run build:all to build the vendored headless runtime, or provide local.executable_path explicitly.",
    );
  if (!fs.existsSync(executable))
    throw new Error(`llama-server executable not found: ${executable}`);

  // A managed server that is still loading (or stuck) is stopped before a new one may bind the same port.
  if (hasManagedServer()) await stopManagedAndWait();
  await waitForPortClosed(baseUrl, 10_000);
  const key = runtimeKey(config, executable, modelPath, configuredPort);
  managedError = "";
  const logDir = process.env.MIKI_DATA_DIR || path.join(process.cwd(), "data");
  fs.mkdirSync(logDir, { recursive: true });
  const log = fs.openSync(path.join(logDir, "llama-server.log"), "a");
  const child = spawn(executable, runtimeArgs(config, modelPath, configuredPort), {
    stdio: ["ignore", log, log],
    shell: false,
  });
  managedProcess = child;
  managedPid = 0;
  managedKey = key;
  managedBaseUrl = baseUrl;
  if (child.pid)
    writeRuntimeRecord({
      pid: child.pid,
      port: configuredPort,
      base_url: baseUrl,
      model_path: modelPath,
      key,
      executable,
      started_at: new Date().toISOString(),
    });
  child.once("error", (error) => {
    if (managedProcess === child) managedError = error.message;
  });
  // Only the process that is still the current one may clear the state; an old exit must not erase a newer start.
  child.once("exit", (code, signal) => {
    if (managedProcess === child) {
      managedError = `llama-server exited (${code ?? signal ?? "unknown"})`;
      managedProcess = undefined;
      managedKey = "";
      managedBaseUrl = "";
    }
    clearRuntimeRecord(child.pid);
  });
  try {
    await waitForReady(baseUrl, undefined, () => child.exitCode === null && child.signalCode === null);
    externalReadyBaseUrl = baseUrl;
  } catch (error) {
    managedError = error instanceof Error ? error.message : String(error);
    await stopManagedAndWait();
    throw new Error(`llama.cpp runtime failed to start: ${managedError}`);
  }
  return ready();
}

/** Makes sure the llama-server for `model` is running. Calls are queued in arrival order (see above). */
export function ensureLocalRuntime(model: string): Promise<{ baseUrl: string; model: string }> {
  const key = model.toLowerCase();
  if (lastEnsure && lastEnsure.key === key) return lastEnsure.run;
  const run = ensureTail.catch(() => undefined).then(() => ensureLocalRuntimeImpl(model));
  ensureTail = run.catch(() => undefined);
  const entry = { key, run };
  lastEnsure = entry;
  run
    .finally(() => {
      if (lastEnsure === entry) lastEnsure = undefined;
    })
    .catch(() => undefined);
  return run;
}

export function getLocalRuntimeHealth(model?: string): LocalRuntimeHealth {
  const entry = model ? localEntry(model) : undefined;
  const config = localConfig(entry);
  const executable = localExecutable(config);
  const baseUrl = localBaseUrl(entry);
  return {
    provider: "llama.cpp",
    ready: hasManagedServer() || externalReadyBaseUrl === baseUrl,
    configured: Boolean(
      entry ||
      process.env.MIKI_LLAMA_BASE_URL ||
      process.env.MIKI_LLAMA_SERVER_BIN,
    ),
    executable_available: Boolean(executable && fs.existsSync(executable)),
    pid: managedProcess?.pid ?? (managedPid || undefined),
    port:
      config.port ||
      Number.parseInt(process.env.MIKI_LLAMA_PORT || "39200", 10),
    base_url: baseUrl,
    model: model?.replace(
      /^(llama\.cpp|llama-cpp|llamacpp|local-llama)\//i,
      "",
    ),
    model_path: config.model_path,
    last_error: managedError || undefined,
  };
}

export function isLocalModel(model: string): boolean {
  return (
    Boolean(localEntry(model)) ||
    /^(llama\.cpp|llama-cpp|llamacpp|local-llama|local)\//i.test(model)
  );
}

export async function synchronizeLocalRuntimeForModel(
  model: string,
): Promise<LocalRuntimeTransition> {
  const local = isLocalModel(model);
  if (!local) {
    const wasRunning = hasManagedServer();
    await stopManagedAndWait();
    return {
      selected_model: model,
      local: false,
      action: wasRunning ? "stopped" : "unchanged",
      health: getLocalRuntimeHealth(),
    };
  }

  try {
    const wasRunning = hasManagedServer();
    await ensureLocalRuntime(model);
    return {
      selected_model: model,
      local: true,
      action: wasRunning ? "already_ready" : "started",
      health: getLocalRuntimeHealth(model),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    managedError = message;
    return {
      selected_model: model,
      local: true,
      action: "unavailable",
      health: getLocalRuntimeHealth(model),
      error: message,
    };
  }
}

export function stopLocalRuntime(): void {
  stopManagedProcess();
}

process.once("exit", stopManagedProcess);
