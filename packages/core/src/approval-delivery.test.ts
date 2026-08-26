import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApprovalBoundMockDelivery } from "./approval-delivery.js";
import { DeliveryQueue } from "./delivery-queue.js";
import { ApprovalInbox } from "./security/approval-inbox.js";

describe("approval-bound mock delivery", () => {
  function createRuntime() {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "miki-approval-delivery-"),
    );
    const approvals = new ApprovalInbox(path.join(dir, "approvals.json"));
    const deliveries = new DeliveryQueue(path.join(dir, "deliveries.json"));
    return {
      dir,
      approvals,
      deliveries,
      runtime: new ApprovalBoundMockDelivery(approvals, deliveries),
    };
  }

  function input(
    overrides: Partial<Parameters<ApprovalBoundMockDelivery["create"]>[0]> = {},
  ) {
    return {
      runId: "run-1",
      stepId: "step-1",
      action: "publish" as const,
      risk: "high" as const,
      target: "site:synthetic",
      body: "synthetic mock content",
      channel: "webhook" as const,
      destination: "mock://delivery",
      idempotencyKey: "delivery-1",
      correlationId: "corr-1",
      ...overrides,
    };
  }

  it("keeps a new delivery waiting for approval and binds its preview", () => {
    const { runtime, deliveries, approvals } = createRuntime();
    const created = runtime.create(input());
    expect(created.preview.externalSideEffect).toBe(false);
    expect(created.preview.previewHash).toHaveLength(64);
    expect(created.receipt).toMatchObject({
      status: "waiting_approval",
      approvalRequired: true,
      approvalRequestId: created.approval.id,
      previewHash: created.preview.previewHash,
      replayAllowed: false,
    });
    expect(approvals.get(created.approval.id)).toMatchObject({
      runId: "run-1",
      context: {
        stepId: "step-1",
        deliveryId: created.receipt.id,
        previewHash: created.preview.previewHash,
      },
    });
    expect(deliveries.claim()).toBeNull();
  });

  it("requires the exact approved context and consumes approval once", () => {
    const { runtime } = createRuntime();
    const created = runtime.create(input());
    expect(() => runtime.approve("missing")).toThrow(/not found/i);
    const approved = runtime.approve(created.receipt.id, "operator");
    expect(approved.receipt.status).toBe("pending");
    expect(approved.approval.consumedBy).toBe("operator");
    expect(() => runtime.approve(created.receipt.id, "operator")).toThrow(
      /already approved|already been consumed/i,
    );
  });

  it("emits a sent normalized outcome without external side effects", async () => {
    const { runtime } = createRuntime();
    const created = runtime.create(input());
    runtime.approve(created.receipt.id);
    const sent = await runtime.dispatch(created.receipt.id, "sent");
    expect(sent.receipt.status).toBe("sent");
    expect(sent.outcome).toMatchObject({
      runId: "run-1",
      stepId: "step-1",
      deliveryId: created.receipt.id,
      status: "sent",
      correlationId: "corr-1",
      approval: { required: true, consumed: true },
    });
  });

  it("turns unknown provider outcome into reconciliation-required and blocks replay", async () => {
    const { runtime } = createRuntime();
    const created = runtime.create(
      input({ idempotencyKey: "delivery-unknown" }),
    );
    runtime.approve(created.receipt.id);
    const unknown = await runtime.dispatch(
      created.receipt.id,
      "unknown_outcome",
    );
    expect(unknown.receipt.status).toBe("unknown_outcome");
    expect(unknown.receipt.replayAllowed).toBe(false);
    expect(unknown.outcome.status).toBe("reconciliation_required");
    expect(() => runtime.replay(created.receipt.id, "delivery-replay")).toThrow(
      /reconciliation before replay/i,
    );
  });

  it("creates a new replay lineage for failed delivery without mutating the original receipt", async () => {
    const { runtime, deliveries } = createRuntime();
    const created = runtime.create(
      input({ idempotencyKey: "delivery-failed", maxAttempts: 1 }),
    );
    runtime.approve(created.receipt.id);
    const failed = await runtime.dispatch(created.receipt.id, "failed");
    expect(failed.receipt.status).toBe("dead_letter");
    const replay = runtime.replay(created.receipt.id, "delivery-failed-replay");
    expect(replay.receipt.id).not.toBe(created.receipt.id);
    expect(replay.receipt.replayOf).toBe(created.receipt.id);
    expect(replay.receipt.status).toBe("waiting_approval");
    expect(replay.receipt.replayAllowed).toBe(false);
    expect(replay.approval.id).not.toBe(created.approval.id);
    expect(replay.preview.previewHash).toHaveLength(64);
    expect(deliveries.get(created.receipt.id)).toMatchObject({
      status: "dead_letter",
      nextAction: "inspect failure before bounded retry",
    });
  });
});
