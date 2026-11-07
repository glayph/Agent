import Database from "better-sqlite3";
import { createChatMediaDelivery } from "./chat-media-delivery.js";
import type { RunStream } from "./stream-hub.js";

const attachment = { type: "video" as const, url: "/api/chat-media?path=x", filename: "clip.mp4", content_type: "video/mp4" };

function setup() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE chat_sessions (id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', model_name TEXT, context_id TEXT, image_urls TEXT, attachments_json TEXT, reply_to_message_id TEXT);
  `);
  db.prepare("INSERT INTO chat_sessions VALUES('s1','Chat','t','t')").run();
  const published: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const sent: string[] = [];
  const open = { readyState: 1, OPEN: 1, send: (data: string) => { sent.push(data); } };
  const closed = { readyState: 3, OPEN: 1, send: () => { throw new Error("closed sockets must be skipped"); } };
  const streams = new Map<string, RunStream>();
  const deliver = createChatMediaDelivery({
    db,
    now: () => "2026-11-02T00:00:00.000Z",
    getStream: (runId) => streams.get(runId),
    publish: (_stream, type, payload) => { published.push({ type, payload }); },
    ensureSession: (id) => { db.prepare("INSERT OR IGNORE INTO chat_sessions VALUES(?,?,?,?)").run(id, "Miki chat", "t", "t"); },
    proactiveSockets: [open, closed],
  });
  return { db, deliver, published, sent, streams };
}

describe("chat media delivery", () => {
  it("posts into the live conversation of a streaming run and stores the files", async () => {
    const { db, deliver, published, sent, streams } = setup();
    streams.set("run-1", { runId: "run-1", sessionId: "s1", contextId: "ctx-1", replyToMessageId: "user-9", checkpointId: "c", sequence: 0, events: [], subscribers: new Set(), done: false, expiresAt: 0 });
    await deliver({ runId: "run-1", caption: "ভিডিও", attachments: [attachment] });
    expect(published).toHaveLength(1);
    expect(published[0].type).toBe("message.create");
    expect(published[0].payload).toMatchObject({ content: "ভিডিও", kind: "normal", attachments: [attachment] });
    expect(sent).toHaveLength(0);
    const row = db.prepare("SELECT * FROM chat_messages").get() as Record<string, string>;
    expect(row).toMatchObject({ session_id: "s1", role: "assistant", content: "ভিডিও", context_id: "ctx-1", reply_to_message_id: "user-9", kind: "normal" });
    expect(JSON.parse(row.attachments_json)).toEqual([attachment]);
    expect(row.id).toBe(published[0].payload.message_id);
  });

  it("posts a background run's files to the main chat as a proactive message", async () => {
    const { db, deliver, published, sent } = setup();
    await deliver({ runId: "auto-7", caption: "", attachments: [attachment] });
    expect(published).toHaveLength(0);
    expect(sent).toHaveLength(1);
    const frame = JSON.parse(sent[0]);
    expect(frame.type).toBe("proactive.message");
    expect(frame.payload).toMatchObject({ session_id: "miki-main-chat", content: "", run_id: "auto-7", attachments: [attachment] });
    expect(frame.payload.notification_kind).toBeUndefined();
    const row = db.prepare("SELECT * FROM chat_messages").get() as Record<string, string>;
    expect(row).toMatchObject({ session_id: "miki-main-chat", context_id: "proactive:result:auto-7" });
  });

  it("uses the run's own session for background runs that have one", async () => {
    const { db, deliver } = setup();
    await deliver({ runId: "bg-1", sessionId: "s1", caption: "ok", attachments: [attachment] });
    expect((db.prepare("SELECT session_id FROM chat_messages").get() as { session_id: string }).session_id).toBe("s1");
  });

  it("falls back to a stored proactive message when the run's stream already finished", async () => {
    const { deliver, published, sent, streams } = setup();
    streams.set("run-2", { runId: "run-2", sessionId: "s1", contextId: "ctx", checkpointId: "c", sequence: 0, events: [], subscribers: new Set(), done: true, expiresAt: 0 });
    await deliver({ runId: "run-2", sessionId: "s1", caption: "late", attachments: [attachment] });
    expect(published).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });
});
