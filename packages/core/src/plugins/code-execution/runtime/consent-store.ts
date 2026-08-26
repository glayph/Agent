import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { RuntimeInstallRequest, RuntimeInstallStatus } from "./types.js";

interface RuntimeInstallRequestRow {
  id: string;
  skill_id: string;
  language: string;
  packages: string; // JSON-encoded string[]
  version_constraint: string | null;
  status: RuntimeInstallStatus;
  reason: string | null;
  error: string | null;
  manual_instructions: string | null;
  sandbox_path: string | null;
  created_at: number;
  updated_at: number;
  decided_at: number | null;
  decided_by: string | null;
}

/**
 * Persists runtime-install approval requests so that:
 *  - the CLI TUI / web UI can list pending requests and let the user
 *    approve/deny them,
 *  - an approved (skillId, language, packages) combination is never
 *    re-prompted on a later run or after a restart.
 */
export class RuntimeInstallConsentStore {
  constructor(private db: Database.Database) {
    this.ensureSchema();
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_runtime_install_requests (
        id TEXT PRIMARY KEY,
        skill_id TEXT NOT NULL,
        language TEXT NOT NULL,
        packages TEXT NOT NULL,
        version_constraint TEXT,
        status TEXT NOT NULL,
        reason TEXT,
        error TEXT,
        manual_instructions TEXT,
        sandbox_path TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        decided_at INTEGER,
        decided_by TEXT
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_install_status
      ON agent_runtime_install_requests(status)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_install_skill_lang
      ON agent_runtime_install_requests(skill_id, language)
    `);
  }

  /**
   * Find an existing request for this exact (skill, language, package set),
   * regardless of status — used to avoid creating duplicate pending
   * requests and to detect already-approved combinations.
   */
  findByFingerprint(
    skillId: string,
    language: string,
    packages: string[],
  ): RuntimeInstallRequest | undefined {
    const fingerprint = this.packageFingerprint(packages);
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_runtime_install_requests
         WHERE skill_id = ? AND language = ?
         ORDER BY updated_at DESC`,
      )
      .all(skillId, language) as RuntimeInstallRequestRow[];
    const match = rows.find(
      (row) =>
        this.packageFingerprint(JSON.parse(row.packages)) === fingerprint,
    );
    return match ? this._fromRow(match) : undefined;
  }

  getById(id: string): RuntimeInstallRequest | undefined {
    const row = this.db
      .prepare(`SELECT * FROM agent_runtime_install_requests WHERE id = ?`)
      .get(id) as RuntimeInstallRequestRow | undefined;
    return row ? this._fromRow(row) : undefined;
  }

  listPending(): RuntimeInstallRequest[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_runtime_install_requests
         WHERE status = 'pending'
         ORDER BY created_at ASC`,
      )
      .all() as RuntimeInstallRequestRow[];
    return rows.map((r) => this._fromRow(r));
  }

  listRecent(limit = 50): RuntimeInstallRequest[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_runtime_install_requests
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(limit) as RuntimeInstallRequestRow[];
    return rows.map((r) => this._fromRow(r));
  }

  createPending(
    skillId: string,
    language: string,
    packages: string[],
    versionConstraint?: string,
    reason?: string,
  ): RuntimeInstallRequest {
    const now = Date.now();
    const request: RuntimeInstallRequest = {
      id: randomUUID(),
      skillId,
      language,
      packages,
      versionConstraint,
      status: "pending",
      reason,
      createdAt: now,
      updatedAt: now,
    };
    this.upsert(request);
    return request;
  }

  decide(
    id: string,
    status: Extract<RuntimeInstallStatus, "approved" | "denied">,
    decidedBy?: string,
  ): RuntimeInstallRequest | undefined {
    const existing = this.getById(id);
    if (!existing) return undefined;
    const now = Date.now();
    const updated: RuntimeInstallRequest = {
      ...existing,
      status,
      decidedAt: now,
      decidedBy,
      updatedAt: now,
    };
    this.upsert(updated);
    return updated;
  }

  markInstalling(id: string): void {
    const existing = this.getById(id);
    if (!existing) return;
    this.upsert({ ...existing, status: "installing", updatedAt: Date.now() });
  }

  markReady(id: string, sandboxPath: string): void {
    const existing = this.getById(id);
    if (!existing) return;
    this.upsert({
      ...existing,
      status: "ready",
      sandboxPath,
      error: undefined,
      updatedAt: Date.now(),
    });
  }

  markFailed(id: string, error: string, manualInstructions?: string): void {
    const existing = this.getById(id);
    if (!existing) return;
    this.upsert({
      ...existing,
      status: "failed",
      error,
      manualInstructions,
      updatedAt: Date.now(),
    });
  }

  upsert(request: RuntimeInstallRequest): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO agent_runtime_install_requests
         (id, skill_id, language, packages, version_constraint, status,
          reason, error, manual_instructions, sandbox_path, created_at,
          updated_at, decided_at, decided_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        request.id,
        request.skillId,
        request.language,
        JSON.stringify(request.packages),
        request.versionConstraint ?? null,
        request.status,
        request.reason ?? null,
        request.error ?? null,
        request.manualInstructions ?? null,
        request.sandboxPath ?? null,
        request.createdAt,
        request.updatedAt,
        request.decidedAt ?? null,
        request.decidedBy ?? null,
      );
  }

  /** Order-independent identity for a package list, so package order in
   * SKILL.md doesn't cause spurious re-prompts. */
  private packageFingerprint(packages: string[]): string {
    return [...packages].sort().join(",");
  }

  private _fromRow(row: RuntimeInstallRequestRow): RuntimeInstallRequest {
    return {
      id: row.id,
      skillId: row.skill_id,
      language: row.language,
      packages: JSON.parse(row.packages),
      versionConstraint: row.version_constraint ?? undefined,
      status: row.status,
      reason: row.reason ?? undefined,
      error: row.error ?? undefined,
      manualInstructions: row.manual_instructions ?? undefined,
      sandboxPath: row.sandbox_path ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      decidedAt: row.decided_at ?? undefined,
      decidedBy: row.decided_by ?? undefined,
    };
  }
}
