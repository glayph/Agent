/**
 * What a finished tool call said about its own effect, read from its structured result.
 *
 * Only explicit boolean fields (`delivered`, `confirmed`, `success`, `ok`) count. A result that is not an
 * object, or that says nothing either way, is "unknown" (`undefined`), never "confirmed". Natural-language
 * text in a result is never interpreted. A call that merely finished is not proof its effect happened.
 */
const EFFECT_FIELDS = ["delivered", "confirmed", "success", "ok"] as const;

export function toolEffectConfirmation(output: unknown): boolean | undefined {
  let value = output;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return undefined; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const flags = EFFECT_FIELDS
    .map((key) => (value as Record<string, unknown>)[key])
    .filter((flag): flag is boolean => typeof flag === "boolean");
  if (flags.length === 0) return undefined;
  return flags.every(Boolean);
}
