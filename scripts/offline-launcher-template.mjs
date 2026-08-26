#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const launcherDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(launcherDir, "..");
const sourceRuntime = path.join(packageRoot, "runtime");
const executableSuffix = process.platform === "win32" ? ".exe" : "";
const embeddedNode = path.join(
  sourceRuntime,
  "node",
  "bin",
  `node${executableSuffix}`,
);
const bundledLlama = path.join(
  sourceRuntime,
  "native",
  `llama-server${executableSuffix}`,
);
const dataBase =
  process.env.XDG_DATA_HOME ||
  (process.platform === "win32"
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")
    : path.join(os.homedir(), ".local", "share"));
const defaultDataRoot = path.join(dataBase, "miki");
const runtimeRoot = path.resolve(
  process.env.MIKI_RUNTIME_ROOT || path.join(defaultDataRoot, "runtime"),
);
const workspaceRoot = path.resolve(
  process.env.MIKI_WORKSPACE_DIR || path.join(defaultDataRoot, "workspace"),
);
const statePath = path.join(runtimeRoot, "data", "launcher-state.json");
const credentialPath = path.join(
  runtimeRoot,
  "data",
  "first-run-credentials.txt",
);
const defaultLocalPort = 19300;

function fail(message, code = 1) {
  console.error(`[miki-offline] ${message}`);
  process.exitCode = code;
}

function ensureDir(target) {
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
}

function copyMissingTree(source, destination) {
  if (!fs.existsSync(source)) return;
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    ensureDir(destination);
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      copyMissingTree(
        path.join(source, entry.name),
        path.join(destination, entry.name),
      );
    }
    return;
  }
  if (!fs.existsSync(destination)) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    try {
      fs.chmodSync(destination, stat.mode & 0o777);
    } catch {
      // File modes are best-effort on filesystems that do not preserve them.
    }
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

function upsertEnvValues(file, values) {
  const lines = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").split(/\r?\n/)
    : ["# Agent Miki offline defaults"];
  for (const [key, value] of Object.entries(values)) {
    const nextLine = `${key}=${value}`;
    const index = lines.findIndex((line) =>
      new RegExp(
        `^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=`,
      ).test(line),
    );
    if (index >= 0) lines[index] = nextLine;
    else lines.push(nextLine);
  }
  fs.writeFileSync(
    file,
    `${lines
      .filter((line, index, all) => index < all.length - 1 || line)
      .join("\n")
      .replace(/\n+$/, "")}\n`,
    {
      encoding: "utf8",
      mode: 0o600,
    },
  );
}

function validateExternalModelPath(modelPath) {
  if (!path.isAbsolute(modelPath)) {
    throw new Error(
      "MIKI_MODEL_PATH must be an absolute path to a .gguf file.",
    );
  }
  if (!modelPath.toLowerCase().endsWith(".gguf")) {
    throw new Error("MIKI_MODEL_PATH must point to a .gguf file.");
  }
  if (!fs.existsSync(modelPath) || !fs.statSync(modelPath).isFile()) {
    throw new Error(`External GGUF model not found: ${modelPath}`);
  }
  return path.resolve(modelPath);
}

function removeStaleBundledModelDefaults(file) {
  if (!fs.existsSync(file)) return;
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const stale =
    /^(?:MIKI_MODEL|DEFAULT_MODEL)\s*=\s*(?:llama\.cpp\/)?lfm2-local\s*$/i;
  const filtered = lines.filter((line) => !stale.test(line));
  if (filtered.join("\n") !== lines.join("\n")) {
    fs.writeFileSync(file, `${filtered.join("\n").replace(/\n+$/, "")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
}

function externalModelPath() {
  return process.env.MIKI_MODEL_PATH?.trim() || "";
}

function externalModelId() {
  return process.env.MIKI_MODEL_ID?.trim() || "external-local";
}

function externalModelName() {
  return process.env.MIKI_LOCAL_MODEL_NAME?.trim() || "External Local Model";
}

function localModelRecord(modelPath) {
  const modelDir = path.dirname(modelPath);
  const modelId = externalModelId();
  const modelName = externalModelName();
  return {
    model_name: modelName,
    provider: "llama.cpp",
    model: modelId,
    api_base: `http://127.0.0.1:${defaultLocalPort}/v1`,
    auth_method: "none",
    enabled: true,
    extra_body: {},
    custom_headers: {},
    local: {
      runtime: "llama.cpp",
      model_path: modelPath,
      model_format: "gguf",
      display_name: `${modelName} (external GGUF)`,
      context_size: 4096,
      gpu_layers: 0,
      enabled: true,
      auto_start: true,
      executable_path: bundledLlama,
      port: defaultLocalPort,
      allowed_model_dirs: [modelDir],
    },
  };
}

function passwordHash(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function passwordFromCredentialFile() {
  try {
    const text = fs.readFileSync(credentialPath, "utf8");
    const line = text
      .split(/\r?\n/)
      .find((entry) => entry.toLowerCase().startsWith("password:"));
    return line ? line.slice(line.indexOf(":") + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

function ensureDashboardAuth(state) {
  if (state.auth?.password_hash && state.auth?.salt) {
    return { state, password: undefined, created: false };
  }
  const password =
    process.env.MIKI_DASHBOARD_PASSWORD?.trim() ||
    passwordFromCredentialFile() ||
    crypto.randomBytes(12).toString("base64url");
  if (password.length < 8) {
    throw new Error(
      "MIKI_DASHBOARD_PASSWORD must contain at least 8 characters.",
    );
  }
  const salt = crypto.randomBytes(16).toString("hex");
  state.auth = {
    salt,
    password_hash: passwordHash(password, salt),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  ensureDir(path.dirname(credentialPath));
  if (!process.env.MIKI_DASHBOARD_PASSWORD && !fs.existsSync(credentialPath)) {
    fs.writeFileSync(
      credentialPath,
      `Agent Miki first-run dashboard credentials\nPassword: ${password}\n\nDelete this file after saving the password.\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  }
  return { state, password, created: true };
}

function prepareRuntimeLayout() {
  if (!fs.existsSync(sourceRuntime)) {
    throw new Error(`Bundled runtime is missing: ${sourceRuntime}`);
  }
  ensureDir(runtimeRoot);
  ensureDir(workspaceRoot);
  for (const directory of [
    path.join(runtimeRoot, "config"),
    path.join(runtimeRoot, "data"),
    path.join(runtimeRoot, "cache"),
    path.join(runtimeRoot, "skills"),
    path.join(workspaceRoot, "data"),
    path.join(workspaceRoot, "logs"),
  ]) {
    ensureDir(directory);
  }

  copyMissingTree(
    path.join(sourceRuntime, "config"),
    path.join(runtimeRoot, "config"),
  );
  const envPath = path.join(runtimeRoot, "config", ".env");
  if (!fs.existsSync(envPath)) {
    fs.writeFileSync(envPath, "# Agent Miki offline defaults\n", {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  copyMissingTree(
    path.join(sourceRuntime, "packages", "ui", "frontend", "dist"),
    path.join(runtimeRoot, "packages", "ui", "frontend", "dist"),
  );
  copyMissingTree(
    path.join(sourceRuntime, "packages", "skills", "src"),
    path.join(runtimeRoot, "skills"),
  );

  const state = readJson(statePath, {});
  if (!Array.isArray(state.models)) state.models = [];
  if (!externalModelPath()) removeStaleBundledModelDefaults(envPath);
  // Remove the old release’s synthetic bundled-model record when upgrading to
  // a model-free package. User-configured external models are preserved.
  state.models = state.models.filter((model) => {
    if (!model || typeof model !== "object") return false;
    const record = model;
    const modelName = String(record.model_name || "").toLowerCase();
    const modelId = String(record.model || "").toLowerCase();
    const modelPath = String(record.local?.model_path || "");
    return !(
      (modelName === "lfm2-local" ||
        modelName === "lfm2 local" ||
        modelId === "lfm2-local") &&
      !fs.existsSync(modelPath)
    );
  });
  const configuredModelPath = externalModelPath();
  if (configuredModelPath) {
    const modelPath = validateExternalModelPath(configuredModelPath);
    const model = localModelRecord(modelPath);
    const modelIndex = state.models.findIndex(
      (candidate) =>
        candidate &&
        typeof candidate === "object" &&
        (String(candidate.model || "") === model.model ||
          String(candidate.model_name || "") === model.model_name),
    );
    if (modelIndex >= 0) state.models[modelIndex] = model;
    else state.models.push(model);
    const runtimeModel = `llama.cpp/${model.model}`;
    upsertEnvValues(envPath, {
      MIKI_MODEL: runtimeModel,
      DEFAULT_MODEL: runtimeModel,
      MIKI_PROVIDER: "llama.cpp",
    });
  }
  state.miki_token ||= crypto.randomBytes(24).toString("base64url");
  const auth = ensureDashboardAuth(state);
  writeJson(statePath, auth.state);
  return auth;
}

function requiredAssets() {
  return [
    ["embedded Node", embeddedNode],
    ["llama.cpp server executable", bundledLlama],
    [
      "gateway build",
      path.join(sourceRuntime, "packages", "gateway", "dist", "index.js"),
    ],
    [
      "dashboard index",
      path.join(
        runtimeRoot,
        "packages",
        "ui",
        "frontend",
        "dist",
        "index.html",
      ),
    ],
  ];
}

function printCredentials(auth) {
  if (!auth.created) return;
  if (auth.password) {
    console.log(
      `[miki-offline] First-run dashboard password: ${auth.password}`,
    );
  }
  console.log(
    `[miki-offline] Credentials are also stored at ${credentialPath} (mode 600); delete that file after saving the password.`,
  );
}

function doctor() {
  let failed = false;
  console.log(
    `Agent Miki ${process.platform}-${process.arch} offline diagnostic\n`,
  );
  console.log(`Package root: ${packageRoot}`);
  console.log(`Runtime data: ${runtimeRoot}`);
  console.log(`Workspace: ${workspaceRoot}`);
  console.log(`Node: ${embeddedNode}`);
  try {
    const nodeVersion = spawnSyncVersion(embeddedNode);
    console.log(`Node version: ${nodeVersion}`);
  } catch (error) {
    console.log(`Node version: unavailable (${error.message})`);
    failed = true;
  }
  for (const [label, target] of requiredAssets()) {
    const ok = fs.existsSync(target);
    console.log(`${ok ? "PASS" : "FAIL"} ${label}: ${target}`);
    if (!ok) failed = true;
  }
  if (fs.existsSync(bundledLlama)) {
    try {
      fs.accessSync(bundledLlama, fs.constants.X_OK);
    } catch {
      console.log(`FAIL llama.cpp server is not executable: ${bundledLlama}`);
      failed = true;
    }
  }
  const configuredModelPath = externalModelPath();
  if (configuredModelPath) {
    try {
      const modelPath = validateExternalModelPath(configuredModelPath);
      console.log(`PASS external answer GGUF: ${modelPath}`);
    } catch (error) {
      console.log(`FAIL external answer GGUF: ${error.message}`);
      failed = true;
    }
  } else {
    console.log(
      "INFO answer-model GGUF is not bundled; configure MIKI_MODEL_PATH or use the Models page.",
    );
  }
  console.log(
    "INFO voice-to-text assets are not bundled; configure a local runtime/model or use an approved audio-capable cloud model.",
  );
  if (failed) {
    fail(
      `Offline package is incomplete. Reinstall the matching ${process.platform}-${process.arch} release asset.`,
      1,
    );
  } else {
    console.log("\nPASS All bundled offline assets are present.");
    console.log(
      "The dashboard remains bound to 127.0.0.1 unless GATEWAY_HOST is explicitly changed.",
    );
  }
}

function spawnSyncVersion(executable) {
  const child = spawnSync(executable, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0)
    throw new Error(child.stderr || "version command failed");
  return child.stdout.trim();
}

function startGateway(auth, argv) {
  for (const [label, target] of requiredAssets()) {
    if (!fs.existsSync(target)) throw new Error(`Missing ${label}: ${target}`);
  }
  const gatewayEntry = path.join(
    sourceRuntime,
    "packages",
    "gateway",
    "dist",
    "index.js",
  );
  const nodeExecutable = fs.existsSync(embeddedNode)
    ? embeddedNode
    : process.execPath;
  const nativeLibraryDir = path.join(sourceRuntime, "native", "lib");
  const oldPath = process.env.PATH || "";
  const oldLibraryPath = process.env.LD_LIBRARY_PATH || "";
  const env = {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV || "production",
    PATH: `${path.dirname(nodeExecutable)}${path.delimiter}${oldPath}`,
    MIKI_SOURCE_ROOT: sourceRuntime,
    MIKI_RUNTIME_ROOT: runtimeRoot,
    MIKI_WORKSPACE_DIR: workspaceRoot,
    ...(process.env.MIKI_MODEL ? { MIKI_MODEL: process.env.MIKI_MODEL } : {}),
    ...(process.env.DEFAULT_MODEL
      ? { DEFAULT_MODEL: process.env.DEFAULT_MODEL }
      : {}),
    ...(process.env.MIKI_PROVIDER
      ? { MIKI_PROVIDER: process.env.MIKI_PROVIDER }
      : {}),
    MIKI_LLAMA_SERVER_BIN: process.env.MIKI_LLAMA_SERVER_BIN || bundledLlama,
    ...(process.env.MIKI_SPEECH_TO_TEXT_ENABLED
      ? { MIKI_SPEECH_TO_TEXT_ENABLED: process.env.MIKI_SPEECH_TO_TEXT_ENABLED }
      : {}),
    ...(process.env.MIKI_WHISPER_CPP_EXECUTABLE
      ? { MIKI_WHISPER_CPP_EXECUTABLE: process.env.MIKI_WHISPER_CPP_EXECUTABLE }
      : {}),
    ...(process.env.MIKI_WHISPER_CPP_MODEL
      ? { MIKI_WHISPER_CPP_MODEL: process.env.MIKI_WHISPER_CPP_MODEL }
      : {}),
    MIKI_SPEECH_TO_TEXT_LANGUAGE:
      process.env.MIKI_SPEECH_TO_TEXT_LANGUAGE || "auto",
    MIKI_SPEECH_TO_TEXT_MAX_AUDIO_SECONDS:
      process.env.MIKI_SPEECH_TO_TEXT_MAX_AUDIO_SECONDS || "120",
    MIKI_SPEECH_TO_TEXT_MAX_FILE_MB:
      process.env.MIKI_SPEECH_TO_TEXT_MAX_FILE_MB || "25",
    LD_LIBRARY_PATH: [nativeLibraryDir, oldLibraryPath]
      .filter(Boolean)
      .join(path.delimiter),
  };
  const portIndex = argv.indexOf("--port");
  if (portIndex >= 0 && argv[portIndex + 1]) {
    env.GATEWAY_PORT = argv[portIndex + 1];
  }
  console.log("[miki-offline] Starting local Agent Miki gateway...");
  console.log(
    `[miki-offline] Dashboard: http://${env.GATEWAY_HOST || "127.0.0.1"}:${env.GATEWAY_PORT || "18800"}`,
  );
  console.log(
    `[miki-offline] Answer model: ${env.MIKI_MODEL || "not configured; set MIKI_MODEL_PATH or use the Models page"}`,
  );
  console.log(
    `[miki-offline] Voice: optional local runtime/model or audio-capable cloud fallback`,
  );
  printCredentials(auth);
  const child = spawn(nodeExecutable, [gatewayEntry], {
    cwd: workspaceRoot,
    env,
    stdio: "inherit",
    shell: false,
  });
  const shutdown = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // The gateway may have exited already.
    }
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  child.once("error", (error) => {
    console.error(`[miki-offline] Gateway failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    if (signal) console.log(`[miki-offline] Gateway stopped after ${signal}.`);
    else if (code)
      console.error(`[miki-offline] Gateway exited with code ${code}.`);
    process.exitCode = code ?? 0;
  });
}

function usage() {
  console.log(
    `Agent Miki ${process.platform}-${process.arch} offline package\n\nCommands:\n  install       Prepare the user runtime and generate first-run credentials\n  start         Start the local dashboard and optional configured model\n  doctor        Check bundled runtime and optional voice configuration\n  status        Show installation paths and selected local assets\n  help          Show this help\n\nEnvironment overrides:\n  MIKI_RUNTIME_ROOT, MIKI_WORKSPACE_DIR, GATEWAY_PORT, GATEWAY_HOST\n  MIKI_MODEL, MIKI_PROVIDER, MIKI_MODEL_PATH, MIKI_MODEL_ID, MIKI_LOCAL_MODEL_NAME, MIKI_DASHBOARD_PASSWORD\n`,
  );
}

const command = process.argv[2] || "start";
const args = process.argv.slice(3);
try {
  if (command === "help" || command === "--help" || command === "-h") {
    usage();
  } else if (command === "install") {
    const auth = prepareRuntimeLayout();
    console.log("[miki-offline] Offline runtime prepared.");
    console.log(`[miki-offline] Runtime data: ${runtimeRoot}`);
    console.log(`[miki-offline] Workspace: ${workspaceRoot}`);
    printCredentials(auth);
    console.log("[miki-offline] Run 'miki start' to open the dashboard.");
  } else if (command === "doctor") {
    prepareRuntimeLayout();
    doctor();
  } else if (command === "status") {
    prepareRuntimeLayout();
    console.log(
      JSON.stringify(
        {
          package_root: packageRoot,
          runtime_root: runtimeRoot,
          workspace: workspaceRoot,
          answer_model: process.env.MIKI_MODEL_PATH || "not configured",
          voice_to_text:
            "not bundled; configure a local runtime/model or use cloud audio",
          auth_initialized: Boolean(
            readJson(statePath, {}).auth?.password_hash,
          ),
        },
        null,
        2,
      ),
    );
  } else if (command === "start" || command === "run") {
    const auth = prepareRuntimeLayout();
    startGateway(auth, args);
  } else {
    usage();
    fail(`Unknown command: ${command}`, 2);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error), 1);
}
