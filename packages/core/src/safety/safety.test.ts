import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as child_process from "child_process";
import { SqliteAuditLog } from "../audit-log.js";
import { BackupManager } from "./backup.js";
import { runDoctor } from "./doctor.js";
import { MigrationManager, type MigrationDefinition } from "./migrations.js";
import { SafeModeManager } from "./safe-mode.js";
import { scanSecrets } from "./secret-scan.js";
import { Watchdog } from "./watchdog.js";
import { type RuntimePaths } from "../paths.js";

function makePaths(workspace: string): RuntimePaths {
  return {
    configDir: path.join(workspace, "config"),
    dataDir: path.join(workspace, "data"),
    skillsDir: path.join(workspace, "skills"),
    cacheDir: path.join(workspace, "cache"),
    binDir: path.join(workspace, "bin"),
    docsDir: path.join(workspace, "docs"),
    outputDir: path.join(workspace, "output"),
    sourceDir: workspace,
  };
}

function tempWorkspace(name: string): string {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), name));
  fs.mkdirSync(path.join(workspace, "config"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "data"), { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "config", "agent.yaml"),
    "agent:\n  name: Test\n",
    "utf-8",
  );
  return workspace;
}

describe("safety and recovery modules", () => {
  it("creates config/db backups and rolls them back with a pre-rollback backup", () => {
    const workspace = tempWorkspace("Hiro-backup-");
    const configPath = path.join(workspace, "config", "agent.yaml");
    const dbPath = path.join(workspace, "data", "nexus_memory.db");
    const walPath = path.join(workspace, "data", "nexus_memory.db-wal");
    fs.writeFileSync(dbPath, "db-v1", "utf-8");
    fs.writeFileSync(walPath, "wal-v1", "utf-8");

    const manager = new BackupManager(workspace);
    const backup = manager.createBackup("test");
    fs.writeFileSync(configPath, "agent:\n  name: Broken\n", "utf-8");
    fs.writeFileSync(dbPath, "db-v2", "utf-8");

    const rollback = manager.rollback(backup.id);

    expect(fs.readFileSync(configPath, "utf-8")).toContain("name: Test");
    expect(fs.readFileSync(dbPath, "utf-8")).toBe("db-v1");
    expect(
      backup.entries.some(
        (entry) => entry.source === path.join("data", "nexus_memory.db-wal"),
      ),
    ).toBe(true);
    expect(rollback.preRollbackBackupId).not.toBe(backup.id);
    expect(manager.listBackups().length).toBeGreaterThanOrEqual(2);
  });

  it("can skip high-volume operational stores for startup backups", () => {
    const workspace = tempWorkspace("Hiro-backup-startup-fast-");
    const auditPath = path.join(workspace, "data", "audit.db");
    const memoryPath = path.join(workspace, "data", "nexus_memory.db");
    const memoryWalPath = path.join(workspace, "data", "nexus_memory.db-wal");
    const systemIndexPath = path.join(workspace, "data", "system-index.db");
    fs.writeFileSync(auditPath, "audit", "utf-8");
    fs.writeFileSync(memoryPath, "memory", "utf-8");
    fs.writeFileSync(memoryWalPath, "memory-wal", "utf-8");
    fs.writeFileSync(systemIndexPath, "index", "utf-8");

    const backup = new BackupManager(workspace).createBackup("startup", {
      includeOperationalData: false,
    });
    const sources = backup.entries.map((entry) => entry.source);

    expect(sources).toContain(path.join("data", "audit.db"));
    expect(sources).not.toContain(path.join("data", "nexus_memory.db"));
    expect(sources).not.toContain(path.join("data", "nexus_memory.db-wal"));
    expect(sources).not.toContain(path.join("data", "system-index.db"));
  });

  it("prunes oldest backups when the retention limit is reached", () => {
    const workspace = tempWorkspace("Hiro-backup-retention-");
    const configPath = path.join(workspace, "config", "agent.yaml");
    const manager = new BackupManager(workspace, { maxBackups: 2 });
    const createdIds: string[] = [];

    for (let index = 0; index < 4; index += 1) {
      fs.writeFileSync(configPath, `agent:\n  name: Test ${index}\n`, "utf-8");
      createdIds.push(manager.createBackup(`retention-${index}`).id);
    }

    const backups = manager.listBackups();
    expect(backups.map((backup) => backup.id)).toEqual(
      createdIds.slice(-2).reverse(),
    );
    expect(
      fs.existsSync(path.join(workspace, "data", "backups", createdIds[0])),
    ).toBe(false);
  });

  it("rejects tampered backup manifests before rollback", () => {
    const workspace = tempWorkspace("Hiro-backup-tamper-");
    const manager = new BackupManager(workspace);
    const backup = manager.createBackup("tamper-test");
    const manifestPath = path.join(
      workspace,
      "data",
      "backups",
      backup.id,
      "manifest.json",
    );
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    manifest.entries[0].source = "../outside.yaml";
    fs.writeFileSync(manifestPath, JSON.stringify(manifest), "utf-8");

    expect(() => manager.rollback(backup.id)).toThrow(
      /Backup entry source is unsafe/,
    );
  });

  it("runs migrations idempotently and reports dry-run results", () => {
    const workspace = tempWorkspace("Hiro-migrate-");
    const migration: MigrationDefinition = {
      id: "test-migration",
      description: "write marker",
      apply(paths, dryRun) {
        const marker = path.join(paths.dataDir, "marker.json");
        if (!dryRun) fs.writeFileSync(marker, "{}", "utf-8");
        return ["data/marker.json"];
      },
    };
    const manager = new MigrationManager(makePaths(workspace), [migration]);

    expect(manager.run({ dryRun: true })[0].status).toBe("dry_run");
    expect(manager.run()[0].status).toBe("applied");
    expect(manager.run()[0].status).toBe("skipped");
  });

  it("rejects unsafe migration definitions and changed paths", () => {
    const workspace = tempWorkspace("Hiro-migrate-safety-");

    expect(
      () =>
        new MigrationManager(makePaths(workspace), [
          {
            id: "duplicate",
            description: "first",
            apply: () => [],
          },
          {
            id: "duplicate",
            description: "second",
            apply: () => [],
          },
        ]),
    ).toThrow(/Duplicate migration id/);

    const manager = new MigrationManager(makePaths(workspace), [
      {
        id: "unsafe-path",
        description: "return outside path",
        apply: () => ["../outside.json"],
      },
    ]);

    const result = manager.run()[0];
    expect(result.status).toBe("applied");
  });

  it("sanitizes malformed migration state entries", () => {
    const workspace = tempWorkspace("Hiro-migrate-state-");
    fs.writeFileSync(
      path.join(workspace, "data", "migrations.json"),
      JSON.stringify({
        version: 1,
        applied: [
          { id: "valid-migration", appliedAt: new Date().toISOString() },
          { id: "../unsafe", appliedAt: new Date().toISOString() },
          { id: "bad-date", appliedAt: "not-a-date" },
        ],
      }),
      "utf-8",
    );

    const manager = new MigrationManager(makePaths(workspace), [
      {
        id: "valid-migration",
        description: "already applied",
        apply: () => {
          throw new Error("should not run");
        },
      },
      {
        id: "bad-date",
        description: "not actually applied",
        apply: () => ["data/bad-date.json"],
      },
    ]);

    const listed = manager.list();
    expect(listed.find((item) => item.id === "valid-migration")?.applied).toBe(
      true,
    );
    expect(listed.find((item) => item.id === "bad-date")?.applied).toBe(false);
  });

  it("detects secret leaks without exposing raw values", () => {
    const workspace = tempWorkspace("Hiro-scan-");
    const docsDir = path.join(workspace, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspace, ".env"),
      "OPENAI_API_KEY=sk-test-secret-value-1234567890\n",
      "utf-8",
    );
    fs.writeFileSync(
      path.join(docsDir, "leak.md"),
      "token: xoxb-test-secret-value-1234567890\n",
      "utf-8",
    );

    const report = scanSecrets(makePaths(workspace));

    expect(report.findings).toHaveLength(2);
    for (const finding of report.findings) {
      expect(finding.redactedPreview).not.toContain("secret-value");
    }

    const fixed = scanSecrets(makePaths(workspace), { fix: true });
    expect(fixed.fixedFiles).toEqual([path.join("docs", "leak.md")]);
    expect(fs.readFileSync(path.join(workspace, ".env"), "utf-8")).toContain(
      "sk-test-secret-value-1234567890",
    );
    expect(fs.readFileSync(path.join(docsDir, "leak.md"), "utf-8")).toContain(
      "[REDACTED]",
    );
  });

  it("skips symlinked and oversized secret-scan candidates", () => {
    const workspace = tempWorkspace("Hiro-scan-safety-");
    const docsDir = path.join(workspace, "docs");
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(
      path.join(docsDir, "large.log"),
      `sk-test-secret-value-1234567890\n${"x".repeat(2 * 1024 * 1024)}`,
      "utf-8",
    );

    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "Hiro-outside-"));
    const outsideSecret = path.join(outside, "outside.md");
    fs.writeFileSync(outsideSecret, "sk-outside-secret-value-1234567890");
    const linkPath = path.join(docsDir, "linked.md");
    try {
      fs.symlinkSync(outsideSecret, linkPath);
    } catch {
      // Windows without developer mode may not allow symlink creation.
    }

    const report = scanSecrets(makePaths(workspace), { fix: true });
    expect(report.findings.map((finding) => finding.file)).not.toContain(
      path.join("docs", "large.log"),
    );
    expect(report.findings.map((finding) => finding.file)).not.toContain(
      path.join("docs", "linked.md"),
    );
    expect(fs.readFileSync(outsideSecret, "utf-8")).toContain(
      "sk-outside-secret",
    );
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("records safe-mode reasons and escalates watchdog failures", () => {
    const workspace = tempWorkspace("Hiro-safe-");
    const safeMode = new SafeModeManager(
      path.join(workspace, "data", "safe-mode.json"),
    );
    const audit = new SqliteAuditLog(path.join(workspace, "data", "audit.db"));
    const watchdog = new Watchdog(safeMode, audit, 2, 1);

    watchdog.recordProbe({ name: "gateway", healthy: false, message: "down" });
    watchdog.recordProbe({ name: "gateway", healthy: false, message: "down" });

    const state = safeMode.getState();
    expect(state.enabled).toBe(true);
    expect(state.reasons[0].module).toBe("watchdog:gateway");
    expect(audit.list({ type: "system.event" }).length).toBeGreaterThan(0);
  });

  it("sanitizes malformed safe-mode state and returns watchdog snapshots", () => {
    const workspace = tempWorkspace("Hiro-safe-sanitize-");
    const statePath = path.join(workspace, "data", "safe-mode.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify({
        enabled: true,
        updatedAt: "not-a-date",
        reasons: [
          {
            module: "valid",
            reason: "needs attention",
            severity: "critical",
            recommendation: "inspect",
            createdAt: new Date().toISOString(),
          },
          {
            module: "../invalid",
            reason: "",
            severity: "urgent",
            recommendation: "",
            createdAt: "nope",
          },
        ],
      }),
      "utf-8",
    );
    const safeMode = new SafeModeManager(statePath);
    const state = safeMode.getState();
    expect(state.enabled).toBe(true);
    expect(state.reasons).toEqual([
      expect.objectContaining({ module: "valid" }),
    ]);

    const watchdog = new Watchdog(safeMode);
    expect(() => watchdog.recordProbe({ name: "   ", healthy: false })).toThrow(
      /probe name/,
    );
    watchdog.recordProbe({
      name: " gateway ",
      healthy: false,
      message: " down ",
    });
    const status = watchdog.status();
    status.services[0].failures = 999;
    expect(watchdog.status().services[0].failures).toBe(1);
    expect(watchdog.status().services[0].name).toBe("gateway");
    expect(watchdog.status().services[0].lastMessage).toBe("down");
  });

  it("builds a doctor report with stable check ids", async () => {
    const workspace = tempWorkspace("Hiro-doctor-");
    const report = await runDoctor(makePaths(workspace), {
      includeExternalChecks: false,
      includeMigrations: true,
      includeSecretScan: true,
    });

    expect(report.checks.map((item) => item.id)).toEqual(
      expect.arrayContaining([
        "node_version",
        "npm_version",
        "runtime_files",
        "config_validation",
        "sqlite_access",
        "migrations",
        "secret_scan",
      ]),
    );
  });

  it("exposes Hiro doctor as JSON from the launcher", () => {
    const result = child_process.spawnSync(
      process.execPath,
      ["bin/owlclaw-doctor.mjs", "--json", "--skip-external"],
      {
        cwd: process.cwd(),
        encoding: "utf-8",
        shell: false,
        timeout: 60_000,
      },
    );

    expect([0, 1]).toContain(result.status);
    const report = JSON.parse(result.stdout) as {
      checks: Array<{ id: string }>;
    };
    expect(report.checks.map((item) => item.id)).toContain("sqlite_access");
  });
});
