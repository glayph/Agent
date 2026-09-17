export function boundedRestartLimit(
  raw: string | undefined,
  fallback = 5,
  allowUnlimited = false,
): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
  if (parsed === 0 && allowUnlimited) return 0;
  return fallback;
}

export function computeRestartBackoff(
  restartAttempt: number,
  maxBackoffMs = 5 * 60 * 1000,
): number {
  const attempt = Math.max(1, Math.floor(Number(restartAttempt) || 1));
  const cap = Math.max(1_000, Math.floor(Number(maxBackoffMs) || 1_000));
  return Math.min(cap, 2 ** attempt * 1_000);
}
