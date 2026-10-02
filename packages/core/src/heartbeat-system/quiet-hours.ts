import type { QuietHours } from "./types.js";

/** Parse "HH:MM" or "H:MM" into minutes from midnight. */
export function parseTimeToMinutes(value: string): number | null {
  const m = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Get minutes-from-midnight in the given timezone (or local).
 * Uses Intl so no extra dependency is required.
 */
export function minutesNow(timezone?: string, at: Date = new Date()): number {
  if (!timezone) {
    return at.getHours() * 60 + at.getMinutes();
  }
  try {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(at);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
    // en-GB can yield "24" for midnight in some engines
    const h = hour === 24 ? 0 : hour;
    return h * 60 + minute;
  } catch {
    return at.getHours() * 60 + at.getMinutes();
  }
}

/**
 * True when `at` falls inside quiet_hours window.
 * Overnight windows supported (e.g. 22:00–07:00).
 */
export function isInQuietHours(
  quiet: QuietHours | null | undefined,
  at: Date = new Date(),
): boolean {
  if (!quiet) return false;
  const start = parseTimeToMinutes(quiet.start);
  const end = parseTimeToMinutes(quiet.end);
  if (start === null || end === null) return false;
  if (start === end) return false; // zero-width window = disabled
  const now = minutesNow(quiet.timezone, at);
  if (start < end) {
    return now >= start && now < end;
  }
  // overnight: e.g. 22:00–07:00
  return now >= start || now < end;
}
