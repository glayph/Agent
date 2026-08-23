import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@miki/config";
import { SqliteSessionHistoryStore } from "./session-history-store.js";

const openStores: SqliteSessionHistoryStore[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of tempDirs.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe("SqliteSessionHistoryStore", () => {
  it("restores ordered messages and metadata after reopening the database", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-session-history-"),
    );
    tempDirs.push(directory);
    const dbPath = path.join(directory, "session-history.db");
    const first = new SqliteSessionHistoryStore(dbPath);
    openStores.push(first);
    const messages: ChatMessage[] = [
      {
        id: "u1",
        created_at: "2026-08-21T00:00:00.000Z",
        role: "user",
        content: "Hello Miki",
      },
      {
        id: "a1",
        created_at: "2026-08-21T00:00:01.000Z",
        role: "assistant",
        content: "Hello, I am here.",
      },
    ];
    first.save("session-1", messages, {
      created: "2026-08-21T00:00:00.000Z",
      updated: "2026-08-21T00:00:01.000Z",
      title: "Persistent chat",
      pinned: true,
    });
    first.close();
    openStores.splice(openStores.indexOf(first), 1);

    const reopened = new SqliteSessionHistoryStore(dbPath);
    openStores.push(reopened);
    const restored = reopened.load().get("session-1");
    expect(restored).toEqual({
      messages,
      metadata: {
        created: "2026-08-21T00:00:00.000Z",
        updated: "2026-08-21T00:00:01.000Z",
        title: "Persistent chat",
        pinned: true,
      },
    });
  });

  it("migrates and restores safe voice transcript metadata", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-session-history-"),
    );
    tempDirs.push(directory);
    const dbPath = path.join(directory, "legacy-history.db");
    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        title TEXT,
        pinned INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE session_messages (
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        image_urls TEXT,
        PRIMARY KEY (session_id, position)
      );
    `);
    legacy.close();

    const store = new SqliteSessionHistoryStore(dbPath);
    openStores.push(store);
    const voiceMessage: ChatMessage = {
      id: "voice-1",
      created_at: "2026-08-21T00:00:00.000Z",
      role: "user",
      content: "Please summarize this voice message.",
      voice: {
        source: "microphone",
        provider: "whisper.cpp",
        language: "en",
        transcript: "Please summarize this voice message.",
        duration_ms: 4200,
        latency_ms: 730,
        transport: "endpoint",
      },
    };
    store.save("session-voice", [voiceMessage], {
      created: "2026-08-21T00:00:00.000Z",
      updated: "2026-08-21T00:00:00.000Z",
    });
    store.close();
    openStores.splice(openStores.indexOf(store), 1);

    const reopened = new SqliteSessionHistoryStore(dbPath);
    openStores.push(reopened);
    expect(reopened.load().get("session-voice")?.messages).toEqual([
      voiceMessage,
    ]);
  });

  it("deletes a session and its messages durably", () => {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-session-history-"),
    );
    tempDirs.push(directory);
    const dbPath = path.join(directory, "session-history.db");
    const store = new SqliteSessionHistoryStore(dbPath);
    openStores.push(store);
    store.save("session-2", [], {
      created: "2026-08-21T00:00:00.000Z",
      updated: "2026-08-21T00:00:00.000Z",
    });
    expect(store.delete("session-2")).toBe(true);
    expect(new SqliteSessionHistoryStore(dbPath).load().has("session-2")).toBe(
      false,
    );
  });
});
