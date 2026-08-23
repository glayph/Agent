import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import type { ChatMessage, VoiceMessageMetadata } from "@miki/config";

export interface SessionMetadata {
  created: string;
  updated: string;
  title?: string;
  pinned?: boolean;
}

export interface PersistedSession {
  messages: ChatMessage[];
  metadata: SessionMetadata;
}

interface SessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  title: string | null;
  pinned: number;
}

interface MessageRow {
  session_id: string;
  position: number;
  id: string;
  created_at: string;
  role: string;
  content: string;
  image_urls: string | null;
  voice_json: string | null;
}

function parseVoiceMetadata(
  value: string | null,
): VoiceMessageMetadata | undefined {
  if (!value) return undefined;
  try {
    const raw = JSON.parse(value) as Record<string, unknown>;
    if (
      (raw.source !== "microphone" && raw.source !== "upload") ||
      raw.provider !== "whisper.cpp" ||
      typeof raw.language !== "string" ||
      typeof raw.transcript !== "string" ||
      raw.transcript.length > 50_000
    ) {
      return undefined;
    }
    const duration = Number(raw.duration_ms);
    const latency = Number(raw.latency_ms);
    return {
      source: raw.source,
      provider: "whisper.cpp",
      language: raw.language.trim().slice(0, 20),
      transcript: raw.transcript,
      ...(Number.isFinite(duration) && duration >= 0
        ? { duration_ms: Math.round(duration) }
        : {}),
      ...(Number.isFinite(latency) && latency >= 0
        ? { latency_ms: Math.round(latency) }
        : {}),
      ...(raw.transport === "endpoint" || raw.transport === "cli"
        ? { transport: raw.transport }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function serializeVoiceMetadata(
  value: VoiceMessageMetadata | undefined,
): string | null {
  if (!value || (value.source !== "microphone" && value.source !== "upload")) {
    return null;
  }
  return JSON.stringify({
    source: value.source,
    provider: "whisper.cpp",
    language: value.language.trim().slice(0, 20),
    transcript: value.transcript.slice(0, 50_000),
    ...(Number.isFinite(value.duration_ms) && value.duration_ms >= 0
      ? { duration_ms: Math.round(value.duration_ms) }
      : {}),
    ...(Number.isFinite(value.latency_ms) && value.latency_ms >= 0
      ? { latency_ms: Math.round(value.latency_ms) }
      : {}),
    ...(value.transport === "endpoint" || value.transport === "cli"
      ? { transport: value.transport }
      : {}),
  });
}

/** Durable transcript storage for the dashboard session list and chat surface. */
export class SqliteSessionHistoryStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS session_messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        image_urls TEXT,
        voice_json TEXT,
        PRIMARY KEY (session_id, position),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_session_messages_id
        ON session_messages (session_id, id);
    `);
    const columns = this.db
      .prepare("PRAGMA table_info(session_messages)")
      .all() as Array<{ name?: string }>;
    if (!columns.some((column) => column.name === "voice_json")) {
      this.db.exec("ALTER TABLE session_messages ADD COLUMN voice_json TEXT");
    }
  }

  load(): Map<string, PersistedSession> {
    const sessions = this.db
      .prepare(
        "SELECT id, created_at, updated_at, title, pinned FROM sessions ORDER BY updated_at ASC",
      )
      .all() as SessionRow[];
    const messages = this.db
      .prepare(
        "SELECT session_id, position, id, created_at, role, content, image_urls, voice_json FROM session_messages ORDER BY session_id, position ASC",
      )
      .all() as MessageRow[];
    const bySession = new Map<string, ChatMessage[]>();

    for (const row of messages) {
      let imageUrls: string[] | undefined;
      if (row.image_urls) {
        try {
          const parsed: unknown = JSON.parse(row.image_urls);
          if (Array.isArray(parsed)) {
            imageUrls = parsed.filter(
              (value): value is string => typeof value === "string",
            );
          }
        } catch {
          imageUrls = undefined;
        }
      }
      const voice = parseVoiceMetadata(row.voice_json);
      const message: ChatMessage = {
        id: row.id,
        created_at: row.created_at,
        role: row.role as ChatMessage["role"],
        content: row.content,
        ...(imageUrls && imageUrls.length > 0 ? { image_urls: imageUrls } : {}),
        ...(voice ? { voice } : {}),
      };
      const history = bySession.get(row.session_id) || [];
      history.push(message);
      bySession.set(row.session_id, history);
    }

    const restored = new Map<string, PersistedSession>();
    for (const row of sessions) {
      restored.set(row.id, {
        messages: bySession.get(row.id) || [],
        metadata: {
          created: row.created_at,
          updated: row.updated_at,
          ...(row.title ? { title: row.title } : {}),
          ...(row.pinned ? { pinned: true } : {}),
        },
      });
    }
    return restored;
  }

  save(
    sessionId: string,
    messages: ChatMessage[],
    metadata: SessionMetadata,
  ): void {
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO sessions (id, created_at, updated_at, title, pinned)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             title = excluded.title,
             pinned = excluded.pinned`,
        )
        .run(
          sessionId,
          metadata.created,
          metadata.updated,
          metadata.title ?? null,
          metadata.pinned === true ? 1 : 0,
        );
      this.db
        .prepare("DELETE FROM session_messages WHERE session_id = ?")
        .run(sessionId);
      const insert = this.db.prepare(
        `INSERT INTO session_messages (session_id, position, id, created_at, role, content, image_urls, voice_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      messages.forEach((message, position) => {
        const imageUrls = Array.isArray(message.image_urls)
          ? message.image_urls.filter(
              (value): value is string => typeof value === "string",
            )
          : [];
        insert.run(
          sessionId,
          position,
          message.id || `${sessionId}-${position}`,
          message.created_at || metadata.updated,
          message.role,
          String(message.content || ""),
          imageUrls.length > 0 ? JSON.stringify(imageUrls) : null,
          serializeVoiceMetadata(message.voice),
        );
      });
    });
    transaction();
  }

  delete(sessionId: string): boolean {
    const result = this.db
      .prepare("DELETE FROM sessions WHERE id = ?")
      .run(sessionId);
    return result.changes > 0;
  }

  close(): void {
    if (this.db.open) this.db.close();
  }
}
