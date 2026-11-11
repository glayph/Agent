/** Default in-place retry bounds for transient model/provider failures. */
export const TRANSIENT_RETRY_MIN_DELAY_MS = 2_000;
export const TRANSIENT_RETRY_MAX_DELAY_MS = 12_000;

export interface TransientRetryDelayOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  continueRetryingEveryMs?: number;
  /** Disable jitter when a caller requires exact retry intervals. Defaults to enabled. */
  jitter?: boolean;
  /**
   * Also wait and retry (instead of failing the run) when the provider rejects the key (401/403) or
   * reports a billing/quota block (402 / insufficient_quota). The owner can fix a key or top up credit
   * at any moment and quotas reset, so an always-on agent keeps trying. A provider-supplied
   * Retry-After is still honoured as a floor. Never applies to a bad request or an unknown model:
   * repeating the identical request cannot fix those.
   */
  retryPermanentFailures?: boolean;
}

/** Fixed pause between model attempts for an always-on agent. */
export const NEVER_STOP_RETRY_DELAY_MS = 3_000;

/**
 * Retry options for runs that must never give up: unlimited attempts, one fixed delay (default 3 s,
 * `MIKI_MODEL_RETRY_DELAY_MS` or the `delayMs` argument overrides it), no jitter, and provider
 * quota/auth blocks are waited out instead of ending the run.
 */
export function neverStopRetryOptions(delayMs?: number): Required<Pick<TransientRetryDelayOptions,
  "baseDelayMs" | "maxDelayMs" | "maxRetries" | "continueRetryingEveryMs" | "jitter" | "retryPermanentFailures">> {
  const fromEnv = Number(process.env.MIKI_MODEL_RETRY_DELAY_MS);
  const requested = Number.isFinite(Number(delayMs)) && Number(delayMs) > 0 ? Number(delayMs)
    : Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : NEVER_STOP_RETRY_DELAY_MS;
  const ms = Math.max(250, Math.floor(requested));
  return { baseDelayMs: ms, maxDelayMs: ms, maxRetries: 0, continueRetryingEveryMs: ms, jitter: false, retryPermanentFailures: true };
}

/**
 * Resolve one retry delay. A finite maxRetries plus continueRetryingEveryMs means: run a
 * bounded exponential burst, then continue at the fixed cadence until recovery/cancellation.
 * The cap is applied after jitter so randomized delays can never exceed maxDelayMs.
 */
export function calculateTransientRetryDelayMs(
  retryCount: number,
  options: TransientRetryDelayOptions = {},
  random: () => number = Math.random,
): number {
  const retry = Math.max(1, Math.floor(Number(retryCount) || 1));
  const rawMaxDelay = Number(options.maxDelayMs);
  const maxDelayMs = Number.isFinite(rawMaxDelay) && rawMaxDelay > 0
    ? Math.max(1, Math.floor(rawMaxDelay))
    : TRANSIENT_RETRY_MAX_DELAY_MS;
  const rawBaseDelay = Number(options.baseDelayMs);
  const baseDelayMs = Math.min(maxDelayMs, Number.isFinite(rawBaseDelay) && rawBaseDelay > 0
    ? Math.max(1, Math.floor(rawBaseDelay))
    : TRANSIENT_RETRY_MIN_DELAY_MS);
  const maxRetries = Number(options.maxRetries);
  const continuationDelayMs = Number(options.continueRetryingEveryMs);
  if (Number.isFinite(maxRetries) && maxRetries >= 0 && retry > Math.floor(maxRetries)
    && Number.isFinite(continuationDelayMs) && continuationDelayMs > 0) {
    return Math.min(maxDelayMs, Math.max(1, Math.floor(continuationDelayMs)));
  }
  const exponentialDelay = Math.min(maxDelayMs, baseDelayMs * (2 ** Math.min(retry - 1, 16)));
  if (options.jitter === false) return Math.max(1, Math.floor(exponentialDelay));
  const randomValue = Math.min(1, Math.max(0, Number(random()) || 0));
  const jittered = Math.floor(exponentialDelay * (0.8 + randomValue * 0.4));
  return Math.min(maxDelayMs, Math.max(1, jittered));
}
