export type AgentErrorCode =
  | "config_error"
  | "auth_error"
  | "provider_error"
  | "channel_error"
  | "tool_error"
  | "model_error"
  | "rate_limit"
  | "timeout"
  | "validation_error"
  | "internal_error";

export interface NormalizedAgentError {
  code: AgentErrorCode;
  message: string;
  requestId?: string;
  cause?: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export class AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    code: AgentErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message);
    this.name = "AgentError";
    this.code = code;
    this.retryable = options.retryable ?? isRetryableErrorCode(code);
    this.details = options.details;
  }
}

export function isRetryableErrorCode(code: AgentErrorCode): boolean {
  return ["provider_error", "channel_error", "rate_limit", "timeout"].includes(
    code,
  );
}

export function errorToHttpStatus(code: AgentErrorCode): number {
  switch (code) {
    case "auth_error":
      return 401;
    case "validation_error":
    case "config_error":
      return 400;
    case "rate_limit":
      return 429;
    case "timeout":
      return 504;
    case "provider_error":
    case "channel_error":
    case "tool_error":
    case "model_error":
      return 502;
    default:
      return 500;
  }
}

export function classifyError(error: unknown): AgentErrorCode {
  if (error instanceof AgentError) return error.code;
  const message =
    error instanceof Error
      ? error.message.toLowerCase()
      : String(error).toLowerCase();
  if (message.includes("unauthorized") || message.includes("forbidden")) {
    return "auth_error";
  }
  if (message.includes("rate limit") || message.includes("429")) {
    return "rate_limit";
  }
  if (message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (message.includes("config") || message.includes("missing required")) {
    return "config_error";
  }
  if (message.includes("model")) {
    return "model_error";
  }
  if (message.includes("channel") || message.includes("webhook")) {
    return "channel_error";
  }
  if (message.includes("tool")) {
    return "tool_error";
  }
  if (message.includes("provider") || message.includes("api")) {
    return "provider_error";
  }
  return "internal_error";
}

export function normalizeAgentError(
  error: unknown,
  options: { requestId?: string; code?: AgentErrorCode } = {},
): NormalizedAgentError {
  const code = options.code || classifyError(error);
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Unexpected internal error";
  return {
    code,
    message,
    requestId: options.requestId,
    cause:
      error instanceof Error && error.cause ? String(error.cause) : undefined,
    retryable:
      error instanceof AgentError
        ? error.retryable
        : isRetryableErrorCode(code),
    details: error instanceof AgentError ? error.details : undefined,
  };
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
