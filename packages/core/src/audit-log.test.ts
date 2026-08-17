import Database from "better-sqlite3";
import { SqliteAuditLog } from "./audit-log.js";

describe("sqlite audit log", () => {
  it("records append-only redacted events and exports jsonl", () => {
    const db = new Database(":memory:");
    const audit = new SqliteAuditLog(db);

    audit.record({
      type: "secret.write",
      actor: "tester",
      subject: "models/openai",
      details: { api_key: "sk-test-secret-value-1234567890" },
    });
    audit.record({
      type: "config.update",
      actor: "tester",
      subject: "agent.yaml",
      details: { changed: true },
    });
    audit.record({
      type: "plugin.execute",
      actor: "plugin-runtime",
      subject: "tools:github_review",
      details: { status: "policy_blocked" },
    });
    audit.record({
      type: "plugin.channel_runtime",
      actor: "plugin-runtime",
      subject: "plugin_chat",
      details: { action: "started" },
    });

    const secretEvents = audit.list({ type: "secret.write" });
    expect(secretEvents).toHaveLength(1);
    expect(secretEvents[0].details.api_key).toBe("[REDACTED]");
    expect(audit.list({ type: "plugin.execute" })).toHaveLength(1);
    expect(audit.list({ type: "plugin.channel_runtime" })).toHaveLength(1);
    expect(audit.exportJsonl()).toContain("config.update");
  });

  it("redacts scalar fields and normalizes timestamps", () => {
    const db = new Database(":memory:");
    const audit = new SqliteAuditLog(db);

    const event = audit.record({
      type: "tool.execute",
      actor: "user sk-test-secret-value-1234567890",
      subject: "https://example.test/?api_key=sk-test-secret-value-1234567890",
      requestId: "req-1",
      runId: "run-1",
      createdAt: "2026-01-02T03:04:05.000Z",
      details: { ok: true },
    });

    expect(event.actor).not.toContain("sk-test-secret-value");
    expect(event.subject).not.toContain("sk-test-secret-value");
    expect(event.createdAt).toBe("2026-01-02T03:04:05.000Z");
    expect(audit.list()[0]).toMatchObject({
      requestId: "req-1",
      runId: "run-1",
    });
  });

  it("handles circular and oversized details without leaking secrets", () => {
    const db = new Database(":memory:");
    const audit = new SqliteAuditLog(db);
    const details: Record<string, unknown> = {
      api_key: "sk-test-secret-value-1234567890",
      payload: "x".repeat(70_000),
    };
    details.self = details;

    const event = audit.record({
      type: "system.event",
      details,
    });

    expect(event.details.truncated).toBe(true);
    expect(JSON.stringify(event.details)).not.toContain("sk-test-secret-value");
  });

  it("rejects invalid event metadata", () => {
    const db = new Database(":memory:");
    const audit = new SqliteAuditLog(db);

    expect(() =>
      audit.record({
        type: "system.event",
        createdAt: "not-a-date",
      }),
    ).toThrow(/createdAt/);
    expect(() =>
      audit.record({
        type: "not.valid" as "system.event",
      }),
    ).toThrow(/Invalid audit event type/);
  });

  it("survives malformed stored detail rows", () => {
    const db = new Database(":memory:");
    const audit = new SqliteAuditLog(db);
    db.prepare(
      `INSERT INTO audit_events
        (type, actor, subject, request_id, run_id, details_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "unknown.type",
      "actor",
      "subject",
      "",
      "",
      "{malformed-json",
      "not-a-date",
    );

    expect(audit.list()[0]).toMatchObject({
      type: "system.event",
      details: { parseError: true },
      createdAt: "",
    });
  });
});
