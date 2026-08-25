import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const platformKey = `${process.platform}-${process.arch}`;
const executableName = process.platform === "win32" ? "llama-server.exe" : "llama-server";
const nodeDataBase =
  process.env.MIKI_DATA_ROOT?.trim() ||
  process.env.XDG_DATA_HOME?.trim() ||
  (process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : path.join(os.homedir(), ".local", "share"));
const dataRoot = path.resolve(
  process.env.MIKI_RUNTIME_ROOT?.trim() || path.join(nodeDataBase, "miki"),
);
const modelRoot = path.resolve(
  process.env.MIKI_MODEL_DIR?.trim() || path.join(dataRoot, "models"),
);
const statePath = path.resolve(
  process.env.MIKI_STATE_PATH?.trim() || path.join(dataRoot, "data", "launcher-state.json"),
);
const configDir = path.resolve(
  process.env.MIKI_CONFIG_DIR?.trim() ||
    (fs.existsSync(path.join(projectRoot, "config", ".env.example"))
      ? path.join(projectRoot, "config")
      : path.join(dataRoot, "config")),
);
const envPath = path.join(configDir, ".env");
const defaultPort = Number.parseInt(process.env.MIKI_LOCAL_PORT || "39200", 10) || 39200;
const defaultContext = Math.max(
  8192,
  Number.parseInt(process.env.MIKI_LOCAL_CONTEXT_SIZE || "32768", 10) || 32768,
);

// Only models listed here may be fetched. URLs and hashes are pinned to public,
// documented artifacts; arbitrary URLs are intentionally not accepted.
const MODEL_CATALOG = [
  {
    id: "lfm2.5-1.2b-instruct-q4_0",
    alias: "lfm2.5-local-1.2b",
    provider: "llama.cpp",
    display_name: "LFM2.5 1.2B Instruct Q4_0",
    filename: "LFM2.5-1.2B-Instruct-Q4_0.gguf",
    url: "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF/resolve/main/LFM2.5-1.2B-Instruct-Q4_0.gguf?download=true",
    sha256: "2ea801949d760cdf1a2cc04a54262c22c3c0c54f0769d57760c9adeb0e59233f",
    bytes: 695751488,
    license: "lfm1.0",
    source: "https://huggingface.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
    context_size: 32768,
  },
];

function log(message) {
  console.log(`[miki-model] ${message}`);
}
function fail(message) {
  throw new Error(message);
}
function ensureDir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}
function readEnv(file) {
  try {
    return fs.readFileSync(file, "utf8").split(/\r?\n/);
  } catch {
    return ["# Agent Miki model-manager settings"];
  }
}
function writeEnvValues(values) {
  const lines = readEnv(envPath);
  for (const [key, value] of Object.entries(values)) {
    const escaped = key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
    const index = lines.findIndex((line) => new RegExp(`^${escaped}\\s*=`).test(line));
    const next = `${key}=${value}`;
    if (index >= 0) lines[index] = next;
    else lines.push(next);
  }
  ensureDir(configDir);
  fs.writeFileSync(envPath, `${lines.join("\n").replace(/\n+$/, "")}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}
function modelEntry(modelId) {
  const normalized = String(modelId || "").trim().toLowerCase();
  return MODEL_CATALOG.find(
    (item) =>
      item.id.toLowerCase() === normalized ||
      item.alias.toLowerCase() === normalized ||
      item.filename.toLowerCase() === normalized,
  );
}
function sha256(file) {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(file);
  return new Promise((resolve, reject) => {
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}
async function downloadVerified(model, destination) {
  ensureDir(path.dirname(destination));
  const temporary = `${destination}.part-${process.pid}`;
  fs.rmSync(temporary, { force: true });
  log(`Downloading ${model.display_name} from the pinned official source.`);
  const response = await fetch(model.url, {
    redirect: "follow",
    headers: { "User-Agent": "Agent-Miki-model-manager/1.0" },
  });
  if (!response.ok || !response.body) fail(`Download failed with HTTP ${response.status}.`);
  const expected = model.bytes;
  const contentLength = Number.parseInt(response.headers.get("content-length") || "0", 10);
  if (contentLength && contentLength !== expected) {
    fail(`Download size mismatch before transfer: expected ${expected}, got ${contentLength}.`);
  }
  const output = fs.createWriteStream(temporary, { mode: 0o600 });
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      output.write(chunk);
    }
  } finally {
    output.end();
    await new Promise((resolve) => output.once("close", resolve));
  }
  if (bytes !== expected) {
    fs.rmSync(temporary, { force: true });
    fail(`Downloaded size mismatch: expected ${expected}, got ${bytes}.`);
  }
  const digest = await sha256(temporary);
  if (digest !== model.sha256) {
    fs.rmSync(temporary, { force: true });
    fail(`SHA-256 mismatch: expected ${model.sha256}, got ${digest}.`);
  }
  fs.renameSync(temporary, destination);
  return { bytes, sha256: digest };
}
function llamaExecutable() {
  const candidates = [
    process.env.MIKI_LLAMA_SERVER_BIN,
    path.join(dataRoot, "runtime", "native", executableName),
    path.join(projectRoot, "packages", "core", "dist", "llm", "local", "native", platformKey, executableName),
    path.join(projectRoot, "packages", "core", "src", "llm", "local", "native", platformKey, executableName),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}
function updateState(model, modelPath) {
  const state = readJson(statePath, {});
  if (!Array.isArray(state.models)) state.models = [];
  const record = {
    model_name: model.alias,
    provider: "llama.cpp",
    model: model.id,
    api_base: `http://127.0.0.1:${defaultPort}/v1`,
    auth_method: "none",
    enabled: true,
    local: {
      runtime: "llama.cpp",
      model_path: modelPath,
      model_format: "gguf",
      display_name: model.display_name,
      context_size: model.context_size || defaultContext,
      gpu_layers: "auto",
      enabled: true,
      auto_start: true,
      executable_path: llamaExecutable() || "",
      port: defaultPort,
      allowed_model_dirs: [modelRoot],
    },
  };
  state.models = state.models.filter((entry) => {
    const text = JSON.stringify(entry).toLowerCase();
    return !text.includes(model.alias.toLowerCase()) && !text.includes(model.id.toLowerCase());
  });
  state.models.unshift(record);
  writeJsonAtomic(statePath, state);
  writeEnvValues({
    MIKI_MODEL: `llama.cpp/${model.id}`,
    DEFAULT_MODEL: `llama.cpp/${model.id}`,
    MIKI_PROVIDER: "llama.cpp",
    MIKI_MODEL_PATH: modelPath,
    MIKI_MODEL_ID: model.id,
    MIKI_LOCAL_MODEL_NAME: model.alias,
    MIKI_LOCAL_CONTEXT_SIZE: String(model.context_size || defaultContext),
  });
  return record;
}
function installedModels() {
  return MODEL_CATALOG.filter((model) => fs.existsSync(path.join(modelRoot, model.filename))).map((model) => ({
    ...model,
    path: path.join(modelRoot, model.filename),
  }));
}
function printCatalog() {
  console.log(JSON.stringify({ platform: platformKey, model_dir: modelRoot, catalog: MODEL_CATALOG.map((model) => ({
    id: model.id,
    alias: model.alias,
    display_name: model.display_name,
    bytes: model.bytes,
    sha256: model.sha256,
    license: model.license,
    source: model.source,
    installed: fs.existsSync(path.join(modelRoot, model.filename)),
  })) }, null, 2));
}
async function install(modelId, shouldStart) {
  const model = modelEntry(modelId);
  if (!model) fail(`Unknown model '${modelId}'. Use 'list' to see the allow-listed catalog.`);
  const destination = path.join(modelRoot, model.filename);
  let result;
  if (fs.existsSync(destination)) {
    const digest = await sha256(destination);
    const bytes = fs.statSync(destination).size;
    if (digest !== model.sha256 || bytes !== model.bytes) {
      fs.rmSync(destination);
      fail(`Existing model failed integrity verification and was removed: ${destination}`);
    }
    result = { bytes, sha256: digest, reused: true };
    log(`Reusing verified model at ${destination}.`);
  } else {
    result = await downloadVerified(model, destination);
  }
  const record = updateState(model, destination);
  log(`Installed and registered ${model.alias}.`);
  if (shouldStart) await start(model, record);
  console.log(JSON.stringify({ status: "installed", model: model.id, path: destination, ...result, auto_start: Boolean(shouldStart) }, null, 2));
}
async function start(model, record) {
  const executable = record?.local?.executable_path || llamaExecutable();
  if (!executable) fail("llama-server was not found. Build the native runtime first or set MIKI_LLAMA_SERVER_BIN.");
  if (!fs.existsSync(executable)) fail(`llama-server does not exist: ${executable}`);
  const port = record?.local?.port || defaultPort;
  const child = spawn(executable, [
    "--model", path.join(modelRoot, model.filename),
    "--host", "127.0.0.1",
    "--port", String(port),
    "--ctx-size", String(model.context_size || defaultContext),
    "--n-predict", process.env.MIKI_LOCAL_MAX_TOKENS || "512",
    "--alias", model.id,
    "--chat-template-kwargs", '{"enable_thinking":false}',
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  log(`Started llama-server in the background on http://127.0.0.1:${port}/v1 (pid ${child.pid}).`);
}
async function status() {
  console.log(JSON.stringify({
    platform: platformKey,
    model_dir: modelRoot,
    config: envPath,
    state: statePath,
    runtime: llamaExecutable() || null,
    installed: installedModels().map((model) => ({ id: model.id, alias: model.alias, path: model.path, bytes: fs.statSync(model.path).size })),
  }, null, 2));
}
function remove(modelId) {
  const model = modelEntry(modelId);
  if (!model) fail(`Unknown model '${modelId}'. Use 'list' to see the allow-listed catalog.`);
  const destination = path.join(modelRoot, model.filename);
  fs.rmSync(destination, { force: true });
  const state = readJson(statePath, {});
  if (Array.isArray(state.models)) {
    state.models = state.models.filter((entry) => !JSON.stringify(entry).toLowerCase().includes(model.id.toLowerCase()));
    writeJsonAtomic(statePath, state);
  }
  log(`Removed ${model.alias} and its persisted local-model registration.`);
}
function usage() {
  console.log(`Agent Miki self-service LLM manager\n\nCommands:\n  list                         Show the pinned model catalog\n  status                       Show installed models and runtime paths\n  install <model-id|alias>     Download, verify, install, and register a model\n  install <model> --start      Also start the local llama.cpp server\n  remove <model-id|alias>      Remove an installed allow-listed model\n\nEnvironment:\n  MIKI_MODEL_DIR, MIKI_RUNTIME_ROOT, MIKI_STATE_PATH, MIKI_CONFIG_DIR\n  MIKI_LLAMA_SERVER_BIN, MIKI_LOCAL_PORT, MIKI_LOCAL_CONTEXT_SIZE\n`);
}
const command = process.argv[2] || "list";
const args = process.argv.slice(3);
try {
  if (command === "help" || command === "--help" || command === "-h") usage();
  else if (command === "list") printCatalog();
  else if (command === "status") await status();
  else if (command === "install") {
    const modelId = args.find((arg) => !arg.startsWith("-"));
    if (!modelId) fail("install requires a model id or alias.");
    await install(modelId, args.includes("--start"));
  } else if (command === "remove") {
    const modelId = args.find((arg) => !arg.startsWith("-"));
    if (!modelId) fail("remove requires a model id or alias.");
    remove(modelId);
  } else fail(`Unknown command '${command}'.`);
} catch (error) {
  console.error(`[miki-model] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
