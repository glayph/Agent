import {
  LLMAPIError,
  LLMEntitlementError,
  LLMMissingCredentialError,
  LLMProviderError,
  LLMRateLimitError,
  LLMTimeoutError,
} from "../provider/errors.js";
import type { FailureKind } from "./types.js";

export interface FailureClass {
  kind: FailureKind;
  /** May another credential/model succeed where this attempt failed? */
  failover: boolean;
  /** Would a different credential of the SAME provider plausibly help? */
  rotateCredential: boolean;
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const CONTEXT_PATTERN =
  /context[ _-]?(length|window)|too many tokens|maximum context|token limit|prompt is too long|request too large/i;

function make(
  kind: FailureKind,
  failover: boolean,
  rotateCredential = false,
): FailureClass {
  return { kind, failover, rotateCredential };
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const cause = (error as { cause?: unknown }).cause;
    const causeMessage = cause instanceof Error ? ` ${cause.message}` : "";
    return `${error.message}${causeMessage}`;
  }
  return String(error ?? "");
}

function byStatus(status: number, text: string): FailureClass | undefined {
  if (status === 401 || status === 403) return make("auth", true, true);
  if (status === 402) return make("billing", true, true);
  if (status === 429) return make("rate_limit", true, true);
  if (status === 408 || status === 504) return make("timeout", true);
  if (status === 404) return make("model_not_found", true);
  if (status === 413) return make("context_overflow", true);
  if (status === 400) {
    return CONTEXT_PATTERN.test(text)
      ? make("context_overflow", true)
      : make("bad_request", false);
  }
  if (status >= 500) return make("server_error", true);
  if (status >= 400) return make("bad_request", false);
  return undefined;
}

/**
 * Decide whether a failed provider call is worth a credential rotation or a
 * model hop. Deliberately conservative: programmer errors and malformed
 * requests are NOT failed over (they would fail identically elsewhere, and
 * hiding them behind a fallback would mask bugs) — they are rethrown unchanged.
 */
export function classifyFailure(
  error: unknown,
  context: { aborted?: boolean } = {},
): FailureClass {
  if (context.aborted) return make("aborted", false);
  const name = (error as { name?: unknown } | null)?.name;
  if (name === "AbortError" || name === "APIUserAbortError") {
    return make("aborted", false);
  }

  if (error instanceof LLMRateLimitError) return make("rate_limit", true, true);
  if (error instanceof LLMEntitlementError) return make("billing", true, true);
  if (error instanceof LLMMissingCredentialError) {
    // No provider matched at all → try another model; otherwise the key is
    // missing/rejected → try another credential first.
    return error.providerId
      ? make("auth", true, true)
      : make("model_not_found", true);
  }
  if (error instanceof LLMTimeoutError) return make("timeout", true);

  if (error instanceof LLMProviderError) {
    const text = messageOf(error);
    if (/does not support audio|unsupported (image|audio|input)/i.test(text)) {
      return make("bad_request", false);
    }
    const fromStatus = error.status ? byStatus(error.status, text) : undefined;
    if (fromStatus) return fromStatus;
    if (error instanceof LLMAPIError) {
      // No provider resolved for the model → the model reference is wrong.
      if (!error.providerId) return make("model_not_found", true);
      // Provider-tagged failure with no HTTP status: transport-level trouble
      // (connection refused/reset, DNS, local runtime down).
      return make("network", true);
    }
    return make("unknown", false);
  }

  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) {
    return make("network", true);
  }
  if (name === "TimeoutError") return make("timeout", true);
  return make("unknown", false);
}
