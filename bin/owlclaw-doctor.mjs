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

// Register runtime loader for @hiro/* package resolution
const loaderPath = path.join(PROJECT_ROOT, "dist", "runtime", "runtime-loader.mjs");
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
  ["packages/gateway/dist/index.js", "dist/runtime/packages/gateway/dist/index.js"],
  ["packages/core/dist/api/index.js", "dist/runtime/packages/core/dist/api/index.js"],
  ["packages/config/dist/index.js", "dist/runtime/packages/config/dist/index.js"],
  ["packages/installer/dist/index.js", "dist/runtime/packages/installer/dist/index.js"],
  ["packages/skills/dist/index.js", "dist/runtime/packages/skills/dist/index.js"],
  ["packages/ui/frontend/dist/index.html", "dist/runtime/packages/ui/frontend/dist/index.html"],
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
    /\b(?:api[_-]?key|token|secret|password|refresh[_-]?token|access[_-]?token)\s*[:=]\s*["']?[^"'\s,}]{12,}/gi,
  ],
];

function check(id, label, status, message, details = undefined) {
  return { id, label, status, message, details };
}

function commandVersion(command, commandArgs) {
  const result = childProcess.spawnSync(command, commandArgs, {
    cwd: PROJECT_ROOT,
    encoding: "utf-8",
    shell: false,
    timeout: 10000,
  });
  return result.status === 0 ? String(result.stdout || result.stderr).trim() : null;
}

function npmCommand() {
  return { command: "npm", args: [] };
}

function writableDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `.doctor-${process.pid}.tmp`);
  fs.writeFileSync(target, "ok", "utf-8");
  fs.rmSync(target, { force: true });
}

function sqliteWritable() {
  const dataDir = path.join(PROJECT_ROOT, "data");
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
  return (
    normalized.includes("os.environ/") ||
    normalized.includes("process.env.") ||
    normalized.includes("process.env[") ||
    normalized.includes("${") ||
    normalized.includes("[redacted]")
  );
}

function secretScan() {
  const candidates = [
    path.join(PROJECT_ROOT, ".env"),
    ...walkFiles(path.join(PROJECT_ROOT, "config")),
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
  const configPath = path.join(PROJECT_ROOT, "config", "agent.yaml");
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
    const { validateRuntimeConfig } = await import("@hiro/config/schema");
    const result = validateRuntimeConfig(parsed);
    return check(
      "config_validation",
      "Runtime config",
      result.valid ? (result.warnings.length ? "warn" : "pass") : "fail",
      result.valid
        ? "Runtime config is valid."
        : result.errors.map((item) => `${item.path}: ${item.message}`).join("; "),
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
    const { inspectEnvSecretStatus } = await import(
      "@hiro/config/secret-vault"
    );
    const secretStatus = inspectEnvSecretStatus({ workspaceDir: PROJECT_ROOT });
    const envOnly = secretStatus.filter((item) => item.envOnly).map((item) => item.key);
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

async function runDoctor() {
  const checks = [];
  checks.push(check("node_version", "Node.js", "pass", `Node ${process.versions.node}`));

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
      goVersion ? "pass" : "warn",
      goVersion || "Go is not available; Go backend tests/builds may fail.",
    ),
  );

  const missingRuntime = RUNTIME_FILE_CANDIDATES.filter(
    ([, distPath]) => !fs.existsSync(path.join(PROJECT_ROOT, distPath)),
  ).map(([srcPath]) => srcPath);
  checks.push(
    check(
      "runtime_files",
      "Runtime build artifacts",
      missingRuntime.length === 0 ? "pass" : "warn",
      missingRuntime.length === 0
        ? "Required runtime files are present."
        : "Some runtime files are missing; run npm run build before production use.",
      { missingRuntime },
    ),
  );

  for (const dir of ["config", "data"]) {
    try {
      writableDir(path.join(PROJECT_ROOT, dir));
      checks.push(check(`writable_${dir}`, `${dir}/ writable`, "pass", `${dir}/ is writable.`));
    } catch (err) {
      checks.push(check(`writable_${dir}`, `${dir}/ writable`, "fail", err.message));
    }
  }

  checks.push(await configValidationCheck());

  try {
    sqliteWritable();
    checks.push(check("sqlite_access", "SQLite access", "pass", "SQLite data directory is writable."));
  } catch (err) {
    checks.push(check("sqlite_access", "SQLite access", "fail", err.message));
  }

  checks.push(await secretVaultCheck());

  if (args.has("--migrations")) {
    checks.push(
      check(
        "migrations",
        "Migrations",
        fs.existsSync(path.join(PROJECT_ROOT, "config", "agent.yaml")) ? "pass" : "warn",
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
    workspaceDir: PROJECT_ROOT,
    checks,
  };
}

function printHuman(report) {
  console.log(`Hiro doctor: ${report.status.toUpperCase()}`);
  for (const item of report.checks) {
    const symbol = item.status === "pass" ? "OK" : item.status === "warn" ? "WARN" : "FAIL";
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
