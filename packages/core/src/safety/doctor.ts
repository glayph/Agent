import * as child_process from "child_process";
import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import Database from "better-sqlite3";
import * as yaml from "js-yaml";
import { type RuntimePaths } from "../paths.js";
import { inspectEnvSecretStatus, validateRuntimeConfig } from "@hiro/config";
import { createMigrationManager } from "./migrations.js";
import { scanSecrets } from "./secret-scan.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheckResult {
  id: string;
  label: string;
  status: DoctorStatus;
  message: string;
  details?: Record<string, unknown>;
}

export interface DoctorReport {
  status: DoctorStatus;
  checkedAt: string;
  sourceDir?: string;
  checks: DoctorCheckResult[];
}

export interface DoctorOptions {
  strict?: boolean;
  includeExternalChecks?: boolean;
  includeMigrations?: boolean;
  includeSecretScan?: boolean;
}

const REQUIRED_RUNTIME_FILES = [
  "packages/gateway/dist/index.js",
  "packages/core/dist/api/index.js",
  "packages/config/dist/index.js",
  "packages/installer/dist/index.js",
  "packages/skills/dist/index.js",
  "packages/ui/frontend/dist/index.html",
];

function check(
  id: string,
  label: string,
  status: DoctorStatus,
  message: string,
  details?: Record<string, unknown>,
): DoctorCheckResult {
  return { id, label, status, message, details };
}

function commandVersion(command: string, args: string[]): string | null {
  const result = child_process.spawnSync(command, args, {
    encoding: "utf-8",
    shell: false,
    timeout: 10_000,
  });
  if (result.status !== 0) return null;
  return String(result.stdout || result.stderr).trim();
}

function npmCommand(): { command: string; args: string[] } {
  if (process.platform !== "win32") return { command: "npm", args: [] };
  return {
    command: process.execPath,
    args: [
      path.join(
        path.dirname(process.execPath),
        "node_modules",
        "npm",
        "bin",
        "npm-cli.js",
      ),
    ],
  };
}

function readAgentConfig(configDir: string): Record<string, unknown> {
  const configPath = path.join(configDir, "agent.yaml");
  if (!fs.existsSync(configPath)) return {};
  return (yaml.load(fs.readFileSync(configPath, "utf-8")) || {}) as Record<
    string,
    unknown
  >;
}

function writableDir(dir: string): boolean {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `.doctor-${process.pid}.tmp`);
  fs.writeFileSync(file, "ok", "utf-8");
  fs.rmSync(file, { force: true });
  return true;
}

function sqliteWritable(dataDir: string): boolean {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, `.doctor-${process.pid}.sqlite`);
  const db = new Database(dbPath);
  try {
    db.exec("CREATE TABLE doctor_check (id INTEGER PRIMARY KEY);");
  } finally {
    db.close();
    fs.rmSync(dbPath, { force: true });
  }
  return true;
}

function packagePresent(name: string): boolean {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function summarize(checks: DoctorCheckResult[]): DoctorStatus {
  if (checks.some((item) => item.status === "fail")) return "fail";
  if (checks.some((item) => item.status === "warn")) return "warn";
  return "pass";
}

export async function runDoctor(
  paths: RuntimePaths,
  options: DoctorOptions = {},
): Promise<DoctorReport> {
  const sourceDir = paths.sourceDir;
  const checks: DoctorCheckResult[] = [];

  checks.push(
    check(
      "node_version",
      "Node.js",
      process.versions.node ? "pass" : "fail",
      `Node ${process.versions.node}`,
    ),
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
      goVersion ? "pass" : "warn",
      goVersion || "Go is not available; Go backend tests/builds may fail.",
    ),
  );

  const missingRuntime = REQUIRED_RUNTIME_FILES.filter(
    (file) => sourceDir && !fs.existsSync(path.join(sourceDir, file)),
  );
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

  for (const dirName of ["config", "data"]) {
    const dir = dirName === "config" ? paths.configDir : paths.dataDir;
    try {
      writableDir(dir);
      checks.push(
        check(
          `writable_${dirName}`,
          `${dirName}/ writable`,
          "pass",
          `${dirName}/ is writable.`,
        ),
      );
    } catch (err: unknown) {
      checks.push(
        check(
          `writable_${dirName}`,
          `${dirName}/ writable`,
          "fail",
          err instanceof Error ? err.message : String(err),
        ),
      );
    }
  }

  try {
    const result = validateRuntimeConfig(readAgentConfig(paths.configDir));
    checks.push(
      check(
        "config_validation",
        "Runtime config",
        result.valid ? (result.warnings.length ? "warn" : "pass") : "fail",
        result.valid
          ? "Runtime config is valid."
          : result.errors
              .map((item) => `${item.path}: ${item.message}`)
              .join("; "),
        { warnings: result.warnings },
      ),
    );
  } catch (err: unknown) {
    checks.push(
      check(
        "config_validation",
        "Runtime config",
        "fail",
        err instanceof Error ? err.message : String(err),
      ),
    );
  }

  try {
    sqliteWritable(paths.dataDir);
    checks.push(
      check(
        "sqlite_access",
        "SQLite access",
        "pass",
        "SQLite data directory is writable.",
      ),
    );
  } catch (err: unknown) {
    checks.push(
      check(
        "sqlite_access",
        "SQLite access",
        "fail",
        err instanceof Error ? err.message : String(err),
      ),
    );
  }

  try {
    const secretStatus = inspectEnvSecretStatus({
      workspaceDir: sourceDir ?? paths.dataDir,
    });
    const envOnly = secretStatus
      .filter((item) => item.envOnly)
      .map((item) => item.key);
    checks.push(
      check(
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
      ),
    );
  } catch (err: unknown) {
    checks.push(
      check(
        "secret_vault",
        "Secret vault",
        "fail",
        err instanceof Error ? err.message : String(err),
      ),
    );
  }

  checks.push(
    check(
      "playwright",
      "Playwright",
      packagePresent("playwright") ? "pass" : "warn",
      packagePresent("playwright")
        ? "Playwright package is available."
        : "Playwright package is not resolvable.",
    ),
  );

  if (options.includeMigrations) {
    const migrations = createMigrationManager(paths).run({ dryRun: true });
    checks.push(
      check(
        "migrations",
        "Migrations",
        migrations.some((item) => item.status === "failed") ? "fail" : "pass",
        "Migration dry-run completed.",
        { migrations },
      ),
    );
  }

  if (options.includeSecretScan) {
    const scan = scanSecrets(paths);
    checks.push(
      check(
        "secret_scan",
        "Secret scan",
        scan.findings.length === 0 ? "pass" : "warn",
        scan.findings.length === 0
          ? "No likely secret leaks found in scanned text files."
          : `${scan.findings.length} possible secret leak(s) found.`,
        { scannedFiles: scan.scannedFiles, findings: scan.findings },
      ),
    );
  }

  if (options.includeExternalChecks !== false) {
    const audit = child_process.spawnSync(
      npm.command,
      [...npm.args, "audit", "--omit=dev", "--json"],
      {
        cwd: sourceDir ?? paths.dataDir,
        encoding: "utf-8",
        shell: false,
        timeout: 60_000,
      },
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

  return {
    status: summarize(checks),
    checkedAt: new Date().toISOString(),
    sourceDir,
    checks,
  };
}

export function doctorExitCode(report: DoctorReport, strict = false): number {
  if (report.status === "fail") return 1;
  if (strict && report.status === "warn") return 2;
  return 0;
}
