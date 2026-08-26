import { describe, expect, it } from "vitest";
import {
  canReadMemory,
  createGovernedMemoryWrite,
  redactMemoryContent,
  retentionExpiresAt,
} from "./memory-governance.js";

describe("memory governance", () => {
  it("redacts secrets and contact identifiers", () => {
    const secret = ["AIza", "SyDUMMY012345678901234567890"].join("");
    const result = redactMemoryContent(
      `api_key=${secret} email=test@example.com`,
    );
    expect(result.redactions).toBeGreaterThanOrEqual(2);
    expect(result.content).not.toContain(secret);
    expect(result.content).not.toContain("test@example.com");
    expect(result.content).toContain("[REDACTED]");
  });

  it("defaults sensitive writes to session retention", () => {
    const write = createGovernedMemoryWrite({
      content: "password: super-secret",
      source: "tool",
      scope: { kind: "user", id: "user-1" },
    });
    expect(write.sensitive).toBe(true);
    expect(write.retention).toBe("session");
    expect(write.metadata.memory_scope).toBe("user:user-1");
  });

  it("isolates scopes while allowing the Miki agent scope to read", () => {
    expect(
      canReadMemory({ kind: "user", id: "a" }, { kind: "user", id: "a" }),
    ).toBe(true);
    expect(
      canReadMemory({ kind: "user", id: "a" }, { kind: "user", id: "b" }),
    ).toBe(false);
    expect(
      canReadMemory(
        { kind: "agent", id: "miki" },
        { kind: "project", id: "p" },
      ),
    ).toBe(true);
  });

  it("calculates retention expiry without expiring durable memory", () => {
    const now = Date.UTC(2026, 0, 1);
    expect(retentionExpiresAt("durable", now)).toBeNull();
    expect(retentionExpiresAt("30d", now)).toBe(
      new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(retentionExpiresAt("session", now)).toBe(
      new Date(now).toISOString(),
    );
  });
});
