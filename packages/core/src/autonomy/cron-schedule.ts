/**
 * Dependency-free five-field Cron parsing and next-occurrence calculation.
 *
 * Supported syntax: numeric fields, *, lists, ranges and steps. Seconds, aliases,
 * macros and implementation-specific extensions are intentionally not accepted.
 * Times are evaluated on the real UTC timeline and projected into an explicit IANA
 * timezone with Intl, so nonexistent local times are skipped and repeated local times
 * remain distinct instants.
 */
export type MisfirePolicy = "skip" | "run_once";

type CronField = {
  values: Set<number>;
  wildcard: boolean;
  min: number;
  max: number;
};

export type ParsedCronExpression = {
  expression: string;
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
};

const MAX_SEARCH_YEARS = 8;
const MINUTE_MS = 60_000;
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function parseField(source: string, min: number, max: number, name: string, normalize?: (value: number) => number): CronField {
  if (!source) throw new Error(`${name} field cannot be empty.`);
  const values = new Set<number>();
  const wildcard = source === "*";

  for (const part of source.split(",")) {
    if (!part) throw new Error(`${name} field contains an empty list item.`);
    const stepPieces = part.split("/");
    if (stepPieces.length > 2) throw new Error(`${name} field has an invalid step expression: ${part}`);
    const step = stepPieces.length === 2 ? Number(stepPieces[1]) : 1;
    if (!Number.isInteger(step) || step < 1 || step > max - min + 1) {
      throw new Error(`${name} step must be an integer from 1 to ${max - min + 1}.`);
    }

    const base = stepPieces[0];
    let start: number;
    let end: number;
    if (base === "*") {
      start = min;
      end = max;
    } else if (base.includes("-")) {
      const range = base.split("-");
      if (range.length !== 2 || !/^\d+$/.test(range[0]) || !/^\d+$/.test(range[1])) {
        throw new Error(`${name} range is invalid: ${base}`);
      }
      start = Number(range[0]);
      end = Number(range[1]);
    } else {
      if (!/^\d+$/.test(base)) throw new Error(`${name} field contains an unsupported value: ${base}`);
      start = Number(base);
      end = stepPieces.length === 2 ? max : start;
    }

    if (start < min || start > max || end < min || end > max || start > end) {
      throw new Error(`${name} field values must be within ${min}-${max} and ranges must ascend.`);
    }
    for (let value = start; value <= end; value += step) values.add(normalize ? normalize(value) : value);
  }

  if (values.size === 0) throw new Error(`${name} field does not select any values.`);
  return { values, wildcard, min, max };
}

export function parseCronExpression(expression: string): ParsedCronExpression {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    throw new Error("Cron expression is required.");
  }
  if (expression.length > 120) throw new Error("Cron expression must be 120 characters or fewer.");
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("Cron expression must contain exactly five fields: minute hour day-of-month month day-of-week.");

  return {
    expression: parts.join(" "),
    minute: parseField(parts[0], 0, 59, "Minute"),
    hour: parseField(parts[1], 0, 23, "Hour"),
    dayOfMonth: parseField(parts[2], 1, 31, "Day-of-month"),
    month: parseField(parts[3], 1, 12, "Month"),
    dayOfWeek: parseField(parts[4], 0, 7, "Day-of-week", (value) => value === 7 ? 0 : value),
  };
}

export function validateTimezone(timezone: string): string {
  if (typeof timezone !== "string" || timezone.trim().length === 0 || timezone.length > 128) {
    throw new Error("An IANA timezone is required (for example, Asia/Dhaka or UTC).");
  }
  try {
    // Intl validates actual runtime-supported IANA timezone identifiers.
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date(0));
  } catch {
    throw new Error(`Invalid IANA timezone: ${timezone}`);
  }
  return timezone;
}

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
      hourCycle: "h23",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

function localParts(date: Date, formatter: Intl.DateTimeFormat) {
  const entries = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(entries.year),
    month: Number(entries.month),
    day: Number(entries.day),
    hour: Number(entries.hour),
    minute: Number(entries.minute),
    weekday: WEEKDAYS[entries.weekday],
  };
}

function calendarDayMatches(cron: ParsedCronExpression, parts: ReturnType<typeof localParts>): boolean {
  if (!cron.month.values.has(parts.month)) return false;
  const domMatches = cron.dayOfMonth.values.has(parts.day);
  const dowMatches = cron.dayOfWeek.values.has(parts.weekday);
  if (cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard) return true;
  if (cron.dayOfMonth.wildcard) return dowMatches;
  if (cron.dayOfWeek.wildcard) return domMatches;
  // Standard Unix crontab behavior: restricted DOM and DOW fields are combined with OR.
  return domMatches || dowMatches;
}

function hasPossibleCalendarDate(cron: ParsedCronExpression, fromYear: number, formatterTimezone: string): boolean {
  // A quick bounded preflight avoids long scans for impossible combinations such as 31 February.
  // Gregorian calendar repeats every 400 years; looking forward eight years is enough for normal
  // numeric month/day combinations (including leap day) and aligns with the runtime horizon below.
  for (let year = fromYear; year <= fromYear + MAX_SEARCH_YEARS; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      if (!cron.month.values.has(month)) continue;
      const count = new Date(Date.UTC(year, month, 0)).getUTCDate();
      for (let day = 1; day <= count; day += 1) {
        const weekday = new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
        const domMatches = cron.dayOfMonth.values.has(day);
        const dowMatches = cron.dayOfWeek.values.has(weekday);
        const matches = cron.dayOfMonth.wildcard && cron.dayOfWeek.wildcard
          ? true
          : cron.dayOfMonth.wildcard ? dowMatches
            : cron.dayOfWeek.wildcard ? domMatches
              : domMatches || dowMatches;
        if (matches) return true;
      }
    }
  }
  // The timezone is already validated; refer to it to keep this helper's contract explicit.
  void formatterTimezone;
  return false;
}

/** Calculates the first matching instant strictly after `after`. */
export function nextCronOccurrence(expression: string | ParsedCronExpression, timezone: string, after: Date | string | number): Date {
  const cron = typeof expression === "string" ? parseCronExpression(expression) : expression;
  validateTimezone(timezone);
  const reference = after instanceof Date ? after.getTime() : new Date(after).getTime();
  if (!Number.isFinite(reference)) throw new Error("Reference time must be a valid date.");
  const formatter = formatterFor(timezone);
  const first = Math.floor(reference / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const firstParts = localParts(new Date(first), formatter);
  if (!hasPossibleCalendarDate(cron, firstParts.year, timezone)) {
    throw new Error(`Cron expression '${cron.expression}' has no matching calendar date in the next ${MAX_SEARCH_YEARS} years.`);
  }

  const horizon = first + MAX_SEARCH_YEARS * 366 * 24 * 60 * MINUTE_MS;
  for (let candidateMs = first; candidateMs <= horizon; candidateMs += MINUTE_MS) {
    const date = new Date(candidateMs);
    const parts = localParts(date, formatter);

    // Most candidates are discarded by calendar date. Jump to the next local hour boundary
    // on an impossible date, dramatically reducing scans for monthly/yearly expressions while
    // still rechecking Intl after the jump so DST gaps/folds remain correct.
    if (!calendarDayMatches(cron, parts)) {
      candidateMs += (59 - parts.minute) * MINUTE_MS;
      continue;
    }
    if (!cron.hour.values.has(parts.hour) || !cron.minute.values.has(parts.minute)) continue;
    return date;
  }
  throw new Error(`No next occurrence for '${cron.expression}' was found within ${MAX_SEARCH_YEARS} years.`);
}

export function normalizeMisfirePolicy(value: unknown): MisfirePolicy {
  if (value === undefined || value === null || value === "skip") return "skip";
  if (value === "run_once") return "run_once";
  throw new Error("misfire_policy must be 'skip' or 'run_once'.");
}
