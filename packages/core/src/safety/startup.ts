import * as path from "path";
import { type RuntimePaths } from "../paths.js";
import { SqliteAuditLog } from "../audit-log.js";
import { createBackupManager } from "./backup.js";
import {
  createMigrationManager,
  type MigrationRunResult,
} from "./migrations.js";
import { createSafeModeManager } from "./safe-mode.js";
import type { SafeModeReason } from "./safe-mode.js";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function initializeSafetyAtStartup(paths: RuntimePaths): void {
  const safeMode = createSafeModeManager(paths);
  let audit: SqliteAuditLog | null = null;
  const enterSafeMode = (reason: Omit<SafeModeReason, "createdAt">): void => {
    try {
      safeMode.enter(reason);
    } catch (err: unknown) {
      console.warn(
        `Safe mode state could not be written: ${errorMessage(err)}`,
      );
    }
  };

  try {
    audit = new SqliteAuditLog(path.join(paths.dataDir, "audit.db"));
  } catch (err: unknown) {
    enterSafeMode({
      module: "audit-log",
      reason: errorMessage(err),
      severity: "warning",
      recommendation:
        "Check data/ permissions; startup continued without durable audit logging.",
    });
  }

  try {
    createBackupManager(paths).createBackup("startup", {
      includeOperationalData: false,
    });
  } catch (err: unknown) {
    enterSafeMode({
      module: "backup",
      reason: errorMessage(err),
      severity: "warning",
      recommendation:
        "Check data/backups permissions; startup continued without a fresh backup.",
    });
  }

  let migrationResults: MigrationRunResult[] = [];
  try {
    migrationResults = createMigrationManager(paths).run();
    const failedMigration = migrationResults.find(
      (item) => item.status === "failed",
    );
    if (failedMigration) {
      enterSafeMode({
        module: "migrations",
        reason: failedMigration.error || "Migration failed.",
        severity: "critical",
        recommendation:
          "Inspect config/data migration output and consider rollback before continuing.",
      });
    }
  } catch (err: unknown) {
    enterSafeMode({
      module: "migrations",
      reason: errorMessage(err),
      severity: "critical",
      recommendation:
        "Inspect config/data migration output and consider rollback before continuing.",
    });
  }

  try {
    audit?.record({
      type: "system.event",
      subject: "safety.startup",
      details: {
        migrations: migrationResults,
        safeMode: safeMode.getState().enabled,
      },
    });
  } catch (err: unknown) {
    console.warn(
      `Safety startup audit could not be recorded: ${errorMessage(err)}`,
    );
  }
}
