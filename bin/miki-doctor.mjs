#!/usr/bin/env node
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { register } from "node:module";
import yaml from "js-yaml";
import Database from "better-sqlite3";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

// The always-on Linux installer keeps mutable config/data in a separate
// workspace. When doctor is run interactively, it should inspect the same paths
// as the systemd service rather than accidentally checking the source checkout.
function applyMatchingServicePaths() {
  const candidates = [
    process.env.MIKI_ENV_FILE,
    ...(process.platform === "linux" ? ["/etc/agent-miki/agent-miki.env"] : []),
    ...(process.platform === "win32" ? [path.join(PROJECT_ROOT, "config", "agent-miki.env")] : []),
  ].filter(Boolean);
  for (const candidate of candidates) {
    let contents;
    try { contents = fs.readFileSync(candidate, "utf8"); } catch { continue; }
    const values = {};
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || line.trimStart().startsWith("#")) continue;
      values[match[1]] = match[2].replace(/^(["'])(.*)\1$/, "$2");
    }
    // Do not accidentally inspect another Miki installation on a multi-agent host.
    if (!values.MIKI_SOURCE_ROOT || path.resolve(values.MIKI_SOURCE_ROOT) !== PROJECT_ROOT) continue;
    for (const name of ["MIKI_WORKSPACE_DIR", "MIKI_RUNTIME_ROOT", "MIKI_CONFIG_DIR", "MIKI_DATA_DIR", "MIKI_LLAMA_MODEL_PATH"]) {
      if (!process.env[name] && values[name]) process.env[name] = values[name];
    }
    break;
  }
}
applyMatchingServicePaths();
const EFFECTIVE_WORKSPACE_DIR = path.resolve(process.env.MIKI_WORKSPACE_DIR || PROJECT_ROOT);
const EFFECTIVE_CONFIG_DIR = path.resolve(process.env.MIKI_CONFIG_DIR || path.join(EFFECTIVE_WORKSPACE_DIR, "config"));
const EFFECTIVE_DATA_DIR = path.resolve(process.env.MIKI_DATA_DIR || path.join(EFFECTIVE_WORKSPACE_DIR, "data"));

// Register runtime loader for @miki/* package resolution
const loaderPath = path.join(
  PROJECT_ROOT,
  "dist",
  "runtime",
  "runtime-loader.mjs",
);
if (fs.existsSync(loaderPath)) {
  try {
    register(pathToFileURL(loaderPath).href, pathToFileURL(PROJECT_ROOT + "/"));
  } catch (e) {
    // fallback: try with parent URL pointing to the loader directory
    try {
      const parentURL = pathToFileURL(path.dirname(loaderPath) + "/").href;
      register(pathToFileURL(loaderPath).href, parentURL);
    } catch (e2) {
      console.error("Failed to register runtime loader:", e2.message);
    }
  }
}

const args = new Set(process.argv.slice(2));

const RUNTIME_FILE_CANDIDATES = [
  [
    "packages/gateway/dist/index.js",
    "dist/runtime/packages/gateway/dist/index.js",
  ],
  [
    "packages/core/dist/api/index.js",
    "dist/runtime/packages/core/dist/api/index.js",
  ],
  [
    "packages/config/dist/index.js",
    "dist/runtime/packages/config/dist/index.js",
  ],
  [
    "packages/installer/dist/index.js",
    "dist/runtime/packages/installer/dist/index.js",
  ],
  [
    "packages/skills/dist/index.js",
    "dist/runtime/packages/skills/dist/index.js",
  ],
  [
    "packages/ui/frontend/dist/index.html",
    "dist/runtime/packages/ui/frontend/dist/index.html",
  ],
];

const SECRET_PATTERNS = [
  ["openai_key", /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ["slack_token", /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g],
  [
    "jwt_like_token",
    /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}\b/g,
  ],
  [
    "generic_secret_assignment",
    /\b(?:api[_-]?key|token|secret|password|refresh[_-]?token|access[_-]?token)[ \t]*[:=][ \t]*["']?[^"'\s,}]{12,}/gi,
  ],
];

function check(id, label, status, message, details = undefined) {
  return { id, label, status, message, details };
}

function commandVersion(command, commandArgs) {
  const result = childProcess.spawnSync(command, commandArgs, {
    cwd: PROJECT_ROOT,
    encoding: "utf-8",
    shell: process.platform === "win32",
    timeout: 10000,
  });
  return result.status === 0
    ? String(result.stdout || result.stderr).trim()
    : null;
}

function npmCommand() {
  const isWin = process.platform === "win32";
  return { command: isWin ? "npm.cmd" : "npm", args: [] };
}

function writableDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `.doctor-${process.pid}.tmp`);
  fs.writeFileSync(target, "ok", "utf-8");
  fs.rmSync(target, { force: true });
}

function sqliteWritable() {
  const dataDir = EFFECTIVE_DATA_DIR;
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, `.doctor-${process.pid}.sqlite`);
  const db = new Database(target);
  try {
    db.exec("CREATE TABLE doctor_check (id INTEGER PRIMARY KEY);");
  } finally {
    db.close();
    fs.rmSync(target, { force: true });
  }
}

function alwaysOnSupervisorCheck() {
  const stateFile = path.join(EFFECTIVE_DATA_DIR, "24-7-supervisor.json");
  let state;
  try {
    state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  } catch {
    return check(
      "always_on_supervisor",
      "24/7 supervisor",
      "warn",
      "No supervisor state was found. Miki may be running in foreground mode only; install and enable the OS startup service for reboot persistence.",
    );
  }
  const pid = Number(state.pid);
  let parentAlive = Number.isInteger(pid) && pid > 0;
  if (parentAlive) {
    try { process.kill(pid, 0); } catch (error) { parentAlive = error?.code === "EPERM"; }
  }
  const gatewayPid = Number(state.gatewayPid);
  let gatewayAlive = Number.isInteger(gatewayPid) && gatewayPid > 0;
  if (gatewayAlive) {
    try { process.kill(gatewayPid, 0); } catch (error) { gatewayAlive = error?.code === "EPERM"; }
  }
  const heartbeatAt = Date.parse(String(state.heartbeatAt || state.updatedAt || ""));
  const heartbeatFresh = Number.isFinite(heartbeatAt) && Date.now() - heartbeatAt < 90_000 && Date.now() >= heartbeatAt;
  const running = state.status === "running" && parentAlive && gatewayAlive && heartbeatFresh;
  return check(
    "always_on_supervisor",
    "24/7 supervisor",
    running ? "pass" : "warn",
    running
      ? `Supervisor PID ${pid} and gateway PID ${gatewayPid} are alive; heartbeat is recent.`
      : `Supervisor is not confirmed healthy (state=${String(state.status || "unknown")}, parent=${parentAlive ? "alive" : "missing"}, gateway=${gatewayAlive ? "alive" : "missing"}, heartbeat=${heartbeatFresh ? "fresh" : "stale"}). Check the OS service logs and restart the service if needed.`,
    { state: String(state.status || "unknown"), parentAlive, gatewayAlive, heartbeatFresh },
  );
}

async function savedDefaultModelStatus() {
  const databaseFile = path.join(EFFECTIVE_DATA_DIR, "miki-runtime.sqlite");
  if (!fs.existsSync(databaseFile)) return null;
  let db;
  try {
    db = new Database(databaseFile, { readonly: true, fileMustExist: true });
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_configs'").get();
    if (!table) return null;
    const row = db.prepare("SELECT id, payload FROM model_configs WHERE is_default=1 ORDER BY id LIMIT 1").get();
    if (!row) return null;
    const payload = JSON.parse(row.payload);
    const model = String(payload.model || payload.model_name || "").trim();
    const provider = String(payload.provider || "openai-compatible").trim().toLowerCase();
    if (!model || payload.enabled === false) return { model, provider, credentialConfigured: false };
    const local = payload.local && typeof payload.local === "object" ? payload.local : {};
    const localModelPath = String(local.model_path || process.env.MIKI_LLAMA_MODEL_PATH || "").trim();
    let credentialConfigured = Boolean(payload.api_key_ref || payload.api_key);
    if (payload.api_key_ref) {
      try {
        const { createWorkspaceSecretVault } = await import("@miki/config");
        credentialConfigured = Boolean(createWorkspaceSecretVault(EFFECTIVE_CONFIG_DIR).get(String(payload.api_key_ref)));
      } catch {
        // Do not fail diagnosis if the encrypted-vault package is unavailable.
      }
    }
    const envKeys = {
      openai: process.env.OPENAI_API_KEY,
      gpt: process.env.OPENAI_API_KEY,
      chatgpt: process.env.OPENAI_API_KEY,
      gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      google: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
      openrouter: process.env.OPENROUTER_API_KEY,
      "openai-compatible": process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY,
      compatible: process.env.OPENAI_COMPATIBLE_API_KEY || process.env.OPENAI_API_KEY,
    };
    credentialConfigured = credentialConfigured || Boolean(String(envKeys[provider] || "").trim());
    const keyOptional = ["openai-compatible", "compatible", "openai_compatible"].includes(provider);
    const localModelPresent = ["llama.cpp", "llama-cpp", "llamacpp", "local"].includes(provider) && Boolean(localModelPath && fs.existsSync(localModelPath));
    return {
      model,
      provider,
      credentialConfigured: credentialConfigured || keyOptional || localModelPresent,
      localModelPresent,
      id: row.id,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

function walkFiles(root) {
  if (!fs.existsSync(root)) return [];
  const stat = fs.statSync(root);
  if (stat.isFile()) return [root];
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", "dist", "backups", "output"].includes(entry.name)) {
      continue;
    }
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(child));
    if (entry.isFile()) files.push(child);
  }
  return files;
}

function redactedPreview(value) {
  if (value.length <= 12) return "[REDACTED]";
  return `${value.slice(0, 4)}...[REDACTED]...${value.slice(-4)}`;
}

function isPlaceholderSecret(value) {
  const normalized = value.toLowerCase();
  const assignmentValue =
    normalized.match(/[:=][ \t]*["']?([^"'\s,}]+)["']?$/)?.[1] || normalized;
  return (
    normalized.includes("os.environ/") ||
    normalized.includes("process.env.") ||
    normalized.includes("process.env[") ||
    normalized.includes("${") ||
    normalized.includes("[redacted]") ||
    /^[a-z][a-z0-9_]{7,}$/.test(assignmentValue) ||
    /^(?:local|default|example|placeholder|change[_-]?me|your[_-]?)/i.test(
      assignmentValue,
    )
  );
}

function secretScan() {
  const candidates = [
    path.join(PROJECT_ROOT, ".env"),
    ...walkFiles(EFFECTIVE_CONFIG_DIR),
    ...walkFiles(path.join(PROJECT_ROOT, "docs")),
  ].filter((file) => /\.(env|json|ya?ml|md|txt|log)$/i.test(file));
  const findings = [];
  for (const file of candidates) {
    let content = "";
    try {
      content = fs.readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const [id, pattern] of SECRET_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content))) {
        if (isPlaceholderSecret(match[0])) continue;
        const prefix = content.slice(0, match.index);
        const line = prefix.split(/\r?\n/).length;
        findings.push({
          file: path.relative(PROJECT_ROOT, file),
          line,
          pattern: id,
          redactedPreview: redactedPreview(match[0]),
        });
      }
    }
  }
  return { scannedFiles: candidates.length, findings };
}

function parseConfig() {
  const configPath = path.join(EFFECTIVE_CONFIG_DIR, "agent.yaml");
  if (!fs.existsSync(configPath)) return {};
  return yaml.load(fs.readFileSync(configPath, "utf-8")) || {};
}

async function configValidationCheck() {
  let parsed;
  try {
    parsed = parseConfig();
  } catch (err) {
    return check("config_validation", "Runtime config", "fail", err.message);
  }

  try {
    const { validateRuntimeConfig } = await import("@miki/config/schema");
    const result = validateRuntimeConfig(parsed);
    return check(
      "config_validation",
      "Runtime config",
      result.valid ? (result.warnings.length ? "warn" : "pass") : "fail",
      result.valid
        ? "Runtime config is valid."
        : result.errors
            .map((item) => `${item.path}: ${item.message}`)
            .join("; "),
      { warnings: result.warnings },
    );
  } catch (err) {
    return check(
      "config_validation",
      "Runtime config",
      "warn",
      `config/agent.yaml parses, but schema validation is unavailable: ${err.message}`,
    );
  }
}

async function secretVaultCheck() {
  try {
    const { inspectEnvSecretStatus } = await import("@miki/config");
    const secretStatus = inspectEnvSecretStatus({ workspaceDir: EFFECTIVE_WORKSPACE_DIR });
    const envOnly = secretStatus
      .filter((item) => item.envOnly)
      .map((item) => item.key);
    return check(
      "secret_vault",
      "Secret vault",
      envOnly.length === 0 ? "pass" : "warn",
      envOnly.length === 0
        ? "Secret vault is available and no env-only secrets were detected."
        : "Some secrets are only available from environment fallback.",
      {
        vaultSecretCount: secretStatus.filter((item) => item.inVault).length,
        envOnlyKeys: envOnly,
      },
    );
  } catch (err) {
    return check("secret_vault", "Secret vault", "fail", err.message);
  }
}

async function playwrightChromiumCheck() {
  try {
    const { chromium } = await import("playwright");
    const configured = [
      process.env.MIKI_BROWSER_CHROME_PATH,
      process.env.CHROME_PATH,
      process.env.CHROMIUM_PATH,
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    ].find((candidate) => candidate && fs.existsSync(candidate));
    const executablePath = configured || chromium.executablePath();
    const available = Boolean(executablePath && fs.existsSync(executablePath));
    return check(
      "playwright_chromium",
      "Playwright Chromium",
      available ? "pass" : "warn",
      available
        ? `Chromium executable is available at ${executablePath}.`
        : "Chromium executable is missing; run `npx playwright install chromium`.",
      { executablePath, configured: Boolean(configured) },
    );
  } catch (err) {
    return check(
      "playwright_chromium",
      "Playwright Chromium",
      "warn",
      `Could not resolve Chromium; run \`npx playwright install chromium\`. ${err.message}`,
    );
  }
}

async function runDoctor() {
  const checks = [];
  checks.push(
    check("node_version", "Node.js", "pass", `Node ${process.versions.node}`),
  );

  const npm = npmCommand();
  const npmVersion = commandVersion(npm.command, [...npm.args, "--version"]);
  checks.push(
    check(
      "npm_version",
      "npm",
      npmVersion ? "pass" : "fail",
      npmVersion ? `npm ${npmVersion}` : "npm is not available on PATH.",
    ),
  );

  const goVersion = commandVersion("go", ["version"]);
  checks.push(
    check(
      "go_version",
      "Go",
      "pass",
      goVersion || "Go is not installed; the optional Go CLI is unavailable.",
      { optional: true, available: Boolean(goVersion) },
    ),
  );

  const sourceRuntimeMissing = RUNTIME_FILE_CANDIDATES.filter(
    ([srcPath]) => !fs.existsSync(path.join(PROJECT_ROOT, srcPath)),
  ).map(([srcPath]) => srcPath);
  const packagedRuntimeMissing = RUNTIME_FILE_CANDIDATES.filter(
    ([, distPath]) => !fs.existsSync(path.join(PROJECT_ROOT, distPath)),
  ).map(([, distPath]) => distPath);
  const sourceRuntimeReady = sourceRuntimeMissing.length === 0;
  const packagedRuntimeReady = packagedRuntimeMissing.length === 0;
  checks.push(
    check(
      "runtime_files",
      "Runtime build artifacts",
      sourceRuntimeReady || packagedRuntimeReady ? "pass" : "warn",
      sourceRuntimeReady
        ? "Source checkout runtime files are present."
        : packagedRuntimeReady
          ? "Packaged runtime files are present."
          : "Some runtime files are missing; run npm run build before production use.",
      {
        sourceRuntimeMissing,
        packagedRuntimeMissing,
        sourceRuntimeReady,
        packagedRuntimeReady,
      },
    ),
  );

  checks.push(alwaysOnSupervisorCheck());

  for (const [dir, target] of [["config", EFFECTIVE_CONFIG_DIR], ["data", EFFECTIVE_DATA_DIR]]) {
    try {
      writableDir(target);
      checks.push(
        check(
          `writable_${dir}`,
          `${dir}/ writable`,
          "pass",
          `${target} is writable.`,
        ),
      );
    } catch (err) {
      checks.push(
        check(`writable_${dir}`, `${dir}/ writable`, "fail", `${target}: ${err.message}`),
      );
    }
  }

  checks.push(await configValidationCheck());

  try {
    sqliteWritable();
    checks.push(
      check(
        "sqlite_access",
        "SQLite access",
        "pass",
        "SQLite data directory is writable.",
      ),
    );
  } catch (err) {
    checks.push(check("sqlite_access", "SQLite access", "fail", err.message));
  }

  checks.push(await secretVaultCheck());
  checks.push(await playwrightChromiumCheck());

  if (process.platform === "linux") {
    const xdotool = commandVersion("xdotool", ["version"]);
    checks.push(
      check(
        "computer_use_xdotool",
        "xdotool (computer use)",
        xdotool ? "pass" : "warn",
        xdotool
          ? `xdotool ${xdotool.split(/\s+/).pop()}`
          : "xdotool is not installed; computer_* UI actions will fail. Install it (e.g. sudo apt-get install xdotool).",
      ),
    );
    const display = String(process.env.DISPLAY || "").trim();
    checks.push(
      check(
        "computer_use_display",
        "X11 display (computer use)",
        display ? "pass" : "warn",
        display
          ? `DISPLAY=${display}`
          : process.env.WAYLAND_DISPLAY
            ? "Wayland-only session: computer_* needs X11/XWayland with DISPLAY set."
            : "DISPLAY is not set; computer_* UI actions need an X11 session (set DISPLAY/XAUTHORITY for the service).",
      ),
    );
  }

  // The direct-provider policy is intentionally limited to Gemini and
  // llama.cpp. llama.cpp is local and does not require an API key.
  //
  // Previously this checked process.env.GEMINI_API_KEY directly, which
  // misses a key saved via `miki config set` / `miki setup` into the
  // workspace .env or user config vault: those are resolved through
  // @miki/config's resolveConfiguredSecret() (env fallback + vault lookup),
  // not injected into process.env automatically. That made the doctor
  // report "not configured" for a key that was in fact set and working.
  let geminiConfigured = false;
  try {
    const { resolveConfiguredSecret } = await import("@miki/config");
    const resolved = resolveConfiguredSecret("GEMINI_API_KEY", EFFECTIVE_WORKSPACE_DIR);
    geminiConfigured = typeof resolved === "string" && resolved.trim() !== "";
  } catch {
    // Fall back to a raw environment check if @miki/config can't be loaded
    // (for example, before the config package has been built) so this
    // check degrades gracefully instead of failing the whole doctor run.
    geminiConfigured =
      typeof process.env.GEMINI_API_KEY === "string" &&
      process.env.GEMINI_API_KEY.trim() !== "";
  }
  const storedModel = await savedDefaultModelStatus();
  const envProviderKeys = [
    ["OpenAI", process.env.OPENAI_API_KEY],
    ["Gemini", process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY],
    ["OpenRouter", process.env.OPENROUTER_API_KEY],
    ["OpenAI-compatible", process.env.OPENAI_COMPATIBLE_API_KEY],
  ].filter(([, value]) => typeof value === "string" && value.trim() !== "").map(([name]) => name);
  const knownCredential = envProviderKeys.length > 0 || geminiConfigured || Boolean(storedModel?.credentialConfigured);
  checks.push(
    check(
      "provider_keys",
      "LLM provider credentials",
      knownCredential ? "pass" : "warn",
      knownCredential
        ? `Credential/configuration detected for ${[...new Set([...envProviderKeys, ...(storedModel?.credentialConfigured ? [storedModel.provider] : [])])].join(", ")}. The Models page can test the active provider.`
        : "No provider credential was detected in the environment or the saved default model. Configure a model and credential in Dashboard > Models.",
    ),
  );

  // Autonomous notices only reach the user through a channel that has a token AND a trusted sender list.
  try {
    const cfg = parseConfig();
    const channels = Object.entries(cfg.channel_list || {}).filter(
      ([name, c]) => name !== "miki" && c && c.enabled && Array.isArray(c.allow_from),
    );
    const usable = channels.filter(([, c]) => c.allow_from.length > 0).map(([n]) => n);
    checks.push(
      check(
        "notification_channel",
        "Notification channel",
        usable.length ? "pass" : "warn",
        usable.length
          ? `Trusted senders configured for: ${usable.join(", ")}.`
          : "No external channel has allow_from set; proactive messages appear only in the web chat. Add your platform user ID to allow_from and a bot token.",
      ),
    );
  } catch {
    /* config problems are reported by the config check */
  }

  // Model configuration is stored in the same SQLite database the running gateway
  // uses. Checking only process environment keys incorrectly reported a missing
  // model when the owner had configured it in Dashboard > Models.
  const localModel = String(process.env.MIKI_LLAMA_MODEL_PATH || "").trim();
  const envModelConfigured = Boolean(
    String(process.env.MIKI_MODEL || process.env.OPENAI_MODEL || process.env.DEFAULT_MODEL || "").trim() ||
    (String(process.env.MIKI_PROVIDER || "").trim() && knownCredential),
  );
  const savedModelConfigured = Boolean(storedModel?.model && storedModel.credentialConfigured);
  const localModelConfigured = Boolean(localModel && fs.existsSync(localModel));
  const autonomyModelReady = savedModelConfigured || envModelConfigured || localModelConfigured;
  checks.push(
    check(
      "autonomy_model",
      "Autonomy model",
      autonomyModelReady ? "pass" : "warn",
      savedModelConfigured
        ? `Default model saved in the runtime database: ${storedModel.provider}/${storedModel.model}. Run its connection and tool-calling tests in Dashboard > Models.`
        : storedModel?.model
          ? `Default model ${storedModel.provider}/${storedModel.model} is saved, but its credential could not be confirmed. Check the key/vault status in Dashboard > Models.`
          : envModelConfigured || localModelConfigured
            ? "A model appears to be configured through environment settings. Confirm the default model and tool-calling test in Dashboard > Models."
            : "No usable default model was detected in the active runtime database or environment. Configure a provider, select a default model, and test it in Dashboard > Models.",
    ),
  );

  // Package js-yaml hoisting check
  const staleJsYaml = path.join(
    PROJECT_ROOT,
    "packages",
    "config",
    "node_modules",
    "js-yaml",
  );
  if (fs.existsSync(staleJsYaml)) {
    checks.push(
      check(
        "js_yaml_hoisting",
        "js-yaml ESM resolution",
        "fail",
        "Stale packages/config/node_modules/js-yaml found. Remove it to fix ESM resolution.",
      ),
    );
  } else {
    checks.push(
      check(
        "js_yaml_hoisting",
        "js-yaml ESM resolution",
        "pass",
        "js-yaml resolution clean.",
      ),
    );
  }

  if (args.has("--migrations")) {
    checks.push(
      check(
        "migrations",
        "Migrations",
        fs.existsSync(path.join(EFFECTIVE_CONFIG_DIR, "agent.yaml"))
          ? "pass"
          : "warn",
        "Migration dry-run preconditions checked.",
      ),
    );
  }

  if (args.has("--secret-scan")) {
    const scan = secretScan();
    checks.push(
      check(
        "secret_scan",
        "Secret scan",
        scan.findings.length === 0 ? "pass" : "warn",
        scan.findings.length === 0
          ? "No likely secret leaks found."
          : `${scan.findings.length} possible secret leak(s) found.`,
        scan,
      ),
    );
  }

  if (!args.has("--skip-external")) {
    const audit = childProcess.spawnSync(
      npm.command,
      [...npm.args, "audit", "--omit=dev", "--json"],
      { cwd: PROJECT_ROOT, encoding: "utf-8", shell: false, timeout: 60000 },
    );
    checks.push(
      check(
        "production_audit",
        "Production dependency audit",
        audit.status === 0 ? "pass" : "warn",
        audit.status === 0
          ? "npm audit --omit=dev passed."
          : "npm audit --omit=dev did not pass or timed out.",
      ),
    );
  }

  const status = checks.some((item) => item.status === "fail")
    ? "fail"
    : checks.some((item) => item.status === "warn")
      ? "warn"
      : "pass";
  return {
    status,
    checkedAt: new Date().toISOString(),
    workspaceDir: EFFECTIVE_WORKSPACE_DIR,
    configDir: EFFECTIVE_CONFIG_DIR,
    dataDir: EFFECTIVE_DATA_DIR,
    checks,
  };
}

function printHuman(report) {
  console.log(`Miki doctor: ${report.status.toUpperCase()}`);
  for (const item of report.checks) {
    const symbol =
      item.status === "pass" ? "OK" : item.status === "warn" ? "WARN" : "FAIL";
    console.log(`[${symbol}] ${item.label}: ${item.message}`);
  }
}

const report = await runDoctor();
if (args.has("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}

if (report.status === "fail") {
  process.exit(1);
}
if (args.has("--strict") && report.status === "warn") {
  process.exit(2);
}
process.exit(0);
