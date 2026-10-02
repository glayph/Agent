import type { CronSchedule } from "./types.js";

/**
 * Compute next run time (epoch ms) for a schedule, or null if invalid/expired once.
 * Supports: one-shot ISO/epoch, @hourly/@daily/@weekly, "every N minutes|seconds",
 * and standard 5-field cron (min hour dom mon dow).
 */
export function computeNextRunAt(
  schedule: CronSchedule,
  fromTime: number = Date.now(),
): number | null {
  if (schedule.kind === "once") {
    const ts = parseOnce(schedule.expr);
    if (ts === null) return null;
    return ts > fromTime ? ts : null;
  }
  return parseCronToNextRun(
    schedule.expr,
    fromTime,
    schedule.timezone || "UTC",
  );
}

export function parseOnce(expr: string): number | null {
  const trimmed = expr.trim();
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    return n < 1e12 ? n * 1000 : n;
  }
  const ms = Date.parse(trimmed);
  return Number.isFinite(ms) ? ms : null;
}

export function toIso(ms: number | null | undefined): string | undefined {
  if (ms == null || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/** Local copy of scheduler.parseCronToNextRun (avoids heavy import graph). */
export function parseCronToNextRun(
  cronExpr: string,
  fromTime?: number,
  timezone = "UTC",
): number | null {
  const time = fromTime || Date.now();

  if (cronExpr === "@hourly") return time + 60 * 60 * 1000;
  if (cronExpr === "@daily") return time + 24 * 60 * 60 * 1000;
  if (cronExpr === "@weekly") return time + 7 * 24 * 60 * 60 * 1000;

  const minuteMatch = cronExpr.match(/every\s+(\d+)\s+minutes?/i);
  if (minuteMatch) {
    const minutes = parseInt(minuteMatch[1]!, 10);
    return minutes > 0 ? time + minutes * 60 * 1000 : null;
  }

  const secondMatch = cronExpr.match(/every\s+(\d+)\s+seconds?/i);
  if (secondMatch) {
    const seconds = parseInt(secondMatch[1]!, 10);
    return seconds >= 1 ? time + seconds * 1000 : null;
  }

  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) return null;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
  } catch {
    return null;
  }

  const matches = (field: string, value: number, min: number, max: number) =>
    field.split(",").some((part) => {
      if (part === "*") return true;
      const step = part.match(/^\*\/(\d+)$/);
      if (step)
        return Number(step[1]) > 0 && (value - min) % Number(step[1]) === 0;
      const range = part.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
      if (range) {
        const start = Number(range[1]);
        const end = Number(range[2]);
        const increment = Number(range[3] || 1);
        return (
          value >= start && value <= end && (value - start) % increment === 0
        );
      }
      const numeric = Number(part);
      return (
        Number.isInteger(numeric) &&
        numeric >= min &&
        numeric <= max &&
        numeric === value
      );
    });

  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  for (
    let candidate = Math.floor(time / 60_000) * 60_000 + 60_000;
    candidate <= time + 366 * 24 * 60 * 60_000;
    candidate += 60_000
  ) {
    const parts = Object.fromEntries(
      formatter.formatToParts(candidate).map((part) => [part.type, part.value]),
    );
    const minute = Number(parts.minute);
    const hour = Number(parts.hour);
    const day = Number(parts.day);
    const month = Number(parts.month);
    const weekday = weekdayMap[parts.weekday!];
    if (
      matches(fields[0]!, minute, 0, 59) &&
      matches(fields[1]!, hour, 0, 23) &&
      matches(fields[2]!, day, 1, 31) &&
      matches(fields[3]!, month, 1, 12) &&
      matches(fields[4]!, weekday ?? -1, 0, 6)
    ) {
      return candidate;
    }
  }
  return null;
}
