import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import { type RuntimePaths } from "../paths.js";
import {
  migrateRuntimeConfig,
  validateRuntimeConfig,
} from "@hiro/config";

export interface MigrationDefinition {
  id: string;
  description: string;
  apply(paths: RuntimePaths, dryRun: boolean): string[];
}

export interface AppliedMigration {
  id: string;
  appliedAt: string;
}

export interface MigrationRunResult {
  id: string;
  status: "applied" | "skipped" | "failed" | "dry_run";
  changedPaths: string[];
  error?: string;
}

export interface MigrationState {
  version: 1;
  applied: AppliedMigration[];
}

function statePath(dataDir: string): string {
  return path.join(dataDir, "migrations.json");
}

function loadState(dataDir: string): MigrationState {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(dataDir), "utf-8"));
    if (parsed && Array.isArray(parsed.applied)) {
      const applied = parsed.applied.filter((item: unknown) => {
        if (!item || typeof item !== "object") return false;
        const candidate = item as Partial<AppliedMigration>;
        return (
          typeof candidate.id === "string" &&
          isSafeMigrationId(candidate.id) &&
          typeof candidate.appliedAt === "string" &&
          !Number.isNaN(Date.parse(candidate.appliedAt))
        );
      });
      return { version: 1, applied };
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return { version: 1, applied: [] };
}

function saveState(dataDir: string, state: MigrationState): void {
  const target = statePath(dataDir);
  const tmp = `${target}.tmp`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  fs.renameSync(tmp, target);
}

function agentConfigPath(configDir: string): string {
  return path.join(configDir, "agent.yaml");
}

function isSafeMigrationId(id: string): boolean {
  return /^[a-z][a-z0-9_-]{0,127}$/i.test(id);
}

function assertSafeChangedPaths(
  _workspaceDir: string,
  migrationId: string,
  changedPaths: string[],
): void {
  for (const changedPath of changedPaths) {
    if (typeof changedPath !== "string" || !changedPath.trim()) {
      throw new Error(`Migration "${migrationId}" returned an empty path`);
    }
  }
}

function validateMigrationDefinitions(migrations: MigrationDefinition[]): void {
  const seen = new Set<string>();
  for (const migration of migrations) {
    if (!isSafeMigrationId(migration.id)) {
      throw new Error(`Invalid migration id: ${migration.id}`);
    }
    if (seen.has(migration.id)) {
      throw new Error(`Duplicate migration id: ${migration.id}`);
    }
    seen.add(migration.id);
  }
}

export const builtinMigrations: MigrationDefinition[] = [
  {
    id: "runtime-config-schema-v1",
    description: "Normalize agent.yaml into the current runtime config schema.",
    apply(paths: RuntimePaths, dryRun: boolean): string[] {
      const target = agentConfigPath(paths.configDir);
      if (!fs.existsSync(target)) return [];
      const raw = fs.readFileSync(target, "utf-8");
      const parsed = (yaml.load(raw) || {}) as Record<string, unknown>;
      const migrated = migrateRuntimeConfig(parsed);
      const validation = validateRuntimeConfig(migrated);
      if (!validation.valid) {
        throw new Error(
          validation.errors
            .map((item) => `${item.path}: ${item.message}`)
            .join("; "),
        );
      }
      if (!dryRun) {
        fs.writeFileSync(target, yaml.dump(validation.config), "utf-8");
      }
      return [path.relative(paths.sourceDir ?? paths.dataDir, target)];
    },
  },
];

export class MigrationManager {
  constructor(
    private readonly paths: RuntimePaths,
    private readonly migrations: MigrationDefinition[] = builtinMigrations,
  ) {
    validateMigrationDefinitions(migrations);
  }

  list(): Array<
    MigrationDefinition & { applied: boolean; appliedAt?: string }
  > {
    const state = loadState(this.paths.dataDir);
    return this.migrations.map((migration) => {
      const applied = state.applied.find((item) => item.id === migration.id);
      return {
        ...migration,
        applied: Boolean(applied),
        appliedAt: applied?.appliedAt,
      };
    });
  }

  run(options: { dryRun?: boolean } = {}): MigrationRunResult[] {
    const dryRun = options.dryRun === true;
    const state = loadState(this.paths.dataDir);
    const applied = new Set(state.applied.map((item) => item.id));
    const results: MigrationRunResult[] = [];

    for (const migration of this.migrations) {
      if (applied.has(migration.id) && !dryRun) {
        results.push({
          id: migration.id,
          status: "skipped",
          changedPaths: [],
        });
        continue;
      }
      try {
        const changedPaths = migration.apply(this.paths, dryRun);
        assertSafeChangedPaths(
          this.paths.sourceDir ?? this.paths.dataDir,
          migration.id,
          changedPaths,
        );
        results.push({
          id: migration.id,
          status: dryRun ? "dry_run" : "applied",
          changedPaths,
        });
        if (!dryRun && !applied.has(migration.id)) {
          state.applied.push({
            id: migration.id,
            appliedAt: new Date().toISOString(),
          });
        }
      } catch (err: unknown) {
        results.push({
          id: migration.id,
          status: "failed",
          changedPaths: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!dryRun) saveState(this.paths.dataDir, state);
    return results;
  }
}

export function createMigrationManager(paths: RuntimePaths): MigrationManager {
  return new MigrationManager(paths);
}
