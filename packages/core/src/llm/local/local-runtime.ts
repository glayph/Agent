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
let managedKey = "";
let managedBaseUrl = "";
let managedError = "";

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
      provider !== "local-llama"
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
    configuredModels.get(lower.replace(/^llama-cpp\//, ""))
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

async function waitForReady(baseUrl: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "runtime did not become ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/models`, {
        signal: AbortSignal.timeout(1200),
      });
      if (response.ok) return;
      lastError = `runtime returned HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(lastError);
}

function stopManagedProcess(): void {
  const processToStop = managedProcess;
  managedProcess = undefined;
  managedKey = "";
  managedBaseUrl = "";
  if (!processToStop) return;
  try {
    processToStop.kill("SIGTERM");
  } catch {
    // The child may have exited between the state check and termination.
  }
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

export async function ensureLocalRuntime(
  model: string,
): Promise<{ baseUrl: string; model: string }> {
  const entry = localEntry(model);
  const config = localConfig(entry);
  if (!config.enabled)
    throw new Error("The selected llama.cpp model is disabled.");
  const baseUrl = localBaseUrl(entry);
  const configuredPort =
    config.port || Number.parseInt(process.env.MIKI_LLAMA_PORT || "39200", 10);
  const configuredPath = config.model_path;
  const configuredExecutable = localExecutable(config);
  const desiredKey =
    configuredPath && configuredExecutable
      ? runtimeKey(config, configuredExecutable, configuredPath, configuredPort)
      : "";
  try {
    await waitForReady(baseUrl, 1000);
    const managedConfigChanged = Boolean(
      managedProcess && managedBaseUrl === baseUrl && managedKey !== desiredKey,
    );
    if (managedProcess && managedBaseUrl && managedBaseUrl !== baseUrl) {
      stopManagedProcess();
    }
    if (managedConfigChanged) {
      stopManagedProcess();
    } else {
      managedError = "";
      return {
        baseUrl,
        model: model.replace(
          /^(llama\.cpp|llama-cpp|llamacpp|local-llama)\//i,
          "",
        ),
      };
    }
  } catch {
    // A configured external loopback server is allowed, but managed startup is
    // attempted only when a model path and executable are explicitly supplied.
  }
  if (config.auto_start === false)
    throw new Error(`llama.cpp runtime is not reachable at ${baseUrl}.`);
  const modelPath = config.model_path;
  const executable = localExecutable(config);
  if (!modelPath)
    throw new Error(
      "No GGUF model_path is configured for the selected llama.cpp model.",
    );
  if (!fs.existsSync(modelPath) || !fs.statSync(modelPath).isFile())
    throw new Error(`GGUF model not found: ${modelPath}`);
  if (!modelPath.toLowerCase().endsWith(".gguf"))
    throw new Error("local.model_path must point to a .gguf file.");
  if (!allowedModelPath(modelPath, config))
    throw new Error(
      "GGUF model path is outside the configured local allowlist.",
    );
  if (!executable)
    throw new Error(
      "Miki's bundled llama.cpp runtime is unavailable. Run npm run build:all to build the vendored headless runtime, or provide local.executable_path explicitly.",
    );
  if (!fs.existsSync(executable))
    throw new Error(`llama-server executable not found: ${executable}`);
  const port = configuredPort;
  const key = runtimeKey(config, executable, modelPath, port);
  if (!managedProcess || managedKey !== key) {
    stopManagedProcess();
    managedKey = key;
    managedError = "";
    managedProcess = spawn(executable, runtimeArgs(config, modelPath, port), {
      stdio: "ignore",
      shell: false,
    });
    managedBaseUrl = baseUrl;
    managedProcess.once("error", (error) => {
      managedError = error.message;
    });
    managedProcess.once("exit", (code, signal) => {
      if (managedProcess)
        managedError = `llama-server exited (${code ?? signal ?? "unknown"})`;
      managedProcess = undefined;
      managedKey = "";
      managedBaseUrl = "";
    });
  }
  try {
    await waitForReady(baseUrl);
  } catch (error) {
    managedError = error instanceof Error ? error.message : String(error);
    stopManagedProcess();
    throw new Error(`llama.cpp runtime failed to start: ${managedError}`);
  }
  return {
    baseUrl,
    model: model.replace(/^(llama\.cpp|llama-cpp|llamacpp|local-llama)\//i, ""),
  };
}

export function getLocalRuntimeHealth(model?: string): LocalRuntimeHealth {
  const entry = model ? localEntry(model) : undefined;
  const config = localConfig(entry);
  const executable = localExecutable(config);
  const baseUrl = localBaseUrl(entry);
  return {
    provider: "llama.cpp",
    ready: Boolean(managedProcess) || Boolean(process.env.MIKI_LLAMA_BASE_URL),
    configured: Boolean(
      entry ||
      process.env.MIKI_LLAMA_BASE_URL ||
      process.env.MIKI_LLAMA_SERVER_BIN,
    ),
    executable_available: Boolean(executable && fs.existsSync(executable)),
    pid: managedProcess?.pid,
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
    /^(llama\.cpp|llama-cpp|llamacpp|local-llama)\//i.test(model)
  );
}

export async function synchronizeLocalRuntimeForModel(
  model: string,
): Promise<LocalRuntimeTransition> {
  const local = isLocalModel(model);
  if (!local) {
    const wasRunning = Boolean(managedProcess);
    stopManagedProcess();
    return {
      selected_model: model,
      local: false,
      action: wasRunning ? "stopped" : "unchanged",
      health: getLocalRuntimeHealth(),
    };
  }

  try {
    const wasRunning = Boolean(managedProcess);
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
