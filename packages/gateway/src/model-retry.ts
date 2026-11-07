/**
 * Automatic retries for a failed model call.
 *
 * Uses exponential backoff with jitter for transient provider failures. Retries continue until
 * the error is no longer retryable, the provider recovers, or the owner cancels the run.
 */
export const MODEL_RETRY_MAX_DELAY_MS = 5 * 60_000

/** Delay before the retry with this zero-based index (0 = the first retry). */
export function modelRetryDelayMs(retryIndex: number): number {
  const index = Math.max(0, Math.floor(Number(retryIndex) || 0))
  return Math.min(MODEL_RETRY_MAX_DELAY_MS, 2_000 * (2 ** Math.min(index, 20)))
}

/** Resolves after `ms`, or as soon as `signal` aborts, whichever comes first. */
export function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener("abort", finish, { once: true })
  })
}

export interface RetryModelCallOptions<T> {
  /** One model attempt. */
  attempt: () => Promise<T>
  /** True when this result is a failure that another attempt may fix. */
  shouldRetry: (result: T) => boolean
  /** Called before each wait. `retry` counts from 1. */
  onRetry?: (info: { retry: number; delayMs: number; result: T }) => void
  /** Called after a wait, just before the next attempt starts. */
  onResumed?: () => void
  /** Aborting this stops the retries. */
  signal: AbortSignal
  /** Delay before each retry, by zero-based retry index. Defaults to `modelRetryDelayMs`. */
  delayMs?: (retryIndex: number) => number
  /** Optional maximum retries after the initial attempt. Omitted means retry until recovery or cancellation. */
  maxRetries?: number
  /** Wait implementation. Defaults to `sleepUnlessAborted`. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

export interface RetryModelCallOutcome<T> {
  /** The last attempt's result. */
  result: T
  /** True when the turn was stopped while a retry was pending; `result` is then the failed attempt. */
  stopped: boolean
}

export async function retryModelCall<T>(options: RetryModelCallOptions<T>): Promise<RetryModelCallOutcome<T>> {
  const delayFor = options.delayMs ?? modelRetryDelayMs
  const sleep = options.sleep ?? sleepUnlessAborted
  let result = await options.attempt()
  const requestedRetries = options.maxRetries === undefined ? Number.POSITIVE_INFINITY : Number(options.maxRetries)
  const maxRetries = Number.isFinite(requestedRetries)
    ? Math.max(0, Math.floor(requestedRetries))
    : Number.POSITIVE_INFINITY
  for (let retryIndex = 0; retryIndex < maxRetries && options.shouldRetry(result); retryIndex += 1) {
    if (options.signal.aborted) return { result, stopped: true }
    const requestedDelayMs = Number(delayFor(retryIndex))
    const baseDelayMs = Number.isFinite(requestedDelayMs) ? Math.max(0, Math.floor(requestedDelayMs)) : 0
    const delayMs = baseDelayMs === 0 ? 0 : Math.max(1, Math.floor(baseDelayMs * (0.8 + Math.random() * 0.4)))
    options.onRetry?.({ retry: retryIndex + 1, delayMs, result })
    await sleep(delayMs, options.signal)
    if (options.signal.aborted) return { result, stopped: true }
    options.onResumed?.()
    result = await options.attempt()
  }
  return { result, stopped: false }
}

/** Backward-compatible error shape; the advisory circuit no longer blocks model calls. */
export class ModelCircuitOpenError extends Error {
  readonly status = 503
  readonly code = "MODEL_CIRCUIT_OPEN"
  constructor(readonly retryAfterMs: number) {
    super(`Model provider circuit is open; retry in about ${Math.max(1, Math.ceil(retryAfterMs / 1000))} seconds.`)
    this.name = "ModelCircuitOpenError"
  }
}

export interface ModelCircuitBreakerOptions {
  failureThreshold?: number
  resetTimeoutMs?: number
  now?: () => number
}

const RETRYABLE_PROVIDER_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNUNREACH", "EHOSTUNREACH", "ETIMEDOUT",
  "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
])

export function isRetryableProviderError(error: unknown): boolean {
  const pending: unknown[] = [error]
  const seen = new Set<unknown>()
  let retryableCode = false
  while (pending.length && seen.size < 8) {
    const current = pending.shift()
    if (!current || typeof current !== "object" || seen.has(current)) continue
    seen.add(current)
    const item = current as { status?: unknown; code?: unknown; name?: unknown; retryable?: unknown; category?: unknown; cause?: unknown }
    const status = typeof item.status === "number" ? item.status : 0
    const category = typeof item.category === "string" ? item.category : ""
    const name = typeof item.name === "string" ? item.name : ""
    if (["LLMEntitlementError", "LLMMissingCredentialError", "LLMAuthorizationError"].includes(name)) return false
    if (["provider_entitlement", "provider_api_key", "provider_authorization", "model_not_found", "provider_bad_request"].includes(category)) return false
    if (item.retryable === false) return false
    if (status === 401 || status === 403 || status === 400 || status === 404) return false
    if (["provider_network", "provider_rate_limit", "provider_unavailable", "local_model_unavailable"].includes(category)) return true
    if (status === 408 || status === 429 || status >= 500) return true
    const code = typeof item.code === "string" ? item.code.toUpperCase() : ""
    if (RETRYABLE_PROVIDER_CODES.has(code)) retryableCode = true
    if (item.cause) pending.push(item.cause)
  }
  if (retryableCode) return true
  const root = error && typeof error === "object" ? error as { retryable?: unknown } : {}
  return root.retryable === true
}

/**
 * Per-model, in-memory health signal. Repeated transient failures mark a route as
 * degraded for observability and routing decisions, but never gate a call. The
 * retry policy and model router decide how to recover; a circuit state alone must
 * not prevent a new attempt from reaching a provider that may already have recovered.
 */
export class ModelCircuitBreaker {
  private failures = 0
  private openedUntil = 0
  private readonly failureThreshold: number
  private readonly resetTimeoutMs: number
  private readonly now: () => number

  constructor(options: ModelCircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, Math.floor(options.failureThreshold ?? 5))
    this.resetTimeoutMs = Math.max(1, Math.floor(options.resetTimeoutMs ?? 30_000))
    this.now = options.now ?? Date.now
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      const result = await operation()
      this.failures = 0
      this.openedUntil = 0
      return result
    } catch (error) {
      if (isRetryableProviderError(error)) {
        this.failures += 1
        if (this.failures >= this.failureThreshold) this.openedUntil = this.now() + this.resetTimeoutMs
      }
      throw error
    }
  }

  snapshot(): { failures: number; open: boolean; retryAfterMs: number } {
    const retryAfterMs = Math.max(0, this.openedUntil - this.now())
    return { failures: this.failures, open: retryAfterMs > 0, retryAfterMs }
  }
}
