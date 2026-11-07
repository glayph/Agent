import { ApprovalStore } from "./approval-store.js";

describe("ApprovalStore", () => {
  it("resolves a pending tool request when approved", async () => {
    const store = new ApprovalStore();
    const pending = store.request({
      runId: "r1", callId: "c1", toolName: "file_write", risk: "config_write",
      reason: "test", input: { path: "a" },
    });
    const [record] = store.list({ status: "pending" });
    expect(record.action).toBe("file_write");
    expect(store.approve(record.id, "me")?.status).toBe("approved");
    await expect(pending).resolves.toMatchObject({ approved: true, approvalId: record.id });
  });

  it("registers the waiter before publishing a request to avoid synchronous decision races", async () => {
    const store = new ApprovalStore();
    const pending = store.request({
      runId: "r", callId: "c", toolName: "file_write", risk: "config_write", reason: "x", input: {},
    }, undefined, {
      onPending: (id) => { store.approve(id, "owner"); },
    });
    await expect(pending).resolves.toMatchObject({ approved: true, decidedBy: "owner" });
  });

  it("expires pending requests after the ttl and denies the waiting call", async () => {
    let now = 1_000;
    const store = new ApprovalStore({ ttlMs: 100, now: () => now });
    const pending = store.request({
      runId: "r", callId: "c", toolName: "t", risk: "install", reason: "x", input: {},
    });
    now += 200;
    expect(store.list()[0].status).toBe("expired");
    await expect(pending).resolves.toMatchObject({ approved: false });
  });

  it("expires a waiting tool request without requiring dashboard polling", async () => {
    const store = new ApprovalStore({ ttlMs: 20 });
    const pending = store.request({
      runId: "r", callId: "c", toolName: "file_delete", risk: "destructive", reason: "x", input: {},
    });
    await expect(pending).resolves.toMatchObject({ approved: false, reason: "The approval request expired." });
    expect(store.list()[0].status).toBe("expired");
  });

  it("does not let a decided request be decided again", () => {
    const store = new ApprovalStore();
    void store.request({ runId: "r", callId: "c", toolName: "t", risk: "install", reason: "x", input: {} });
    const id = store.list()[0].id;
    store.deny(id);
    expect(store.approve(id)?.status).toBe("denied");
    expect(store.approve("missing")).toBeUndefined();
  });

  it("redacts credential-like fields from the owner-visible approval preview", async () => {
    const store = new ApprovalStore();
    void store.request({
      runId: "r", callId: "c", toolName: "browser_type", risk: "config_write", reason: "type credentials",
      input: { username: "owner", password: "hunter2", api_key: "sk-abcdefghijklmnopqrstuvwxyz123456", note: "hello" },
    });
    const preview = store.list({ status: "pending" })[0].preview;
    expect(preview).toContain("owner");
    expect(preview).toContain("[REDACTED]");
    expect(preview).not.toContain("hunter2");
    expect(preview).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
  });

  it("binds control approvals to one operation and consumes them once", async () => {
    const store = new ApprovalStore();
    const base = {
      operationId: "op1", capability: "tool_state", action: "set", risk: "config_write" as const,
      reason: "r", sanitizedInput: { name: "web_search", enabled: true },
      context: { origin: "api" as const },
    };
    const { requestId } = await store.requestApproval(base);
    expect(store.isApproved({ ...base, approvalRequestId: requestId })).toBe(false);
    store.approve(requestId);
    expect(store.isApproved({ ...base, approvalRequestId: requestId })).toBe(true);
    // A different input must not reuse the approval.
    expect(
      store.isApproved({ ...base, sanitizedInput: { name: "web_search", enabled: false }, approvalRequestId: requestId }),
    ).toBe(false);
    expect(store.consumeApproval({ ...base, operationId: "op2", approvalRequestId: requestId }, requestId)).toBe(true);
    expect(store.consumeApproval({ ...base, approvalRequestId: requestId }, requestId)).toBe(false);
  });
});
