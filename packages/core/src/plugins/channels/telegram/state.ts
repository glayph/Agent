import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

export class TelegramStateStore {
  private readonly db: Database.Database;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new Database(path.join(dataDir, "telegram-state.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_updates (
        update_id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'claimed'
      );
      CREATE TABLE IF NOT EXISTS telegram_deliveries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        update_id TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        reply_to TEXT,
        content TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending',
        last_error TEXT,
        next_attempt_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_telegram_deliveries_retry
        ON telegram_deliveries(status, next_attempt_at);
      CREATE TABLE IF NOT EXISTS telegram_rate_limits (
        sender_id TEXT PRIMARY KEY,
        window_started_at INTEGER NOT NULL,
        request_count INTEGER NOT NULL
      );
    `);
  }

  claimUpdate(updateId: string): boolean {
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        "SELECT status, received_at FROM telegram_updates WHERE update_id = ?",
      )
      .get(updateId) as { status: string; received_at: string } | undefined;
    if (!existing) {
      this.db
        .prepare(
          "INSERT INTO telegram_updates(update_id, received_at, status) VALUES (?, ?, 'claimed')",
        )
        .run(updateId, now);
      return true;
    }
    if (existing.status === "completed") return false;
    if (existing.status === "failed") {
      this.db
        .prepare(
          "UPDATE telegram_updates SET received_at = ?, status = 'claimed' WHERE update_id = ?",
        )
        .run(now, updateId);
      return true;
    }
    const age = Date.now() - Date.parse(existing.received_at);
    if (age > 10 * 60_000) {
      this.db
        .prepare(
          "UPDATE telegram_updates SET received_at = ?, status = 'claimed' WHERE update_id = ?",
        )
        .run(now, updateId);
      return true;
    }
    return false;
  }

  completeUpdate(updateId: string): void {
    this.db
      .prepare(
        "UPDATE telegram_updates SET status = 'completed' WHERE update_id = ?",
      )
      .run(updateId);
  }

  failUpdate(updateId: string): void {
    this.db
      .prepare(
        "UPDATE telegram_updates SET status = 'failed' WHERE update_id = ?",
      )
      .run(updateId);
  }

  allowRate(senderId: string, limit: number, windowMs = 60_000): boolean {
    const now = Date.now();
    const transaction = this.db.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT window_started_at, request_count FROM telegram_rate_limits WHERE sender_id = ?",
        )
        .get(senderId) as
        { window_started_at: number; request_count: number } | undefined;
      if (!row || now - row.window_started_at >= windowMs) {
        this.db
          .prepare(
            "INSERT INTO telegram_rate_limits(sender_id, window_started_at, request_count) VALUES (?, ?, 1) ON CONFLICT(sender_id) DO UPDATE SET window_started_at=excluded.window_started_at, request_count=1",
          )
          .run(senderId, now);
        return true;
      }
      if (row.request_count >= limit) return false;
      this.db
        .prepare(
          "UPDATE telegram_rate_limits SET request_count = request_count + 1 WHERE sender_id = ?",
        )
        .run(senderId);
      return true;
    });
    return transaction();
  }

  recordDelivery(
    updateId: string,
    chatId: string,
    content: string,
    replyTo?: string,
    attempts = 0,
    status: "sent" | "failed" = "sent",
    error?: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO telegram_deliveries
       (update_id, chat_id, reply_to, content, attempts, status, last_error, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        updateId,
        chatId,
        replyTo ?? null,
        content,
        attempts,
        status,
        error ?? null,
        new Date().toISOString(),
      );
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
