import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { redactSecrets } from "@hiro/config";

export type AuditEventType =
  | "auth.login"
  | "auth.logout"
  | "config.update"
  | "secret.write"
  | "secret.delete"
  | "model.change"
  | "tool.execute"
  | "plugin.execute"
  | "plugin.channel_runtime"
  | "channel.message"
  | "agent.run"
  | "system.event";

export interface AuditEventInput {
  type: AuditEventType;
  actor?: string;
  subject?: string;
  requestId?: string;
  runId?: string;
  details?: Record<string, unknown>;
  createdAt?: string;
}

export interface AuditEvent extends Required<Omit<AuditEventInput, "details">> {
  id: number;
  details: Record<string, unknown>;
}

export interface AuditEventFilter {
  type?: AuditEventType;
  actor?: string;
  subject?: string;
  limit?: number;
}

const AUDIT_EVENT_TYPES = new Set<AuditEventType>([
  "auth.login",
  "auth.logout",
  "config.update",
  "secret.write",
  "secret.delete",
  "model.change",
  "tool.execute",
  "plugin.execute",
  "plugin.channel_runtime",
  "channel.message",
  "agent.run",
  "system.event",
]);
const MAX_TEXT_LENGTH = 512;
const MAX_DETAILS_JSON_LENGTH = 64 * 1024;

function sanitizeText(value: unknown, fallback = ""): string {
  const text = typeof value === "string" ? value.trim() : fallback;
  return redactSecrets(text).slice(0, MAX_TEXT_LENGTH);
}

function normalizeCreatedAt(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return new Date().toISOString();
  }
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("Audit event createdAt must be a valid ISO timestamp.");
  }
  return new Date(value).toISOString();
}

function jsonSafeDetails(value: unknown): Record<string, unknown> {
  const seen = new WeakSet<object>();
  const visit = (input: unknown): unknown => {
    if (typeof input === "bigint") return input.toString();
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    if (Array.isArray(input)) return input.map(visit);
    return Object.fromEntries(
      Object.entries(input).map(([key, child]) => [key, visit(child)]),
    );
  };
  const normalized = visit(value || {});
  return normalized &&
    typeof normalized === "object" &&
    !Array.isArray(normalized)
    ? (normalized as Record<string, unknown>)
    : { value: normalized };
}

function normalizeDetails(value: unknown): Record<string, unknown> {
  const details = redactSecrets(jsonSafeDetails(value));
  const json = JSON.stringify(details);
  if (json.length <= MAX_DETAILS_JSON_LENGTH) return details;
  return {
    truncated: true,
    originalBytes: json.length,
    preview: redactSecrets(json.slice(0, 2048)),
  };
}

export class SqliteAuditLog {
  private readonly db: Database.Database;

  constructor(dbOrPath: Database.Database | string) {
    if (typeof dbOrPath === "string") {
      fs.mkdirSync(path.dirname(dbOrPath), { recursive: true });
      this.db = new Database(dbOrPath);
    } else {
      this.db = dbOrPath;
    }
    this.init();
  }

  record(input: AuditEventInput): AuditEvent {
    if (!AUDIT_EVENT_TYPES.has(input.type)) {
      throw new Error(`Invalid audit event type: ${input.type}`);
    }
    const createdAt = normalizeCreatedAt(input.createdAt);
    const actor = sanitizeText(input.actor, "system") || "system";
    const subject = sanitizeText(input.subject);
    const requestId = sanitizeText(input.requestId);
    const runId = sanitizeText(input.runId);
    const details = normalizeDetails(input.details || {});
    const result = this.db
      .prepare(
        `INSERT INTO audit_events
          (type, actor, subject, request_id, run_id, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.type,
        actor,
        subject,
        requestId,
        runId,
        JSON.stringify(details),
        createdAt,
      );

    return {
      id: Number(result.lastInsertRowid),
      type: input.type,
      actor,
      subject,
      requestId,
      runId,
      createdAt,
      details,
    };
  }

  list(filter: AuditEventFilter = {}): AuditEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.type) {
      conditions.push("type = ?");
      params.push(filter.type);
    }
    if (filter.actor) {
      conditions.push("actor = ?");
      params.push(filter.actor);
    }
    if (filter.subject) {
      conditions.push("subject = ?");
      params.push(filter.subject);
    }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(500, filter.limit || 100));
    const rows = this.db
      .prepare(
        `SELECT id, type, actor, subject, request_id, run_id, details_json, created_at
         FROM audit_events ${where}
         ORDER BY id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => this.rowToEvent(row));
  }

  exportJsonl(filter: AuditEventFilter = {}): string {
    return this.list(filter)
      .reverse()
      .map((event) => JSON.stringify(event))
      .join("\n");
  }

  close(): void {
    this.db.close();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        actor TEXT NOT NULL,
        subject TEXT NOT NULL,
        request_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_events_type_id
        ON audit_events(type, id);
      CREATE INDEX IF NOT EXISTS idx_audit_events_subject_id
        ON audit_events(subject, id);
    `);
  }

  private rowToEvent(row: Record<string, unknown>): AuditEvent {
    let details: Record<string, unknown>;
    try {
      details = normalizeDetails(JSON.parse(String(row.details_json || "{}")));
    } catch {
      details = { parseError: true };
    }
    const type = AUDIT_EVENT_TYPES.has(row.type as AuditEventType)
      ? (row.type as AuditEventType)
      : "system.event";
    return {
      id: Number(row.id),
      type,
      actor: sanitizeText(row.actor),
      subject: sanitizeText(row.subject),
      requestId: sanitizeText(row.request_id),
      runId: sanitizeText(row.run_id),
      createdAt:
        typeof row.created_at === "string" &&
        !Number.isNaN(Date.parse(row.created_at))
          ? new Date(row.created_at).toISOString()
          : "",
      details,
    };
  }
}
