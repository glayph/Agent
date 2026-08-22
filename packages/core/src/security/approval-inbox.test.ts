import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ApprovalInbox, requiresHumanApproval } from "./approval-inbox.js";

describe("ApprovalInbox", () => {
  it("requires approval for external side effects but not ordinary browser navigation", () => {
    expect(requiresHumanApproval("payment")).toBe(true);
    expect(requiresHumanApproval("publish")).toBe(true);
    expect(requiresHumanApproval("browser_navigation")).toBe(false);
  });

  it("issues a token, approves once, and blocks invalid/replayed tokens", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miki-approval-"));
    const audit: Array<{ type: string; subject: string }> = [];
    const inbox = new ApprovalInbox(path.join(directory, "approvals.json"), {
      audit: {
        record: (event) =>
          audit.push({ type: event.type, subject: event.subject }),
      },
    });
    const challenge = inbox.request({
      runId: "run-1",
      actor: "agent",
      action: "payment",
      resource: "merchant:example",
      risk: "critical",
      reason: "User explicitly requested checkout",
      nowMs: 1_000,
    });

    expect(challenge.token).toHaveLength(43);
    expect(challenge.request.status).toBe("pending");
    expect(inbox.isApproved(challenge.request.id, challenge.token, 2_000)).toBe(
      false,
    );
    expect(() =>
      inbox.approve(challenge.request.id, "wrong", "operator", "ok", 2_000),
    ).toThrow(/Invalid approval token/);

    const approved = inbox.approve(
      challenge.request.id,
      challenge.token,
      "operator",
      "confirmed",
      2_000,
    );
    expect(approved.status).toBe("approved");
    expect(inbox.isApproved(challenge.request.id, challenge.token, 2_001)).toBe(
      true,
    );
    expect(() =>
      inbox.approve(
        challenge.request.id,
        challenge.token,
        "operator",
        "replay",
        2_002,
      ),
    ).toThrow(/already approved/);
    expect(audit.map((event) => event.type)).toEqual([
      "approval.requested",
      "approval.approved",
    ]);
  });

  it("consumes an approved request only for its bound run, step, delivery and preview", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miki-approval-"));
    const inbox = new ApprovalInbox(path.join(directory, "approvals.json"));
    const challenge = inbox.request({
      runId: "run-bound",
      actor: "agent",
      action: "publish",
      resource: "site:example",
      risk: "high",
      reason: "mock delivery",
      context: {
        runId: "run-bound",
        stepId: "step-1",
        deliveryId: "delivery-1",
        previewHash: "hash-1",
      },
      nowMs: 100,
    });
    inbox.approveByOperator(challenge.request.id, "operator", "confirmed", 101);
    expect(() =>
      inbox.consumeByContext(challenge.request.id, {
        runId: "run-other",
        stepId: "step-1",
        deliveryId: "delivery-1",
        previewHash: "hash-1",
      }),
    ).toThrow(/context mismatch/i);
    const consumed = inbox.consumeByContext(
      challenge.request.id,
      {
        runId: "run-bound",
        stepId: "step-1",
        deliveryId: "delivery-1",
        previewHash: "hash-1",
      },
      "mock-delivery",
      102,
    );
    expect(consumed.consumedBy).toBe("mock-delivery");
    expect(inbox.isApproved(challenge.request.id, challenge.token, 103)).toBe(
      false,
    );
    expect(() =>
      inbox.consumeByContext(challenge.request.id, {
        runId: "run-bound",
        stepId: "step-1",
        deliveryId: "delivery-1",
        previewHash: "hash-1",
      }),
    ).toThrow(/already been consumed/i);
  });

  it("asserts an owner-approved request by actor and immutable context without a token", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miki-approval-"));
    const inbox = new ApprovalInbox(path.join(directory, "approvals.json"));
    const challenge = inbox.request({
      runId: "run-tokenless",
      actor: "telegram:123",
      action: "external_write",
      resource: "agent-config",
      risk: "high",
      reason: "approved admin patch",
      context: {
        runId: "run-tokenless",
        stepId: "admin-config",
        deliveryId: "telegram:123",
        previewHash: "preview-1",
      },
    });
    inbox.approveByOperator(challenge.request.id, "dashboard-user");
    const context = {
      runId: "run-tokenless",
      stepId: "admin-config",
      deliveryId: "telegram:123",
      previewHash: "preview-1",
    };
    expect(
      inbox.assertApprovedByContext(
        challenge.request.id,
        context,
        "telegram:123",
      ).status,
    ).toBe("approved");
    expect(() =>
      inbox.assertApprovedByContext(
        challenge.request.id,
        context,
        "telegram:999",
      ),
    ).toThrow(/actor does not match/i);
    expect(() =>
      inbox.assertApprovedByContext(
        challenge.request.id,
        { ...context, previewHash: "different" },
        "telegram:123",
      ),
    ).toThrow(/context mismatch/i);
    inbox.consumeByContext(challenge.request.id, context, "telegram:123");
  });

  it("allows an authenticated operator to decide without exposing the worker token", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miki-approval-"));
    const inbox = new ApprovalInbox(path.join(directory, "approvals.json"));
    const challenge = inbox.request({
      runId: "run-operator",
      actor: "agent",
      action: "publish",
      resource: "site:example",
      risk: "high",
      reason: "publish requested",
      nowMs: 50,
    });
    const approved = inbox.approveByOperator(
      challenge.request.id,
      "dashboard-user",
      "confirmed",
      60,
    );
    expect(approved.status).toBe("approved");
    expect(inbox.isApproved(challenge.request.id, challenge.token, 61)).toBe(
      true,
    );
  });

  it("expires pending approvals and persists only the token hash", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miki-approval-"));
    const filePath = path.join(directory, "approvals.json");
    const first = new ApprovalInbox(filePath);
    const challenge = first.request({
      runId: "run-expire",
      actor: "agent",
      action: "external_write",
      resource: "crm:record:1",
      risk: "high",
      reason: "sync requested",
      ttlMs: 10,
      nowMs: 10_000,
    });
    const stored = fs.readFileSync(filePath, "utf8");
    expect(stored).not.toContain(challenge.token);
    expect(stored).toContain("tokenHash");

    const second = new ApprovalInbox(filePath);
    expect(second.get(challenge.request.id, 10_011)?.status).toBe("expired");
    expect(
      second.isApproved(challenge.request.id, challenge.token, 10_011),
    ).toBe(false);
    expect(() =>
      second.approve(
        challenge.request.id,
        challenge.token,
        "operator",
        "late",
        10_012,
      ),
    ).toThrow(/already expired/);
  });

  it("rejects approval when the token is valid but the request has expired", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miki-approval-"));
    const inbox = new ApprovalInbox(path.join(directory, "approvals.json"));
    const challenge = inbox.request({
      runId: "run-2",
      actor: "agent",
      action: "delete",
      resource: "file:important.txt",
      risk: "critical",
      reason: "cleanup",
      ttlMs: 20,
      nowMs: 100,
    });
    expect(() =>
      inbox.assertApproved(challenge.request.id, challenge.token, 121),
    ).toThrow(/approval token required/);
    expect(inbox.get(challenge.request.id, 121)?.status).toBe("expired");
  });
});
