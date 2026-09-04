export type JsonRecord = Record<string, unknown>;

export function channelFieldValue(config: JsonRecord, field: string): unknown {
  const direct = config[field];
  if (direct !== undefined) return direct;
  const settings = config.settings;
  if (settings && typeof settings === "object" && !Array.isArray(settings)) {
    return (settings as JsonRecord)[field];
  }
  return undefined;
}

export function isValidUrlLike(
  value: unknown,
  protocols: readonly string[],
): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  try {
    return protocols.includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

export function isNonEmptyIdentifier(value: unknown): boolean {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value.trim());
}
