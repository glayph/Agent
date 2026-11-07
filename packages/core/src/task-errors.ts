export type TaskErrorCategory =
  | "transient"
  | "rate_limit"
  | "stale_state"
  | "auth_config"
  | "permanent_validation"
  | "uncertain_side_effect"
  | "resource_exhaustion"
  | "cancelled"
  | "dependency_blocked"
  | "unknown";

export interface TaskErrorOptions {
  category: TaskErrorCategory;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/** Typed execution failure; orchestration decisions must never depend on prose matching. */
export class TaskExecutionError extends Error {
  readonly category: TaskErrorCategory;
  readonly retryAfterMs?: number;
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: TaskErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TaskExecutionError";
    this.category = options.category;
    this.retryAfterMs = Number.isFinite(options.retryAfterMs)
      ? Math.max(0, Math.floor(options.retryAfterMs!))
      : undefined;
    this.details = options.details;
  }
}

export interface ClassifiedTaskError {
  category: TaskErrorCategory;
  message: string;
  retryAfterMs?: number;
  details?: Record<string, unknown>;
}

function recordOf(error: unknown): Record<string, unknown> | undefined {
  return error && typeof error === "object" ? error as Record<string, unknown> : undefined;
}

function retryAfterFrom(record: Record<string, unknown> | undefined): number | undefined {
  const explicit = Number(record?.retryAfterMs);
  if (Number.isFinite(explicit) && explicit >= 0) return Math.floor(explicit);
  const headers = record?.headers && typeof record.headers === "object"
    ? record.headers as Record<string, unknown>
    : undefined;
  const retryHeader = headers && Object.entries(headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (typeof retryHeader !== "string" && typeof retryHeader !== "number") return undefined;
  const raw = String(retryHeader).trim();
  const seconds = Number(raw);
  const dateMs = Number.isFinite(seconds) ? Date.now() + Math.max(0, seconds) * 1_000 : Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, Math.floor(dateMs - Date.now())) : undefined;
}

/** Classifies by explicit type/protocol fields and stable error codes, never error-message regexes. */
export function classifyTaskError(error: unknown): ClassifiedTaskError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TaskExecutionError) {
    return {
      category: error.category,
      message,
      ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      ...(error.details ? { details: error.details } : {}),
    };
  }

  const record = recordOf(error);
  const code = typeof record?.code === "string" ? record.code.toUpperCase() : "";
  const status = Number(record?.status ?? record?.statusCode ?? record?.httpStatus);
  if (status === 429) {
    const retryAfterMs = retryAfterFrom(record);
    return { category: "rate_limit", message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (["ERR_STALE_STATE", "STALE_STATE", "ERR_UI_STATE_CHANGED"].includes(code)) return { category: "stale_state", message };
  if (status === 401 || status === 403) return { category: "auth_config", message };
  if (status === 408 || status === 425 || (Number.isFinite(status) && status >= 500 && status <= 599)) {
    const retryAfterMs = retryAfterFrom(record);
    return { category: "transient", message, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) };
  }
  if (["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) {
    return { category: "transient", message };
  }
  if (["ENOSPC", "EDQUOT", "ENOMEM"].includes(code)) return { category: "resource_exhaustion", message };
  if (["ABORT_ERR", "ERR_CANCELED"].includes(code) || record?.name === "AbortError") return { category: "cancelled", message };
  return { category: "unknown", message };
}
