import * as fs from "node:fs";
import * as path from "node:path";
import type { ChannelName } from "./event-envelope.js";

export type DeliveryStatus =
  | "pending"
  | "waiting_approval"
  | "sending"
  | "sent"
  | "failed"
  | "unknown_outcome"
  | "dead_letter";

export interface DeliveryReceipt {
  id: string;
  runId?: string;
  eventId?: string;
  stepId?: string;
  correlationId?: string;
  channel: ChannelName;
  destination: string;
  body: string;
  idempotencyKey: string;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  providerMessageId?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: number;
  approvalRequired?: boolean;
  approvalRequestId?: string;
  approvalAction?: string;
  approvalRisk?: string;
  approvalTarget?: string;
  previewHash?: string;
  replayOf?: string;
  errorClass?: string;
  nextAction?: string;
  replayAllowed?: boolean;
}

export interface DeliveryAttemptResult {
  status: "sent" | "failed" | "unknown_outcome";
  providerMessageId?: string;
  error?: string;
  errorClass?: string;
  nextAction?: string;
}

export interface DeliverySignal {
  readonly aborted: boolean;
}

export type DeliverySender = (
  receipt: DeliveryReceipt,
  signal: DeliverySignal,
) => Promise<DeliveryAttemptResult>;

interface DeliveryFile {
  version: 1;
  receipts: DeliveryReceipt[];
}

export class DeliveryQueue {
  private receipts = new Map<string, DeliveryReceipt>();

  constructor(private readonly filePath: string) {
    this.load();
  }

  enqueue(
    input: Omit<
      DeliveryReceipt,
      "id" | "status" | "attempts" | "createdAt" | "updatedAt" | "nextAttemptAt"
    > &
      Partial<Pick<DeliveryReceipt, "maxAttempts">>,
  ): DeliveryReceipt {
    const existing = [...this.receipts.values()].find(
      (receipt) =>
        receipt.idempotencyKey === input.idempotencyKey &&
        receipt.status !== "dead_letter",
    );
    if (existing) return { ...existing };
    const now = new Date().toISOString();
    const receipt: DeliveryReceipt = {
      ...input,
      id: crypto.randomUUID(),
      status: input.approvalRequired ? "waiting_approval" : "pending",
      attempts: 0,
      maxAttempts: Math.max(1, input.maxAttempts ?? 3),
      createdAt: now,
      updatedAt: now,
      nextAttemptAt: Date.now(),
    };
    this.receipts.set(receipt.id, receipt);
    this.save();
    return { ...receipt };
  }

  get(receiptId: string): DeliveryReceipt | null {
    const receipt = this.receipts.get(receiptId);
    return receipt ? { ...receipt } : null;
  }

  bindApproval(
    receiptId: string,
    binding: { approvalRequestId: string },
  ): DeliveryReceipt | null {
    const receipt = this.receipts.get(receiptId);
    if (!receipt || receipt.status !== "waiting_approval") return null;
    receipt.approvalRequestId = binding.approvalRequestId;
    receipt.updatedAt = new Date().toISOString();
    this.save();
    return { ...receipt };
  }

  authorize(receiptId: string): DeliveryReceipt | null {
    const receipt = this.receipts.get(receiptId);
    if (
      !receipt ||
      receipt.status !== "waiting_approval" ||
      !receipt.approvalRequestId
    )
      return null;
    receipt.status = "pending";
    receipt.nextAttemptAt = Date.now();
    receipt.replayAllowed = true;
    receipt.nextAction = "send delivery";
    receipt.updatedAt = new Date().toISOString();
    this.save();
    return { ...receipt };
  }

  list(status?: DeliveryStatus): DeliveryReceipt[] {
    return [...this.receipts.values()]
      .filter((receipt) => !status || receipt.status === status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((receipt) => ({ ...receipt }));
  }

  claim(now = Date.now()): DeliveryReceipt | null {
    const receipt = [...this.receipts.values()]
      .filter(
        (item) =>
          (item.status === "pending" || item.status === "sending") &&
          item.nextAttemptAt <= now,
      )
      .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt)[0];
    if (!receipt) return null;
    receipt.status = "sending";
    receipt.attempts += 1;
    receipt.updatedAt = new Date().toISOString();
    this.save();
    return { ...receipt };
  }

  claimById(receiptId: string, now = Date.now()): DeliveryReceipt | null {
    const receipt = this.receipts.get(receiptId);
    if (
      !receipt ||
      !["pending", "sending"].includes(receipt.status) ||
      receipt.nextAttemptAt > now
    ) {
      return null;
    }
    receipt.status = "sending";
    receipt.attempts += 1;
    receipt.updatedAt = new Date().toISOString();
    this.save();
    return { ...receipt };
  }

  settle(
    receiptId: string,
    result: DeliveryAttemptResult,
    retryDelayMs = 60_000,
  ): DeliveryReceipt | null {
    const receipt = this.receipts.get(receiptId);
    if (!receipt) return null;
    receipt.providerMessageId =
      result.providerMessageId ?? receipt.providerMessageId;
    receipt.lastError = result.error;
    receipt.errorClass = result.errorClass;
    receipt.nextAction = result.nextAction;
    if (result.status === "sent") {
      receipt.status = "sent";
      receipt.replayAllowed = false;
    } else if (result.status === "unknown_outcome") {
      receipt.status = "unknown_outcome";
      receipt.replayAllowed = false;
      receipt.nextAction =
        result.nextAction ?? "reconcile provider outcome before replay";
    } else if (receipt.attempts >= receipt.maxAttempts) {
      receipt.status = "dead_letter";
      receipt.replayAllowed = true;
      receipt.nextAction =
        result.nextAction ?? "inspect error and repair before replay";
    } else {
      receipt.status = "pending";
      receipt.nextAttemptAt = Date.now() + Math.max(0, retryDelayMs);
      receipt.replayAllowed = true;
      receipt.nextAction = "retry delivery";
    }
    receipt.updatedAt = new Date().toISOString();
    this.save();
    return { ...receipt };
  }

  markUnknown(receiptId: string, reason: string): DeliveryReceipt | null {
    return this.settle(receiptId, {
      status: "unknown_outcome",
      error: reason,
    });
  }

  replay(receiptId: string, idempotencyKey: string): DeliveryReceipt | null {
    const receipt = this.receipts.get(receiptId);
    if (!receipt || !["failed", "dead_letter"].includes(receipt.status)) {
      return null;
    }
    const replay = this.enqueue({
      runId: receipt.runId,
      eventId: receipt.eventId,
      stepId: receipt.stepId,
      correlationId: receipt.correlationId,
      channel: receipt.channel,
      destination: receipt.destination,
      body: receipt.body,
      idempotencyKey,
      maxAttempts: receipt.maxAttempts,
      approvalRequired: receipt.approvalRequired,
      approvalAction: receipt.approvalAction,
      approvalRisk: receipt.approvalRisk,
      approvalTarget: receipt.approvalTarget,
      previewHash: receipt.previewHash,
    });
    replay.replayOf = receipt.id;
    replay.replayAllowed = Boolean(!replay.approvalRequired);
    replay.nextAction = replay.approvalRequired
      ? "obtain fresh approval before replay"
      : "send replay";
    this.receipts.set(replay.id, replay);
    this.save();
    return { ...replay };
  }

  stats(): Record<DeliveryStatus, number> {
    const stats: Record<DeliveryStatus, number> = {
      pending: 0,
      waiting_approval: 0,
      sending: 0,
      sent: 0,
      failed: 0,
      unknown_outcome: 0,
      dead_letter: 0,
    };
    for (const item of this.receipts.values()) stats[item.status] += 1;
    return stats;
  }

  async dispatch(
    sender: DeliverySender,
    signal: DeliverySignal = new AbortController().signal,
  ): Promise<DeliveryReceipt | null> {
    const receipt = this.claim();
    if (!receipt) return null;
    try {
      const result = await sender(receipt, signal);
      return this.settle(receipt.id, result);
    } catch (error: unknown) {
      return this.settle(receipt.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private load(): void {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf-8"),
      ) as DeliveryFile;
      this.receipts = new Map(
        (Array.isArray(parsed.receipts) ? parsed.receipts : [])
          .filter((item): item is DeliveryReceipt =>
            Boolean(item && typeof item.id === "string"),
          )
          .map((item) => [item.id, item]),
      );
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(
      temp,
      `${JSON.stringify({ version: 1, receipts: [...this.receipts.values()] }, null, 2)}\n`,
      "utf-8",
    );
    fs.renameSync(temp, this.filePath);
  }
}
