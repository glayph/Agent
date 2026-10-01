import { LLMProviderError } from "../provider/errors.js";
import type { FailoverHop, FailureKind } from "./types.js";

function summarize(hops: readonly FailoverHop[]): string {
  return hops
    .map((hop) =>
      hop.to
        ? `${hop.from} → ${hop.to} (${hop.kind})`
        : `${hop.from} (${hop.kind})`,
    )
    .join("; ");
}

/** Base class for everything the router itself raises. */
export class ModelRouterError extends LLMProviderError {
  readonly hops: readonly FailoverHop[];
  readonly failureKind: FailureKind;

  constructor(
    message: string,
    options: {
      providerId?: string;
      status?: number;
      retryable?: boolean;
      cause?: unknown;
      failureKind: FailureKind;
      hops?: readonly FailoverHop[];
    },
  ) {
    super(message, {
      providerId: options.providerId,
      status: options.status,
      retryable: options.retryable,
      cause: options.cause,
      diagnostic: (options.cause as LLMProviderError | undefined)?.diagnostic,
    });
    this.name = "ModelRouterError";
    this.failureKind = options.failureKind;
    this.hops = options.hops ?? [];
  }
}

/**
 * The person/operator explicitly chose `requestedModel` and it cannot serve the
 * request. Raised INSTEAD of silently answering with a different model.
 */
export class ExplicitModelUnavailableError extends ModelRouterError {
  readonly requestedModel: string;

  constructor(
    requestedModel: string,
    detail: string,
    options: {
      cause?: unknown;
      failureKind: FailureKind;
      hops?: readonly FailoverHop[];
      providerId?: string;
      status?: number;
      retryable?: boolean;
    },
  ) {
    super(
      `The requested model "${requestedModel}" is unavailable: ${detail} ` +
        "It was chosen explicitly, so no other model was substituted.",
      options,
    );
    this.name = "ExplicitModelUnavailableError";
    this.requestedModel = requestedModel;
  }
}

/** Every candidate in the chain failed (or was unavailable). */
export class AllModelsFailedError extends ModelRouterError {
  readonly attemptedModels: readonly string[];

  constructor(
    attemptedModels: readonly string[],
    options: {
      cause?: unknown;
      failureKind: FailureKind;
      hops: readonly FailoverHop[];
      providerId?: string;
      status?: number;
      retryable?: boolean;
    },
  ) {
    super(
      `No available model could serve this request. Tried: ${
        attemptedModels.join(", ") || "none"
      }.${options.hops.length ? ` Hops: ${summarize(options.hops)}.` : ""}`,
      options,
    );
    this.name = "AllModelsFailedError";
    this.attemptedModels = attemptedModels;
  }
}

/**
 * Callers that map provider errors to user-facing text should classify the
 * root cause: the router wraps the real provider error in `cause`.
 */
export function unwrapRouterError(error: unknown): unknown {
  if (error instanceof ModelRouterError && error.cause) return error.cause;
  return error;
}
