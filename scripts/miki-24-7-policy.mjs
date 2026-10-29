// The 24/7 supervisor never gives up: a crashing gateway is always restarted.
// Only the wait between restarts is bounded, so an outage ends as soon as
// the network or provider is back, without waiting longer than three minutes.
export const MAX_BACKOFF_CEILING_MS = 180_000;
export const DEFAULT_MAX_BACKOFF_MS = MAX_BACKOFF_CEILING_MS;
export const DEFAULT_RESTART_RESET_AFTER_MS = 300_000;

export function resolvePositiveDuration(value, fallback, minimum = 1_000) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum
    ? Math.floor(numeric)
    : fallback;
}

/** Configured restart backoff cap, never above the three minute ceiling. */
export function resolveMaxBackoffMs(value) {
  return Math.min(
    MAX_BACKOFF_CEILING_MS,
    resolvePositiveDuration(value, DEFAULT_MAX_BACKOFF_MS),
  );
}

export function computeRestartDelay(
  restartCount,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
) {
  const count = Math.max(1, Math.floor(Number(restartCount) || 1));
  const cap = Math.min(
    MAX_BACKOFF_CEILING_MS,
    Math.max(1_000, Math.floor(Number(maxBackoffMs) || 1_000)),
  );
  // The exponent is bounded so the multiplication can never overflow.
  return Math.min(cap, 1_000 * 2 ** Math.min(count - 1, 20));
}
