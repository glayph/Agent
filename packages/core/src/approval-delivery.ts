import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  ApprovalInbox,
  type ApprovalAction,
  type ApprovalConsumeContext,
  type ApprovalRequest,
  type ApprovalRisk,
} from "./security/approval-inbox.js";
import {
  DeliveryQueue,
  type DeliveryAttemptResult,
  type DeliveryReceipt,
} from "./delivery-queue.js";
import type { ChannelName } from "./event-envelope.js";

export type NormalizedExecutionStatus =
  | "created"
  | "waiting_approval"
  | "approved"
  | "sending"
  | "sent"
  | "failed"
  | "unknown_outcome"
  | "dead_letter"
  | "reconciliation_required";

export interface NormalizedRunOutcome {
  runId: string;
  stepId?: string;
  deliveryId?: string;
  status: NormalizedExecutionStatus;
  provider?: string;
  model?: string;
  artifactRefs: string[];
  verification?: Record<string, unknown>;
  approval?: {
    required: boolean;
    requestId?: string;
    action?: string;
    risk?: string;
    previewHash?: string;
    consumed?: boolean;
  };
  warnings: string[];
  nextAction?: string;
  correlationId: string;
}

export interface DeliveryOutcomeEvent {
  type: "delivery.outcome";
  payload: NormalizedRunOutcome;
}

const deliveryOutcomeEmitter = new EventEmitter();

export function subscribeDeliveryOutcome(
  listener: (event: DeliveryOutcomeEvent) => void,
): () => void {
  deliveryOutcomeEmitter.on("outcome", listener);
  return () => deliveryOutcomeEmitter.off("outcome", listener);
}

export function publishDeliveryOutcome(event: DeliveryOutcomeEvent): void {
  deliveryOutcomeEmitter.emit("outcome", event);
}

export function toDeliveryOutcomeEvent(
  outcome: NormalizedRunOutcome,
): DeliveryOutcomeEvent {
  return { type: "delivery.outcome", payload: outcome };
}

export interface MockDeliveryInput {
  runId: string;
  stepId: string;
  action: ApprovalAction;
  risk: ApprovalRisk;
  target: string;
  body: string;
  channel: ChannelName;
  destination: string;
  idempotencyKey: string;
  correlationId: string;
  maxAttempts?: number;
}

export interface DeliveryPreview {
  runId: string;
  stepId: string;
  action: ApprovalAction;
  risk: ApprovalRisk;
  target: string;
  bodyPreview: string;
  previewHash: string;
  approvalRequired: true;
  externalSideEffect: false;
}

export type MockDeliveryOutcome = "sent" | "failed" | "unknown_outcome";

export class ApprovalBoundMockDelivery {
  constructor(
    private readonly approvals: ApprovalInbox,
    private readonly deliveries: DeliveryQueue,
  ) {}

  create(input: MockDeliveryInput): {
    preview: DeliveryPreview;
    receipt: DeliveryReceipt;
    approval: ApprovalRequest;
  } {
    const preview = buildPreview(input);
    const receipt = this.deliveries.enqueue({
      runId: input.runId,
      stepId: input.stepId,
      correlationId: input.correlationId,
      channel: input.channel,
      destination: input.destination,
      body: input.body,
      idempotencyKey: input.idempotencyKey,
      maxAttempts: input.maxAttempts,
      approvalRequired: true,
      approvalAction: input.action,
      approvalRisk: input.risk,
      approvalTarget: input.target,
      previewHash: preview.previewHash,
      replayAllowed: false,
      nextAction: "await human approval",
    });
    const challenge = this.approvals.request({
      runId: input.runId,
      actor: "agent",
      action: input.action,
      resource: input.target,
      risk: input.risk,
      reason: `Approve mock delivery action: ${input.action}`,
      context: {
        runId: input.runId,
        stepId: input.stepId,
        deliveryId: receipt.id,
        previewHash: preview.previewHash,
      },
    });
    const bound = this.deliveries.bindApproval(receipt.id, {
      approvalRequestId: challenge.request.id,
    });
    if (!bound) throw new Error("Unable to bind approval to delivery");
    return { preview, receipt: bound, approval: challenge.request };
  }

  approve(
    receiptId: string,
    decidedBy = "mock-operator",
  ): { receipt: DeliveryReceipt; approval: ApprovalRequest } {
    const receipt = this.requireReceipt(receiptId);
    if (!receipt.approvalRequestId || !receipt.previewHash || !receipt.runId) {
      throw new Error("Approval-bound delivery metadata is incomplete");
    }
    const request = this.approvals.approveByOperator(
      receipt.approvalRequestId,
      decidedBy,
      "approved for mock delivery",
    );
    const context: ApprovalConsumeContext = {
      runId: receipt.runId,
      stepId: receipt.stepId ?? "",
      deliveryId: receipt.id,
      previewHash: receipt.previewHash,
    };
    const consumed = this.approvals.consumeByContext(
      request.id,
      context,
      decidedBy,
    );
    const authorized = this.deliveries.authorize(receipt.id);
    if (!authorized) throw new Error("Delivery is not waiting for approval");
    return {
      receipt: authorized,
      approval: consumed,
    };
  }

  async dispatch(
    receiptId: string,
    outcome: MockDeliveryOutcome,
  ): Promise<{
    receipt: DeliveryReceipt;
    outcome: NormalizedRunOutcome;
    event: DeliveryOutcomeEvent;
  }> {
    const claimed = this.deliveries.claimById(receiptId);
    if (!claimed) throw new Error("Delivery is not ready to send");
    const result: DeliveryAttemptResult =
      outcome === "sent"
        ? {
            status: "sent",
            providerMessageId: `mock-${claimed.id}`,
            nextAction: "delivery complete",
          }
        : outcome === "unknown_outcome"
          ? {
              status: "unknown_outcome",
              error: "Mock provider outcome is intentionally unknown",
              errorClass: "unknown_side_effect",
              nextAction: "reconcile provider outcome before replay",
            }
          : {
              status: "failed",
              error: "Mock provider rejected delivery",
              errorClass: "deterministic_delivery_failure",
              nextAction: "inspect failure before bounded retry",
            };
    const settled = this.deliveries.settle(claimed.id, result);
    if (!settled) throw new Error("Unable to settle delivery");
    const status: NormalizedExecutionStatus =
      settled.status === "unknown_outcome"
        ? "reconciliation_required"
        : settled.status === "pending"
          ? "failed"
          : settled.status;
    const normalizedOutcome: NormalizedRunOutcome = {
      runId: settled.runId ?? "unknown",
      stepId: settled.stepId,
      deliveryId: settled.id,
      status,
      artifactRefs: [],
      approval: {
        required: Boolean(settled.approvalRequired),
        requestId: settled.approvalRequestId,
        previewHash: settled.previewHash,
        consumed: true,
      },
      warnings: status === "reconciliation_required" ? [result.error!] : [],
      nextAction: settled.nextAction,
      correlationId: settled.correlationId ?? settled.id,
    };
    return {
      receipt: settled,
      outcome: normalizedOutcome,
      event: toDeliveryOutcomeEvent(normalizedOutcome),
    };
  }

  replay(
    receiptId: string,
    idempotencyKey: string,
  ): {
    receipt: DeliveryReceipt;
    preview: DeliveryPreview;
    approval: ApprovalRequest;
  } {
    const original = this.requireReceipt(receiptId);
    if (original.status === "unknown_outcome") {
      throw new Error("Delivery requires reconciliation before replay");
    }
    const replay = this.deliveries.replay(receiptId, idempotencyKey);
    if (!replay) throw new Error("Delivery is not eligible for replay");
    const action = original.approvalAction as ApprovalAction | undefined;
    const risk = original.approvalRisk as ApprovalRisk | undefined;
    const target = original.approvalTarget;
    if (!action || !risk || !target || !replay.runId || !replay.stepId) {
      throw new Error("Approval-bound replay metadata is incomplete");
    }
    const preview = buildPreview({
      runId: replay.runId,
      stepId: replay.stepId,
      action,
      risk,
      target,
      body: replay.body,
      channel: replay.channel,
      destination: replay.destination,
      idempotencyKey: replay.idempotencyKey,
      correlationId: replay.correlationId ?? replay.id,
      maxAttempts: replay.maxAttempts,
    });
    const challenge = this.approvals.request({
      runId: replay.runId,
      actor: "agent",
      action,
      resource: target,
      risk,
      reason: `Approve replay of mock delivery: ${original.id}`,
      context: {
        runId: replay.runId,
        stepId: replay.stepId,
        deliveryId: replay.id,
        previewHash: preview.previewHash,
      },
    });
    const bound = this.deliveries.bindApproval(replay.id, {
      approvalRequestId: challenge.request.id,
    });
    if (!bound) throw new Error("Unable to bind replay approval");
    return { receipt: bound, preview, approval: challenge.request };
  }

  private requireReceipt(receiptId: string): DeliveryReceipt {
    const receipt = this.deliveries.get(receiptId);
    if (!receipt) throw new Error("Delivery receipt not found");
    return receipt;
  }
}

function buildPreview(input: MockDeliveryInput): DeliveryPreview {
  const canonical = JSON.stringify({
    runId: input.runId,
    stepId: input.stepId,
    action: input.action,
    risk: input.risk,
    target: input.target,
    body: input.body,
    channel: input.channel,
    destination: input.destination,
  });
  return {
    runId: input.runId,
    stepId: input.stepId,
    action: input.action,
    risk: input.risk,
    target: input.target,
    bodyPreview: redactBody(input.body),
    previewHash: createHash("sha256").update(canonical).digest("hex"),
    approvalRequired: true,
    externalSideEffect: false,
  };
}

function redactBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= 240) return trimmed;
  return `${trimmed.slice(0, 237)}...`;
}
