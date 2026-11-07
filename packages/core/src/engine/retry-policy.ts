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
