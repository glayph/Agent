import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export type ApprovalAction =
  | "login"
  | "mfa_takeover"
  | "payment"
  | "publish"
  | "delete"
  | "external_write"
  | "browser_navigation";

export type ApprovalRisk = "low" | "medium" | "high" | "critical";
export type ApprovalStatus =
  "pending" | "approved" | "denied" | "expired" | "revoked";

export interface ApprovalConsumeContext {
  runId: string;
  stepId: string;
  deliveryId: string;
  previewHash: string;
}

export interface ApprovalRequestInput {
  runId: string;
  actor: string;
  action: ApprovalAction;
  resource: string;
  risk: ApprovalRisk;
  reason: string;
  context?: Record<string, unknown>;
  ttlMs?: number;
  nowMs?: number;
}

export interface ApprovalRequest {
  id: string;
  runId: string;
  actor: string;
  action: ApprovalAction;
  resource: string;
  risk: ApprovalRisk;
  reason: string;
  context: Record<string, unknown>;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  decidedBy?: string;
  decisionReason?: string;
  consumedAt?: string;
  consumedBy?: string;
}

export interface ApprovalChallenge {
  request: ApprovalRequest;
  /** The raw token is returned once and is never persisted. */
  token: string;
}

export interface ApprovalAuditEvent {
  type:
    | "approval.requested"
    | "approval.approved"
    | "approval.consumed"
    | "approval.denied"
    | "approval.expired"
    | "approval.revoked";
  actor: string;
  subject: string;
  runId: string;
  details: Record<string, unknown>;
}

export interface ApprovalAuditSink {
  record(event: ApprovalAuditEvent): unknown;
}

interface StoredApproval extends ApprovalRequest {
  tokenHash: string;
}

interface ApprovalFile {
  version: 1;
  requests: StoredApproval[];
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_BYTES = 32;

const SIDE_EFFECT_ACTIONS = new Set<ApprovalAction>([
  "login",
  "mfa_takeover",
  "payment",
  "publish",
  "delete",
  "external_write",
]);

export function requiresHumanApproval(action: ApprovalAction): boolean {
  return SIDE_EFFECT_ACTIONS.has(action);
}

export class ApprovalInbox {
  private readonly filePath: string;
  private readonly audit?: ApprovalAuditSink;
  private requests = new Map<string, StoredApproval>();

  constructor(filePath: string, options: { audit?: ApprovalAuditSink } = {}) {
    this.filePath = path.resolve(filePath);
    this.audit = options.audit;
    this.load();
  }

  request(input: ApprovalRequestInput): ApprovalChallenge {
    const nowMs = input.nowMs ?? Date.now();
    const runId = requiredText(input.runId, "runId");
    const actor = requiredText(input.actor, "actor");
    const resource = requiredText(input.resource, "resource");
    const reason = requiredText(input.reason, "reason");
    const ttlMs = boundedTtl(input.ttlMs);
    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const createdAt = new Date(nowMs).toISOString();
    const expiresAt = new Date(nowMs + ttlMs).toISOString();
    const record: StoredApproval = {
      id: crypto.randomUUID(),
      runId,
      actor,
      action: input.action,
      resource,
      risk: input.risk,
      reason,
      context: safeContext(input.context),
      status: "pending",
      createdAt,
      expiresAt,
      tokenHash: hashToken(token),
    };
    this.requests.set(record.id, record);
    this.save();
    this.emit({
      type: "approval.requested",
      actor,
      subject: record.id,
      runId,
      details: publicDetails(record),
    });
    return { request: publicRequest(record), token };
  }

  approve(
    requestId: string,
    token: string,
    decidedBy: string,
    decisionReason = "approved by operator",
    nowMs = Date.now(),
  ): ApprovalRequest {
    return this.decide(
      requestId,
      token,
      decidedBy,
      "approved",
      decisionReason,
      nowMs,
    );
  }

  deny(
    requestId: string,
    token: string,
    decidedBy: string,
    decisionReason = "denied by operator",
    nowMs = Date.now(),
  ): ApprovalRequest {
    return this.decide(
      requestId,
      token,
      decidedBy,
      "denied",
      decisionReason,
      nowMs,
    );
  }

  approveByOperator(
    requestId: string,
    decidedBy: string,
    decisionReason = "approved by authenticated operator",
    nowMs = Date.now(),
  ): ApprovalRequest {
    return this.decideByOperator(
      requestId,
      decidedBy,
      "approved",
      decisionReason,
      nowMs,
    );
  }

  denyByOperator(
    requestId: string,
    decidedBy: string,
    decisionReason = "denied by authenticated operator",
    nowMs = Date.now(),
  ): ApprovalRequest {
    return this.decideByOperator(
      requestId,
      decidedBy,
      "denied",
      decisionReason,
      nowMs,
    );
  }

  revoke(
    requestId: string,
    revokedBy: string,
    reason = "revoked by operator",
    nowMs = Date.now(),
  ): ApprovalRequest {
    const record = this.requests.get(requiredText(requestId, "requestId"));
    if (!record) throw new Error("Approval request not found");
    if (record.status !== "pending") {
      throw new Error(`Approval request is already ${record.status}`);
    }
    record.status = "revoked";
    record.decidedAt = new Date(nowMs).toISOString();
    record.decidedBy = requiredText(revokedBy, "revokedBy");
    record.decisionReason = requiredText(reason, "reason");
    this.save();
    this.emit({
      type: "approval.revoked",
      actor: record.decidedBy,
      subject: record.id,
      runId: record.runId,
      details: publicDetails(record),
    });
    return publicRequest(record);
  }

  get(requestId: string, nowMs = Date.now()): ApprovalRequest | null {
    const record = this.requests.get(requestId);
    if (!record) return null;
    this.expireIfNeeded(record, nowMs);
    return publicRequest(record);
  }

  list(
    options: { status?: ApprovalStatus; runId?: string; nowMs?: number } = {},
  ): ApprovalRequest[] {
    const nowMs = options.nowMs ?? Date.now();
    return [...this.requests.values()]
      .map((record) => {
        this.expireIfNeeded(record, nowMs);
        return record;
      })
      .filter(
        (record) =>
          (!options.status || record.status === options.status) &&
          (!options.runId || record.runId === options.runId),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(publicRequest);
  }

  isApproved(requestId: string, token: string, nowMs = Date.now()): boolean {
    const record = this.requests.get(requestId);
    if (!record) return false;
    this.expireIfNeeded(record, nowMs);
    return (
      record.status === "approved" &&
      !record.consumedAt &&
      safeTokenMatch(record.tokenHash, token)
    );
  }

  consumeByContext(
    requestId: string,
    context: ApprovalConsumeContext,
    consumedBy = "delivery-runtime",
    nowMs = Date.now(),
  ): ApprovalRequest {
    const record = this.requests.get(requiredText(requestId, "requestId"));
    if (!record) throw new Error("Approval request not found");
    this.expireIfNeeded(record, nowMs);
    if (record.status !== "approved") {
      throw new Error("Approved request required before side effect");
    }
    if (record.consumedAt) {
      throw new Error("Approval request has already been consumed");
    }
    assertContextMatches(record, context);
    record.consumedAt = new Date(nowMs).toISOString();
    record.consumedBy = requiredText(consumedBy, "consumedBy");
    this.save();
    this.emit({
      type: "approval.consumed",
      actor: record.consumedBy,
      subject: record.id,
      runId: record.runId,
      details: publicDetails(record),
    });
    return publicRequest(record);
  }

  assertApproved(
    requestId: string,
    token: string,
    nowMs = Date.now(),
  ): ApprovalRequest {
    const record = this.requests.get(requestId);
    if (!record) throw new Error("Approval request not found");
    this.expireIfNeeded(record, nowMs);
    if (
      record.status !== "approved" ||
      Boolean(record.consumedAt) ||
      !safeTokenMatch(record.tokenHash, token)
    ) {
      throw new Error("Valid approval token required before side effect");
    }
    return publicRequest(record);
  }

  /**
   * Assert an operator-approved request using its immutable delivery context.
   * This is intentionally tokenless: the request id is not sufficient by
   * itself; the caller must reproduce the bound context and actor before the
   * one-time consume operation can proceed.
   */
  assertApprovedByContext(
    requestId: string,
    context: ApprovalConsumeContext,
    actor?: string,
    nowMs = Date.now(),
  ): ApprovalRequest {
    const record = this.requests.get(requiredText(requestId, "requestId"));
    if (!record) throw new Error("Approval request not found");
    this.expireIfNeeded(record, nowMs);
    if (record.status !== "approved") {
      throw new Error("Approved request required before side effect");
    }
    if (record.consumedAt) {
      throw new Error("Approval request has already been consumed");
    }
    if (actor && record.actor !== requiredText(actor, "actor")) {
      throw new Error("Approval actor does not match caller");
    }
    assertContextMatches(record, context);
    return publicRequest(record);
  }

  close(): void {
    this.requests.clear();
  }

  private decide(
    requestId: string,
    token: string,
    decidedBy: string,
    status: "approved" | "denied",
    decisionReason: string,
    nowMs: number,
  ): ApprovalRequest {
    const record = this.requests.get(requiredText(requestId, "requestId"));
    if (!record) throw new Error("Approval request not found");
    this.expireIfNeeded(record, nowMs);
    if (record.status !== "pending") {
      throw new Error(`Approval request is already ${record.status}`);
    }
    if (!safeTokenMatch(record.tokenHash, token)) {
      throw new Error("Invalid approval token");
    }
    record.status = status;
    record.decidedAt = new Date(nowMs).toISOString();
    record.decidedBy = requiredText(decidedBy, "decidedBy");
    record.decisionReason = requiredText(decisionReason, "decisionReason");
    this.save();
    this.emit({
      type: `approval.${status}`,
      actor: record.decidedBy,
      subject: record.id,
      runId: record.runId,
      details: publicDetails(record),
    });
    return publicRequest(record);
  }

  private decideByOperator(
    requestId: string,
    decidedBy: string,
    status: "approved" | "denied",
    decisionReason: string,
    nowMs: number,
  ): ApprovalRequest {
    const record = this.requests.get(requiredText(requestId, "requestId"));
    if (!record) throw new Error("Approval request not found");
    this.expireIfNeeded(record, nowMs);
    if (record.status !== "pending") {
      throw new Error(`Approval request is already ${record.status}`);
    }
    record.status = status;
    record.decidedAt = new Date(nowMs).toISOString();
    record.decidedBy = requiredText(decidedBy, "decidedBy");
    record.decisionReason = requiredText(decisionReason, "decisionReason");
    this.save();
    this.emit({
      type: `approval.${status}`,
      actor: record.decidedBy,
      subject: record.id,
      runId: record.runId,
      details: publicDetails(record),
    });
    return publicRequest(record);
  }

  private expireIfNeeded(record: StoredApproval, nowMs: number): void {
    if (record.status !== "pending" || Date.parse(record.expiresAt) > nowMs)
      return;
    record.status = "expired";
    record.decidedAt = new Date(nowMs).toISOString();
    record.decidedBy = "system";
    record.decisionReason = "approval token expired";
    this.save();
    this.emit({
      type: "approval.expired",
      actor: "system",
      subject: record.id,
      runId: record.runId,
      details: publicDetails(record),
    });
  }

  private emit(event: ApprovalAuditEvent): void {
    this.audit?.record(event);
  }

  private load(): void {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as ApprovalFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.requests)) return;
      for (const record of parsed.requests) {
        if (isStoredApproval(record)) this.requests.set(record.id, record);
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        return;
      throw error;
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const body: ApprovalFile = {
      version: 1,
      requests: [...this.requests.values()],
    };
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(body, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(temporaryPath, this.filePath);
    try {
      fs.chmodSync(this.filePath, 0o600);
    } catch {
      // Best effort on filesystems without chmod support.
    }
  }
}

function publicRequest(record: StoredApproval): ApprovalRequest {
  const request = { ...record };
  Reflect.deleteProperty(request, "tokenHash");
  return { ...request, context: { ...request.context } };
}

function publicDetails(record: StoredApproval): Record<string, unknown> {
  return {
    action: record.action,
    resource: record.resource,
    risk: record.risk,
    status: record.status,
    reason: record.reason,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    decidedAt: record.decidedAt,
    decidedBy: record.decidedBy,
    consumedAt: record.consumedAt,
    consumedBy: record.consumedBy,
  };
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

function safeTokenMatch(expectedHash: string, token: string): boolean {
  if (typeof token !== "string" || token.length === 0) return false;
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return (
    actual.length === expected.length &&
    crypto.timingSafeEqual(actual, expected)
  );
}

function boundedTtl(value: number | undefined): number {
  if (value == null) return DEFAULT_TTL_MS;
  if (!Number.isFinite(value) || value <= 0)
    throw new Error("ttlMs must be a positive finite number");
  return Math.min(Math.floor(value), MAX_TTL_MS);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`${field} is required`);
  return value.trim().slice(0, 512);
}

function safeContext(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!value) return {};
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 64)) {
    result[key.slice(0, 128)] =
      typeof child === "string" ? child.slice(0, 2048) : child;
  }
  return result;
}

function isStoredApproval(value: unknown): value is StoredApproval {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.runId === "string" &&
    typeof record.actor === "string" &&
    typeof record.action === "string" &&
    typeof record.resource === "string" &&
    typeof record.risk === "string" &&
    typeof record.reason === "string" &&
    record.context !== null &&
    typeof record.context === "object" &&
    typeof record.status === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.expiresAt === "string" &&
    typeof record.tokenHash === "string" &&
    (record.consumedAt === undefined ||
      typeof record.consumedAt === "string") &&
    (record.consumedBy === undefined || typeof record.consumedBy === "string")
  );
}

function assertContextMatches(
  record: StoredApproval,
  context: ApprovalConsumeContext,
): void {
  const expected: Record<string, string> = {
    runId: context.runId,
    stepId: context.stepId,
    deliveryId: context.deliveryId,
    previewHash: context.previewHash,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (record.context[key] !== value) {
      throw new Error(`Approval context mismatch for ${key}`);
    }
  }
}
