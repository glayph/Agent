const MASK = "••••••••"

/**
 * Returns a safe placeholder for a secret input without ever placing the
 * stored secret itself in the DOM. Empty values use the caller's normal
 * placeholder; configured values use a fixed mask and explanatory text.
 */
export function maskedSecretPlaceholder(
  value: unknown,
  emptyPlaceholder: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return emptyPlaceholder
  }
  return `${MASK} ${emptyPlaceholder}`
}

export default maskedSecretPlaceholder
