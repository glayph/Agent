/**
 * Stable provider error contract.
 *
 * Provider adapters may use different SDKs, but callers only depend on this
 * small, provider-neutral taxonomy. Do not import provider SDK types outside
 * the adapter that owns them.
 */
export interface LLMProviderDiagnostic {
  correlationId: string;
  providerId?: string;
  model?: string;
  endpoint?: string;
  status?: number;
  requestShape?: {
    messageCount: number;
    toolCount: number;
    payloadBytes: number;
  };
}

export class LLMProviderError extends Error {
  readonly providerId?: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly diagnostic?: LLMProviderDiagnostic;

  constructor(
    message: string,
    options: {
      providerId?: string;
      status?: number;
      retryable?: boolean;
      cause?: unknown;
      diagnostic?: LLMProviderDiagnostic;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "LLMProviderError";
    this.providerId = options.providerId;
    this.status = options.status;
    this.retryable = options.retryable === true;
    this.diagnostic = options.diagnostic;
  }
}

export class LLMRateLimitError extends LLMProviderError {
  constructor(
    message: string,
    options: Omit<
      ConstructorParameters<typeof LLMProviderError>[1],
      "retryable"
    > = {},
  ) {
    super(message, { ...options, retryable: true });
    this.name = "LLMRateLimitError";
  }
}

export class LLMTimeoutError extends LLMProviderError {
  constructor(
    message: string,
    options: Omit<
      ConstructorParameters<typeof LLMProviderError>[1],
      "retryable"
    > = {},
  ) {
    super(message, { ...options, retryable: true });
    this.name = "LLMTimeoutError";
  }
}

export class LLMAPIError extends LLMProviderError {
  constructor(
    message: string,
    options: ConstructorParameters<typeof LLMProviderError>[1] = {},
  ) {
    super(message, options);
    this.name = "LLMAPIError";
  }
}

export class LLMMissingCredentialError extends LLMProviderError {
  constructor(
    message: string,
    options: Omit<
      ConstructorParameters<typeof LLMProviderError>[1],
      "retryable"
    > = {},
  ) {
    super(message, { ...options, retryable: false });
    this.name = "LLMMissingCredentialError";
  }
}

export class LLMEntitlementError extends LLMProviderError {
  constructor(
    message: string,
    options: Omit<
      ConstructorParameters<typeof LLMProviderError>[1],
      "retryable"
    > = {},
  ) {
    super(message, { ...options, retryable: false });
    this.name = "LLMEntitlementError";
  }
}

/** Backward-compatible names used by legacy LiteLLM callers. */
export class LiteLLMError extends LLMProviderError {}
export class LiteLLMRateLimitError extends LLMRateLimitError {}
export class LiteLLMTimeoutError extends LLMTimeoutError {}
export class LiteLLMAPIError extends LLMAPIError {}
export class LiteLLMMissingCredentialError extends LLMMissingCredentialError {}
