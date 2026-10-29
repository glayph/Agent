import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { consumeFeedbackRateLimit, feedbackLearningInput, feedbackNoteFor, findAnswerForFeedback, mayBeFollowUpFeedback, parseFollowUpClassification, preferenceNote, previousAnswerFor, requestContextHash } from "./answer-feedback.js";

function chatDb() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE chat_messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL,
    created_at TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'normal', model_name TEXT, context_id TEXT)`);
  const insert = db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,model_name,context_id) VALUES(?,?,?,?,?,?,?,?)");
  insert.run("u1", "s1", "user", "Summarise the report", "2026-01-01T00:00:01.000Z", "normal", null, "ctx");
  insert.run("a1", "s1", "assistant", "A long answer", "2026-01-01T00:00:02.000Z", "normal", "model-x", "ctx");
  insert.run("e1", "s1", "assistant", "provider failed", "2026-01-01T00:00:03.000Z", "error", null, "ctx");
  return db;
}

describe("answer feedback (learned memory)", () => {
  it("resolves a normal answer to the user message it answers", () => {
    const db = chatDb();
    expect(findAnswerForFeedback(db, "a1")).toEqual({
      sessionId: "s1", messageId: "a1", question: "Summarise the report", answer: "A long answer", model: "model-x",
    });
    db.close();
  });

  it("refuses user messages, error replies and unknown ids", () => {
    const db = chatDb();
    expect(findAnswerForFeedback(db, "u1")).toBeNull();
    expect(findAnswerForFeedback(db, "e1")).toBeNull();
    expect(findAnswerForFeedback(db, "missing")).toBeNull();
    db.close();
  });

  it("maps a down rating with a correction to a learning experience keyed by the request", () => {
    const db = chatDb();
    const target = findAnswerForFeedback(db, "a1")!;
    const input = feedbackLearningInput(target, { rating: "down", correction: "  keep it under 3 lines  " });
    expect(input).toMatchObject({
      taskClass: "user_feedback",
      context: "Summarise the report",
      contextHash: requestContextHash("Summarise the report"),
      actionKey: "model:model-x",
      outcome: "failure",
      rewardInput: { outcome: "failure", userFeedback: -1 },
      metadata: { rating: "down", correction: "keep it under 3 lines", messageId: "a1" },
    });
    db.close();
  });

  it("gives the same rating and correction one idempotency key, and a changed rating a new one", () => {
    const db = chatDb();
    const target = findAnswerForFeedback(db, "a1")!;
    const first = feedbackLearningInput(target, { rating: "down", correction: "shorter" });
    const again = feedbackLearningInput(target, { rating: "down", correction: "shorter" });
    const flipped = feedbackLearningInput(target, { rating: "up", correction: "shorter" });
    expect(again.idempotencyKey).toBe(first.idempotencyKey);
    expect(flipped.idempotencyKey).not.toBe(first.idempotencyKey);
    db.close();
  });

  it("reads back a note for a rejected request and ignores other kinds of memory", () => {
    const note = feedbackNoteFor([
      { taskClass: "interactive_chat", metadata: { rating: "down", correction: "ignored" } },
      { taskClass: "user_feedback", metadata: { rating: "down", correction: "keep it under 3 lines" } },
    ]);
    expect(note).toContain("Their correction: keep it under 3 lines");
    expect(note).not.toContain("ignored");
  });

  it("returns no note when nothing was rated, so the answer is unchanged", () => {
    expect(feedbackNoteFor([])).toBeUndefined();
    expect(feedbackNoteFor([{ taskClass: "interactive_chat", metadata: {} }])).toBeUndefined();
  });

  it("reads the previous answer before a follow-up message, and none when there is no earlier answer", () => {
    const db = chatDb();
    expect(previousAnswerFor(db, "s1", "ctx", "u1")).toBeNull();
    db.prepare("INSERT INTO chat_messages(id,session_id,role,content,created_at,kind,model_name,context_id) VALUES(?,?,?,?,?,?,?,?)")
      .run("u2", "s1", "user", "no, shorter please", "2026-01-01T00:00:05.000Z", "normal", null, "ctx");
    expect(previousAnswerFor(db, "s1", "ctx", "u2")).toMatchObject({ messageId: "a1", question: "Summarise the report" });
    db.close();
  });

  it("parses a classifier verdict, and treats anything invalid as no feedback", () => {
    expect(parseFollowUpClassification('{"feedback":"correction","correction":"keep it under 3 lines"}')).toEqual({
      feedback: "correction", correction: "keep it under 3 lines",
    });
    expect(parseFollowUpClassification('Here: {"feedback":"rejection","correction":""} done')).toEqual({ feedback: "rejection", correction: "" });
    expect(parseFollowUpClassification("not json at all")).toEqual({ feedback: "none", correction: "" });
    expect(parseFollowUpClassification('{"feedback":"maybe","correction":"x"}')).toEqual({ feedback: "none", correction: "" });
  });

  it("writes a learned preference as a long-term note", () => {
    expect(preferenceNote("  keep it under 3 lines ")).toBe("User preference learned from feedback: keep it under 3 lines");
  });
});

describe("follow-up feedback gate", () => {
  it("lets through varied English feedback wording", () => {
    for (const text of ["Thanks, perfect", "No, that's not it", "This is too long", "Actually I wanted a table", "try again", "never use bullet points", "Stop adding emojis"]) {
      expect(mayBeFollowUpFeedback(text)).toBe(true);
    }
  });

  it("lets through short messages in other scripts so the classifier can judge them", () => {
    for (const text of ["ভুল হয়েছে", "这个答案不对", "ответ неверный", "شكرا لك", "ありがとう"]) {
      expect(mayBeFollowUpFeedback(text)).toBe(true);
    }
  });

  it("skips ordinary new requests, empty text and over-long text", () => {
    expect(mayBeFollowUpFeedback("Summarise the quarterly report for Q3")).toBe(false);
    expect(mayBeFollowUpFeedback("   ")).toBe(false);
    expect(mayBeFollowUpFeedback("wrong ".repeat(300))).toBe(false);
  });
});

describe("feedback rate limit (shared database)", () => {
  it("allows up to the limit in a window and then refuses", () => {
    const db = new Database(":memory:");
    const results = Array.from({ length: 4 }, () => consumeFeedbackRateLimit(db, "alice", { nowMs: 1000, limit: 3 }));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[3].count).toBe(4);
    db.close();
  });

  it("counts each client separately and opens a new window after it ends", () => {
    const db = new Database(":memory:");
    for (let i = 0; i < 3; i++) consumeFeedbackRateLimit(db, "alice", { nowMs: 1000, limit: 3 });
    expect(consumeFeedbackRateLimit(db, "alice", { nowMs: 1500, limit: 3 }).allowed).toBe(false);
    expect(consumeFeedbackRateLimit(db, "bob", { nowMs: 1500, limit: 3 }).allowed).toBe(true);
    expect(consumeFeedbackRateLimit(db, "alice", { nowMs: 61_000, limit: 3 })).toEqual({ allowed: true, count: 1 });
    db.close();
  });

  it("is shared by every connection to the same database file", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "miki-rate-"));
    const file = path.join(dir, "gateway.db");
    const first = new Database(file);
    const second = new Database(file);
    consumeFeedbackRateLimit(first, "alice", { nowMs: 1000, limit: 2 });
    consumeFeedbackRateLimit(second, "alice", { nowMs: 1000, limit: 2 });
    expect(consumeFeedbackRateLimit(first, "alice", { nowMs: 1000, limit: 2 }).allowed).toBe(false);
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
