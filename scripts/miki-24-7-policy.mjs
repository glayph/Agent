export const DEFAULT_MAX_RESTARTS = 5;
export const DEFAULT_MAX_BACKOFF_MS = 60_000;
export const DEFAULT_RESTART_RESET_AFTER_MS = 300_000;

export function resolveMaxRestarts(env = process.env) {
  const configured = Number(env.MIKI_24_7_MAX_RESTARTS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  // Unlimited recovery is an explicit emergency override, never the default.
  if (
    configured === 0 &&
    String(env.MIKI_24_7_ALLOW_UNLIMITED_RESTARTS || "").toLowerCase() ===
      "true"
  ) {
    return 0;
  }

  return DEFAULT_MAX_RESTARTS;
}

export function resolvePositiveDuration(value, fallback, minimum = 1_000) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= minimum
    ? Math.floor(numeric)
    : fallback;
}

export function computeRestartDelay(
  restartCount,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
) {
  const count = Math.max(1, Math.floor(Number(restartCount) || 1));
  const cap = Math.max(1_000, Math.floor(Number(maxBackoffMs) || 1_000));
  return Math.min(cap, 1_000 * 2 ** Math.min(count - 1, 6));
}

export function restartLimitReached(maxRestarts, restartCount) {
  return maxRestarts > 0 && restartCount > maxRestarts;
}
