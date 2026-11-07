import { randomUUID } from "node:crypto";
import type {
  ControlApprovalAdapter,
  ControlApprovalRequest,
} from "../control/types.js";
import type {
  ApprovalDecision,
  ApprovalGate,
  ToolApprovalRequest,
} from "./types.js";
import { redactSecrets, stableStringify, truncate } from "./util.js";

export type ApprovalStatus =
  "pending" | "approved" | "denied" | "expired" | "consumed";

/** Shape returned to the dashboard (matches the frontend ApprovalRequest type). */
export interface ApprovalRecord {
  id: string;
  kind: "tool" | "control";
  runId: string;
  actor: string;
  action: string;
  resource: string;
  risk: string;
  reason: string;
  preview: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

interface InternalRecord extends ApprovalRecord {
  /** Canonical input, only used to bind a control approval to one operation. */
  inputKey: string;
}

export interface ApprovalStoreOptions {
  ttlMs?: number;
  maxRecords?: number;
  now?: () => number;
}


function redactApprovalInput(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (typeof value === "string") return redactSecrets(value).slice(0, 2_000);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactApprovalInput(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    if (/(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key)/i.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactApprovalInput(item, depth + 1);
    }
  }
  return output;
}

/**
 * In-memory approval queue shared by the agent engine (tool calls) and the
 * control service (typed system operations). A request stays pending until a
 * person approves or denies it, or until it expires.
 */
export class ApprovalStore implements ApprovalGate, ControlApprovalAdapter {
  private readonly records = new Map<string, InternalRecord>();
  private readonly waiters = new Map<string, (d: ApprovalDecision) => void>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ttlMs: number;
  private readonly maxRecords: number;
  private readonly now: () => number;

  constructor(options: ApprovalStoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maxRecords = options.maxRecords ?? 500;
    this.now = options.now ?? Date.now;
  }

  // -- dashboard-facing API -------------------------------------------------

  list(filter: { status?: ApprovalStatus } = {}): ApprovalRecord[] {
    this.sweep();
    return [...this.records.values()]
      .filter((record) => !filter.status || record.status === filter.status)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((record) => this.publicRecord(record));
  }

  get(id: string): ApprovalRecord | undefined {
    this.sweep();
    const record = this.records.get(id);
    return record ? this.publicRecord(record) : undefined;
  }

  pendingCount(): number {
    return this.list({ status: "pending" }).length;
  }

  /** Returns undefined when the id is unknown, otherwise the (possibly unchanged) record. */
  approve(id: string, decidedBy = "dashboard-operator"): ApprovalRecord | undefined {
    return this.decide(id, true, decidedBy);
  }

  deny(
    id: string,
    decidedBy = "dashboard-operator",
    reason?: string,
  ): ApprovalRecord | undefined {
    return this.decide(id, false, decidedBy, reason);
  }

  // -- engine-facing gate ---------------------------------------------------

  request(
    request: ToolApprovalRequest,
    signal?: AbortSignal,
    hooks?: { onPending?: (approvalId: string, expiresAt: string) => void },
  ): Promise<ApprovalDecision> {
    const record = this.create({
      kind: "tool",
      runId: request.runId,
      actor: "agent",
      action: request.toolName,
      resource: request.toolName,
      risk: request.risk,
      reason: request.reason,
      preview: truncate(stableStringify(redactApprovalInput(request.input)), 600),
      inputKey: stableStringify(request.input),
    });
    return new Promise<ApprovalDecision>((resolve) => {
      const finish = (decision: ApprovalDecision) => {
        signal?.removeEventListener("abort", onAbort);
        this.waiters.delete(record.id);
        this.clearExpiryTimer(record.id);
        resolve({ ...decision, approvalId: record.id });
      };
      const onAbort = () => {
        if (record.status === "pending") {
          record.status = "denied";
          record.decidedBy = "system";
          record.decidedAt = new Date(this.now()).toISOString();
        }
        finish({ approved: false, reason: "The run was cancelled." });
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      // Register the waiter before publishing the request so a synchronous
      // owner decision from an onPending hook cannot race the waiter setup.
      this.waiters.set(record.id, finish);
      const expiresInMs = Math.max(0, Date.parse(record.expiresAt) - this.now());
      const expiryTimer = setTimeout(() => this.expireToolRequest(record.id), expiresInMs);
      this.expiryTimers.set(record.id, expiryTimer);
      try {
        hooks?.onPending?.(record.id, record.expiresAt);
      } catch {
        record.status = "denied";
        record.decidedBy = "system";
        record.decidedAt = new Date(this.now()).toISOString();
        finish({ approved: false, reason: "The approval request could not be published." });
      }
    });
  }

  // -- control service adapter ---------------------------------------------

  async requestApproval(
    request: ControlApprovalRequest,
  ): Promise<{ requestId: string }> {
    const record = this.create({
      kind: "control",
      runId: request.operationId,
      actor: request.context.actor || request.context.origin,
      action: `${request.capability}.${request.action}`,
      resource: request.capability,
      risk: request.risk,
      reason: request.reason,
      preview: truncate(stableStringify(redactApprovalInput(request.sanitizedInput)), 600),
      inputKey: this.controlKey(
        request.capability,
        request.action,
        request.sanitizedInput,
      ),
    });
    return { requestId: record.id };
  }

  isApproved(request: ControlApprovalRequest): boolean {
    const record = this.matchingControlRecord(request);
    return Boolean(record && record.status === "approved");
  }

  consumeApproval(request: ControlApprovalRequest, requestId: string): boolean {
    this.sweep();
    const record = this.records.get(requestId);
    if (!record || record.kind !== "control" || record.status !== "approved")
      return false;
    if (
      record.inputKey !==
      this.controlKey(request.capability, request.action, request.sanitizedInput)
    )
      return false;
    record.status = "consumed";
    return true;
  }

  // -- internals ------------------------------------------------------------

  private matchingControlRecord(
    request: ControlApprovalRequest,
  ): InternalRecord | undefined {
    this.sweep();
    if (!request.approvalRequestId) return undefined;
    const record = this.records.get(request.approvalRequestId);
    if (!record || record.kind !== "control") return undefined;
    const key = this.controlKey(
      request.capability,
      request.action,
      request.sanitizedInput,
    );
    return record.inputKey === key ? record : undefined;
  }

  private controlKey(
    capability: string,
    action: string,
    input: Record<string, unknown>,
  ): string {
    return stableStringify({ capability, action, input });
  }

  private create(
    fields: Omit<
      InternalRecord,
      "id" | "status" | "createdAt" | "expiresAt"
    >,
  ): InternalRecord {
    this.sweep();
    const created = this.now();
    const record: InternalRecord = {
      ...fields,
      reason: redactSecrets(fields.reason).slice(0, 500),
      id: `apr_${randomUUID()}`,
      status: "pending",
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + this.ttlMs).toISOString(),
    };
    this.records.set(record.id, record);
    return record;
  }

  private decide(
    id: string,
    approved: boolean,
    decidedBy: string,
    reason?: string,
  ): ApprovalRecord | undefined {
    this.sweep();
    const record = this.records.get(id);
    if (!record) return undefined;
    if (record.status !== "pending") return this.publicRecord(record);
    record.status = approved ? "approved" : "denied";
    record.decidedBy = decidedBy;
    record.decidedAt = new Date(this.now()).toISOString();
    // Tool approvals are one-shot: once the waiting call resumes, nothing else uses them.
    this.waiters.get(id)?.({
      approved,
      decidedBy,
      reason: approved ? undefined : reason || "Denied by the operator.",
    });
    return this.publicRecord(record);
  }

  private clearExpiryTimer(id: string): void {
    const timer = this.expiryTimers.get(id);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(id);
  }

  /** Expire a waiting tool call even when the dashboard does not poll the queue. */
  private expireToolRequest(id: string): void {
    this.expiryTimers.delete(id);
    const record = this.records.get(id);
    if (!record || record.kind !== "tool" || record.status !== "pending") return;
    const now = this.now();
    if (Date.parse(record.expiresAt) > now) {
      const timer = setTimeout(() => this.expireToolRequest(id), Date.parse(record.expiresAt) - now);
      this.expiryTimers.set(id, timer);
      return;
    }
    record.status = "expired";
    record.decidedBy = "system";
    record.decidedAt = new Date(now).toISOString();
    this.waiters.get(id)?.({ approved: false, reason: "The approval request expired." });
  }

  /** Expire stale pending requests and cap the history that is kept in memory. */
  private sweep(): void {
    const now = this.now();
    for (const record of this.records.values()) {
      if (record.status === "pending" && Date.parse(record.expiresAt) <= now) {
        record.status = "expired";
        record.decidedBy = "system";
        record.decidedAt = new Date(now).toISOString();
        this.clearExpiryTimer(record.id);
        this.waiters.get(record.id)?.({
          approved: false,
          reason: "The approval request expired.",
        });
      }
    }
    if (this.records.size > this.maxRecords) {
      const settled = [...this.records.values()]
        .filter((record) => record.status !== "pending")
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
      for (const record of settled) {
        if (this.records.size <= this.maxRecords) break;
        this.records.delete(record.id);
      }
    }
  }

  private publicRecord(record: InternalRecord): ApprovalRecord {
    const { inputKey: _inputKey, ...visible } = record;
    return { ...visible };
  }
}
