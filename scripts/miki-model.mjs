import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
const serverPidPath = path.resolve(
  process.env.MIKI_LLAMA_PID_PATH?.trim() ||
    path.join(dataRoot, "data", "llama-server.pid.json"),
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
  Number.parseInt(process.env.MIKI_LOCAL_CONTEXT_SIZE || "16384", 10) || 16384,
);
function contextSizeFor(model) {
  return Math.max(
    8192,
    Number.parseInt(process.env.MIKI_LOCAL_CONTEXT_SIZE || "", 10) ||
      Number(model?.context_size) ||
      defaultContext,
  );
}

// Catalog models are fetched by id from pinned URLs with pinned hashes.
// Any other model is named explicitly with --url (HTTPS) or --path (local
// file); see customModelFromSource(). The manager never guesses a URL.
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
  {
    id: "gemma-4-E2B-it-Q4_0",
    alias: "gemma-4-e2b",
    provider: "llama.cpp",
    display_name: "Gemma 4 E2B Instruct Q4_0",
    filename: "google_gemma-4-E2B-it-Q4_0.gguf",
    url: "https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF/resolve/main/google_gemma-4-E2B-it-Q4_0.gguf?download=true",
    sha256: "2d9a803a627ee94230dc23681008ae340d9785a2374e2a6a0c8d69c7ee7ea47e",
    bytes: 3378740704,
    license: "apache-2.0",
    source: "https://huggingface.co/bartowski/google_gemma-4-E2B-it-GGUF",
    context_size: 32768,
  },
];

const GGUF_MAGIC = Buffer.from("GGUF", "ascii");
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;
// Flags whose next argument is a value rather than a positional model id.
const VALUE_FLAGS = new Set(["--url", "--path", "--sha256", "--name"]);

// Progress goes to stderr so stdout carries only the JSON result.
function log(message) {
  process.stderr.write(`[miki-model] ${message}\n`);
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
function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
function readServerPid() {
  const record = readJson(serverPidPath, null);
  if (!record || !processIsAlive(Number(record.pid))) {
    if (record) {
      try { fs.rmSync(serverPidPath, { force: true }); } catch { /* best effort */ }
    }
    return null;
  }
  return { ...record, pid: Number(record.pid) };
}
async function waitForLocalHealth(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) return true;
    } catch { /* server is still starting */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return false;
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

// Reads "--flag value" or "--flag=value". Returns undefined when absent.
function optionValue(args, flag) {
  const inline = args.find((arg) => arg.startsWith(`${flag}=`));
  if (inline !== undefined) return inline.slice(flag.length + 1).trim();
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) fail(`${flag} requires a value.`);
  return value.trim();
}
// Positional arguments, skipping flags and the values that belong to them.
function positionalArgs(args) {
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (VALUE_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    if (!arg.startsWith("-")) positional.push(arg);
  }
  return positional;
}
function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 64);
}
// URL shown in logs and output: never includes query strings, which may carry tokens.
function displayUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "the configured source";
  }
}
function isInside(file, directory) {
  return path.resolve(file).startsWith(`${path.resolve(directory)}${path.sep}`);
}
function isRegisteredAs(entry, model) {
  const name = String(entry?.model_name || "").toLowerCase();
  const id = String(entry?.model || "").toLowerCase();
  return name === model.alias.toLowerCase() || id === model.id.toLowerCase();
}
function assertGgufFile(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat || !stat.isFile()) fail(`GGUF file not found: ${file}`);
  const header = Buffer.alloc(GGUF_MAGIC.length);
  const descriptor = fs.openSync(file, "r");
  try {
    fs.readSync(descriptor, header, 0, header.length, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  if (!header.equals(GGUF_MAGIC)) fail(`${file} is not a GGUF model (missing GGUF header).`);
}
async function verifyLocalFile(file, expectedSha) {
  assertGgufFile(file);
  const digest = await sha256(file);
  if (expectedSha !== undefined && digest !== expectedSha) {
    fail(`SHA-256 mismatch for ${file}: expected ${expectedSha}, got ${digest}.`);
  }
  return {
    bytes: fs.statSync(file).size,
    sha256: digest,
    checksum_verified: expectedSha !== undefined,
    reused: false,
  };
}

// Validates a user-named model before any network access or file write.
function customModelFromSource({ url, localPath, sha256: expectedSha, name }) {
  if (expectedSha !== undefined && !SHA256_PATTERN.test(expectedSha)) {
    fail("--sha256 must be a 64-character hexadecimal SHA-256 digest.");
  }
  let sourceName;
  let sourceUrl;
  let sourceFile;
  if (url !== undefined) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      fail("--url is not a valid URL.");
    }
    let decodedPath;
    try {
      decodedPath = decodeURIComponent(parsed.pathname);
    } catch {
      fail("--url contains invalid percent-encoding.");
    }
    sourceUrl = parsed.href;
    sourceName = path.posix.basename(decodedPath);
  } else {
    sourceFile = path.resolve(localPath);
    sourceName = path.basename(sourceFile);
  }
  const alias = (name !== undefined ? name : slugify(sourceName.replace(/\.gguf$/i, ""))).toLowerCase();
  if (!ALIAS_PATTERN.test(alias)) {
    fail(`Model name '${alias}' is invalid. Use 2-64 letters, digits, '.', '_' or '-', starting with a letter or digit. Pass --name to choose one.`);
  }
  const catalogModel = modelEntry(alias);
  if (catalogModel) {
    fail(`'${alias}' is a catalog model name. Use 'install ${catalogModel.id}' or pass a different --name.`);
  }
  return {
    id: alias,
    alias,
    provider: "llama.cpp",
    display_name: `${alias} (custom GGUF)`,
    filename: `${alias}.gguf`,
    url: sourceUrl,
    sha256: expectedSha?.toLowerCase(),
    license: "user-supplied",
    source: sourceUrl ?? sourceFile,
    path: sourceFile ?? path.join(modelRoot, `${alias}.gguf`),
  };
}

async function downloadVerified(model, destination) {
  ensureDir(path.dirname(destination));
  const temporary = `${destination}.part-${process.pid}`;
  fs.rmSync(temporary, { force: true });
  log(`Downloading ${model.display_name} from ${displayUrl(model.url)}.`);
  const response = await fetch(model.url, {
    redirect: "follow",
    headers: { "User-Agent": "Agent-Miki-model-manager/1.0" },
  });
  if (!response.ok || !response.body) fail(`Download failed with HTTP ${response.status}.`);
  const contentLength = Number.parseInt(response.headers.get("content-length") || "0", 10);
  if (model.bytes !== undefined && contentLength && contentLength !== model.bytes) {
    fail(`Download size mismatch before transfer: expected ${model.bytes}, got ${contentLength}.`);
  }
  try {
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary, { mode: 0o600 }));
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  const bytes = fs.statSync(temporary).size;
  if (model.bytes !== undefined && bytes !== model.bytes) {
    fs.rmSync(temporary, { force: true });
    fail(`Downloaded size mismatch: expected ${model.bytes}, got ${bytes}.`);
  }
  try {
    assertGgufFile(temporary);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  const digest = await sha256(temporary);
  if (model.sha256 !== undefined && digest !== model.sha256) {
    fs.rmSync(temporary, { force: true });
    fail(`SHA-256 mismatch: expected ${model.sha256}, got ${digest}.`);
  }
  fs.renameSync(temporary, destination);
  return { bytes, sha256: digest, checksum_verified: model.sha256 !== undefined, reused: false };
}
function llamaExecutable() {
  const candidates = [
    process.env.MIKI_LLAMA_SERVER_BIN,
    path.join(dataRoot, "runtime", "native", executableName),
    path.join(projectRoot, "packages", "core", "dist", "llm", "local", "native", platformKey, executableName),
    path.join(projectRoot, "packages", "core", "src", "llm", "local", "native", platformKey, executableName),
    path.join(
      projectRoot,
      "packages",
      "core",
      "src",
      "plugins",
      "providers",
      "llama-cpp",
      "runtime",
      "native",
      platformKey,
      executableName,
    ),
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
      context_size: contextSizeFor(model),
      gpu_layers: "auto",
      enabled: true,
      auto_start: true,
      executable_path: llamaExecutable() || "",
      port: defaultPort,
      allowed_model_dirs: [path.dirname(modelPath)],
    },
  };
  // Gemma is the only model the offline package supports, so registering it
  // replaces the registry. Every other model only replaces its own entry.
  const gemmaOnly = model.id === "gemma-4-E2B-it-Q4_0";
  state.models = gemmaOnly
    ? []
    : state.models.filter((entry) => !isRegisteredAs(entry, model));
  state.models.unshift(record);
  writeJsonAtomic(statePath, state);
  writeEnvValues({
    MIKI_MODEL: `llama.cpp/${model.id}`,
    DEFAULT_MODEL: `llama.cpp/${model.id}`,
    MIKI_PROVIDER: "llama.cpp",
    MIKI_LLAMA_BASE_URL: `http://127.0.0.1:${defaultPort}/v1`,
    MIKI_LOCAL_MODEL_ENDPOINT: `http://127.0.0.1:${defaultPort}/v1`,
    MIKI_MODEL_PATH: modelPath,
    MIKI_MODEL_ID: model.id,
    MIKI_LOCAL_MODEL_NAME: model.alias,
    MIKI_LOCAL_CONTEXT_SIZE: String(contextSizeFor(model)),
  });
  return record;
}
function installedModels() {
  return MODEL_CATALOG.filter((model) => fs.existsSync(path.join(modelRoot, model.filename))).map((model) => ({
    ...model,
    path: path.join(modelRoot, model.filename),
  }));
}
function registeredModels() {
  const state = readJson(statePath, {});
  const entries = Array.isArray(state.models) ? state.models : [];
  return entries
    .filter((entry) => entry?.local?.model_path)
    .map((entry) => ({
      model_name: entry.model_name,
      model: entry.model,
      enabled: entry.enabled !== false,
      model_path: entry.local.model_path,
      present: fs.existsSync(entry.local.model_path),
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
  })), note: "Any other GGUF: install --url <https-url-to-gguf> or install --path <absolute-gguf>." }, null, 2));
}
async function install(modelId, shouldStart) {
  const model = modelEntry(modelId);
  if (!model) {
    fail(`Unknown model '${modelId}'. Use 'list' for the catalog, or pass --url <https-url-to-gguf> or --path <absolute-gguf> for another model.`);
  }
  const destination = path.join(modelRoot, model.filename);
  let result;
  if (fs.existsSync(destination)) {
    const digest = await sha256(destination);
    const bytes = fs.statSync(destination).size;
    if (digest !== model.sha256 || bytes !== model.bytes) {
      fs.rmSync(destination);
      fail(`Existing model failed integrity verification and was removed: ${destination}`);
    }
    result = { bytes, sha256: digest, checksum_verified: true, reused: true };
    log(`Reusing verified model at ${destination}.`);
  } else {
    result = await downloadVerified(model, destination);
  }
  const record = updateState(model, destination);
  log(`Installed and registered ${model.alias}.`);
  if (shouldStart) await start(model, record);
  console.log(JSON.stringify({ status: "installed", model: model.id, path: destination, ...result, auto_start: Boolean(shouldStart) }, null, 2));
}
// Downloads or registers one named model and writes the registry entry.
// Callers decide whether to start the server.
async function registerCustom(source) {
  const model = customModelFromSource(source);
  let result;
  if (model.url !== undefined && fs.existsSync(model.path)) {
    // Never overwrite or silently reuse a file we did not verify against a hash.
    if (model.sha256 === undefined) {
      fail(`${model.path} already exists. Pass its --sha256 to reuse it, or choose another --name.`);
    }
    result = { ...(await verifyLocalFile(model.path, model.sha256)), reused: true };
    log(`Reusing verified model at ${model.path}.`);
  } else if (model.url !== undefined) {
    result = await downloadVerified(model, model.path);
  } else {
    result = await verifyLocalFile(model.path, model.sha256);
  }
  const record = updateState(model, model.path);
  log(`Installed and registered ${model.alias}.`);
  return { model, record, result };
}
async function installCustom(source, shouldStart) {
  const { model, record, result } = await registerCustom(source);
  if (shouldStart) await start(model, record);
  console.log(JSON.stringify({
    status: "installed",
    model: model.id,
    path: model.path,
    source: model.url !== undefined ? displayUrl(model.url) : model.path,
    ...result,
    auto_start: Boolean(shouldStart),
  }, null, 2));
}
async function start(model, record) {
  const executable = record?.local?.executable_path || llamaExecutable();
  if (!executable) fail("llama-server was not found. Build the native runtime first or set MIKI_LLAMA_SERVER_BIN.");
  if (!fs.existsSync(executable)) fail(`llama-server does not exist: ${executable}`);
  const port = record?.local?.port || defaultPort;
  const modelPath = record?.local?.model_path || path.join(modelRoot, model.filename);
  const existing = readServerPid();
  if (existing && Number(existing.port) === Number(port)) {
    if (await waitForLocalHealth(port, 2_000)) {
      log(`llama-server is already healthy on http://127.0.0.1:${port}/v1 (pid ${existing.pid}).`);
      return;
    }
    try { process.kill(existing.pid, process.platform === "win32" ? undefined : "SIGTERM"); } catch { /* stale process */ }
  }
  const child = spawn(executable, [
    "--model", modelPath,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--ctx-size", String(contextSizeFor(model)),
    "--n-predict", process.env.MIKI_LOCAL_MAX_TOKENS || "2048",
    "--alias", model.id,
    "--chat-template-kwargs", '{"enable_thinking":false}',
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  writeJsonAtomic(serverPidPath, {
    pid: child.pid,
    port,
    model: model.id,
    executable,
    startedAt: new Date().toISOString(),
  });
  const healthy = await waitForLocalHealth(port);
  if (!healthy) {
    try { process.kill(child.pid, process.platform === "win32" ? undefined : "SIGTERM"); } catch { /* best effort */ }
    try { fs.rmSync(serverPidPath, { force: true }); } catch { /* best effort */ }
    fail(`llama-server did not become healthy on http://127.0.0.1:${port}`);
  }
  log(`Started healthy llama-server on http://127.0.0.1:${port}/v1 (pid ${child.pid}).`);
}
// ---- Autonomous discovery on the Hugging Face hub --------------------------
// Only public, non-gated repositories are used. Gated repositories need a
// license acceptance and a token, which this manager does not send.
const AUTO_MODEL_MAX_BYTES_DEFAULT = Number.POSITIVE_INFINITY; // no size limit by default
const AUTO_MAX_CANDIDATES = 8;
const AUTO_MAX_ATTEMPTS = 3;
// Lower index is preferred. Q4_K_M balances quality, size, and speed locally.
const QUANT_PREFERENCE = ["Q4_K_M", "Q4_K_S", "Q4_0", "Q5_K_M", "Q5_K_S", "Q4_1", "Q5_0", "Q6_K", "Q8_0"];

function hubEndpoint() {
  const value = (process.env.HF_ENDPOINT?.trim() || "https://huggingface.co").replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    fail("HF_ENDPOINT is not a valid URL.");
  }
  return value;
}
function repoPath(repoId) {
  return repoId.split("/").map(encodeURIComponent).join("/");
}
function resolveUrl(repoId, filename) {
  const file = filename.split("/").map(encodeURIComponent).join("/");
  return `${hubEndpoint()}/${repoPath(repoId)}/resolve/main/${file}?download=true`;
}
async function hubJson(pathname, params) {
  const url = new URL(`${hubEndpoint()}${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Agent-Miki-model-manager/1.0", Accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) fail(`Model hub request failed with HTTP ${response.status}: ${displayUrl(url.href)}`);
  return response.json();
}
async function remoteSize(url) {
  const response = await fetch(url, {
    method: "HEAD",
    redirect: "follow",
    headers: { "User-Agent": "Agent-Miki-model-manager/1.0" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) return 0;
  return Number.parseInt(response.headers.get("content-length") || "0", 10) || 0;
}
function isChatModelFile(filename) {
  return (
    /\.gguf$/i.test(filename) &&
    !/mmproj/i.test(filename) && // vision projector, not a standalone model
    !/-\d{5}-of-\d{5}\.gguf$/i.test(filename) // split shards need a merge step
  );
}
function quantRank(filename) {
  const upper = filename.toUpperCase();
  const index = QUANT_PREFERENCE.findIndex((quant) => upper.includes(quant));
  return index < 0 ? QUANT_PREFERENCE.length : index;
}
function looksInstructTuned(text) {
  return /instruct|chat|assistant|(^|[-_.])it([-_.]|$)/i.test(text);
}
async function discoverCandidates(query, maxBytes, limit) {
  const listing = await hubJson("/api/models", {
    filter: "gguf",
    pipeline_tag: "text-generation",
    sort: "downloads",
    direction: -1,
    limit: 25,
    search: query,
  });
  const candidates = [];
  for (const repo of Array.isArray(listing) ? listing : []) {
    if (!repo?.id) continue;
    let detail;
    try {
      detail = await hubJson(`/api/models/${repoPath(repo.id)}`, { blobs: true });
    } catch (error) {
      // A repository that cannot be read (for example one that needs a token) is skipped.
      log(`Skipping ${repo.id}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    for (const sibling of Array.isArray(detail?.siblings) ? detail.siblings : []) {
      const filename = String(sibling?.rfilename || "");
      if (!isChatModelFile(filename)) continue;
      const url = resolveUrl(repo.id, filename);
      const size = Number(sibling.size ?? sibling.lfs?.size ?? 0) || (await remoteSize(url));
      if (!size || size > maxBytes) continue;
      candidates.push({
        repo: repo.id,
        filename,
        size,
        sha256: typeof sibling.lfs?.sha256 === "string" ? sibling.lfs.sha256.toLowerCase() : undefined,
        url,
        instruct: looksInstructTuned(`${repo.id} ${filename}`),
        quant: quantRank(filename),
      });
    }
    if (candidates.length >= limit) break;
  }
  return candidates.sort(
    (a, b) => Number(!a.instruct) - Number(!b.instruct) || a.quant - b.quant || a.size - b.size,
  );
}
function assertFreeSpace(directory, requiredBytes) {
  ensureDir(directory);
  const stats = fs.statfsSync(directory);
  const available = Number(stats.bavail) * Number(stats.bsize);
  if (available < requiredBytes) {
    fail(`Not enough free disk space in ${directory}: need about ${requiredBytes} bytes, have ${available}.`);
  }
}
async function auto(args, shouldStart) {
  const query = optionValue(args, "--query") ?? "";
  const maxBytes = Number(
    optionValue(args, "--max-bytes") ??
      process.env.MIKI_AUTO_MODEL_MAX_BYTES ??
      AUTO_MODEL_MAX_BYTES_DEFAULT,
  );
  if (Number.isNaN(maxBytes) || maxBytes <= 0) fail("--max-bytes must be a positive number of bytes.");
  const candidates = await discoverCandidates(query, maxBytes, AUTO_MAX_CANDIDATES);
  if (!candidates.length) {
    fail(`No GGUF chat model up to ${maxBytes} bytes was found${query ? ` for '${query}'` : ""}.`);
  }
  if (args.includes("--dry-run")) {
    console.log(JSON.stringify({ status: "dry-run", candidates: candidates.map(({ url, ...rest }) => rest) }, null, 2));
    return;
  }
  const failures = [];
  let chosen;
  for (const candidate of candidates.slice(0, AUTO_MAX_ATTEMPTS)) {
    // Owner prefix keeps aliases clear of catalog ids such as gemma-4-e2b-it-q4_0.
    const name = slugify(`${candidate.repo.split("/")[0]}-${candidate.filename.replace(/\.gguf$/i, "")}`);
    try {
      log(`Selected ${candidate.repo}/${candidate.filename} (${candidate.size} bytes).`);
      chosen = { candidate, ...(await registerCustom({ url: candidate.url, sha256: candidate.sha256, name })) };
      break;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${candidate.repo}/${candidate.filename}: ${reason}`);
      log(`Skipping candidate: ${reason}`);
    }
  }
  if (!chosen) fail(`Automatic install failed for every candidate:\n${failures.join("\n")}`);
  if (shouldStart) await start(chosen.model, chosen.record);
  console.log(JSON.stringify({
    status: "installed",
    selected: chosen.candidate.repo,
    file: chosen.candidate.filename,
    model: chosen.model.id,
    path: chosen.model.path,
    source: displayUrl(chosen.candidate.url),
    ...chosen.result,
    auto_start: Boolean(shouldStart),
  }, null, 2));
}
async function status() {
  console.log(JSON.stringify({
    platform: platformKey,
    model_dir: modelRoot,
    config: envPath,
    state: statePath,
    server_pid: serverPidPath,
    server_process: readServerPid(),
    runtime: llamaExecutable() || null,
    installed: installedModels().map((model) => ({ id: model.id, alias: model.alias, path: model.path, bytes: fs.statSync(model.path).size })),
    registered: registeredModels(),
  }, null, 2));
}
function remove(modelId) {
  const model = modelEntry(modelId);
  const state = readJson(statePath, {});
  const entries = Array.isArray(state.models) ? state.models : [];
  if (!model) {
    const wanted = modelId.toLowerCase();
    const registration = entries.find(
      (entry) =>
        String(entry?.model_name || "").toLowerCase() === wanted ||
        String(entry?.model || "").toLowerCase() === wanted,
    );
    if (!registration) fail(`Unknown model '${modelId}'. Use 'list' for the catalog or 'status' for registered models.`);
    const modelPath = registration.local?.model_path;
    if (modelPath && isInside(modelPath, modelRoot)) {
      fs.rmSync(modelPath, { force: true });
      log(`Deleted ${modelPath}.`);
    } else if (modelPath) {
      // Files registered with --path belong to the user; only the registration is removed.
      log(`Kept ${modelPath}: it lies outside the model directory and was not copied.`);
    }
    state.models = entries.filter((entry) => entry !== registration);
    writeJsonAtomic(statePath, state);
    log(`Removed registration ${registration.model_name}.`);
    return;
  }
  const destination = path.join(modelRoot, model.filename);
  fs.rmSync(destination, { force: true });
  state.models = entries.filter((entry) => !isRegisteredAs(entry, model));
  writeJsonAtomic(statePath, state);
  log(`Removed ${model.alias} and its persisted local-model registration.`);
}
function usage() {
  console.log(`Agent Miki self-service LLM manager

Commands:
  list                                    Show the pinned catalog
  status                                  Show installed catalog models and registered models
  install <model-id|alias>                Download, verify, install, and register a catalog model
  install --url <https-url-to-gguf>       Download any HTTPS GGUF, verify it, and register it
          [--name <alias>] [--sha256 <hex>]
  install --path <absolute-gguf>          Register a GGUF already on disk (it is not copied)
          [--name <alias>] [--sha256 <hex>]
  install <...> --start                   Also start llama-server and wait for it to be healthy
  auto [--query <text>] [--max-bytes <n>] [--dry-run] [--start]
                                          Find a public GGUF chat model on the Hugging Face hub,
                                          download it with its published SHA-256, and register it
  remove <model-id|alias|name>            Remove a model file (managed downloads) and its registration

Environment:
  MIKI_MODEL_DIR, MIKI_RUNTIME_ROOT, MIKI_STATE_PATH, MIKI_CONFIG_DIR
  MIKI_LLAMA_SERVER_BIN, MIKI_LOCAL_PORT, MIKI_LOCAL_CONTEXT_SIZE
  HF_ENDPOINT (default https://huggingface.co), MIKI_AUTO_MODEL_MAX_BYTES
`);
}
const command = process.argv[2] || "list";
const args = process.argv.slice(3);
try {
  if (command === "help" || command === "--help" || command === "-h") usage();
  else if (command === "list") printCatalog();
  else if (command === "status") await status();
  else if (command === "install") {
    const shouldStart = args.includes("--start");
    const url = optionValue(args, "--url");
    const localPath = optionValue(args, "--path");
    const sha256Value = optionValue(args, "--sha256");
    const name = optionValue(args, "--name");
    const positional = positionalArgs(args);
    if (url !== undefined && localPath !== undefined) fail("Use either --url or --path, not both.");
    if (url !== undefined || localPath !== undefined) {
      if (positional.length) fail("Do not combine a catalog model id with --url or --path.");
      await installCustom({ url, localPath, sha256: sha256Value, name }, shouldStart);
    } else {
      if (sha256Value !== undefined || name !== undefined) {
        fail("--sha256 and --name apply only with --url or --path.");
      }
      const modelId = positional[0];
      if (!modelId) {
        fail("install requires a catalog model id, --url <https-url-to-gguf>, or --path <absolute-gguf>.");
      }
      await install(modelId, shouldStart);
    }
  } else if (command === "auto") {
    await auto(args, args.includes("--start"));
  } else if (command === "remove") {
    const modelId = positionalArgs(args)[0];
    if (!modelId) fail("remove requires a model id, alias, or registered model name.");
    remove(modelId);
  } else fail(`Unknown command '${command}'.`);
} catch (error) {
  console.error(`[miki-model] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
