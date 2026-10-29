import { nextCronOccurrence, normalizeMisfirePolicy, parseCronExpression, validateTimezone } from "./cron-schedule.js";

describe("Cron schedule calculation", () => {
  it("parses five-field expressions with lists, ranges and steps", () => {
    expect(parseCronExpression("*/15 9-17 * 1,3,5 1-5").minute.values).toEqual(new Set([0, 15, 30, 45]));
    expect(parseCronExpression("0 9 * * 1-5").dayOfWeek.values).toEqual(new Set([1, 2, 3, 4, 5]));
  });

  it("requires exactly five fields and rejects unsupported syntax", () => {
    expect(() => parseCronExpression("* * * * * *")).toThrow(/exactly five fields/);
    expect(() => parseCronExpression("60 * * * *")).toThrow(/within 0-59/);
    expect(() => parseCronExpression("@daily")).toThrow();
    expect(() => parseCronExpression("*/0 * * * *")).toThrow(/step/);
  });

  it("validates IANA timezones explicitly", () => {
    expect(validateTimezone("Asia/Dhaka")).toBe("Asia/Dhaka");
    expect(() => validateTimezone("Mars/Olympus")).toThrow(/Invalid IANA timezone/);
  });

  it("calculates next occurrence strictly after the reference instant", () => {
    expect(nextCronOccurrence("*/15 * * * *", "UTC", "2026-01-01T00:07:00.000Z").toISOString())
      .toBe("2026-01-01T00:15:00.000Z");
  });

  it("calculates in the selected timezone rather than the host timezone", () => {
    expect(nextCronOccurrence("0 9 * * *", "Asia/Dhaka", "2026-01-01T00:00:00.000Z").toISOString())
      .toBe("2026-01-01T03:00:00.000Z");
  });

  it("uses Unix DOM/DOW OR semantics when both are restricted", () => {
    // 1 January 2026 is Thursday, but the day-of-month field matches.
    expect(nextCronOccurrence("0 0 1 * 1", "UTC", "2025-12-31T00:00:00.000Z").toISOString())
      .toBe("2026-01-01T00:00:00.000Z");
  });

  it("supports leap-day schedules", () => {
    expect(nextCronOccurrence("0 12 29 2 *", "UTC", "2025-03-01T00:00:00.000Z").toISOString())
      .toBe("2028-02-29T12:00:00.000Z");
  });

  it("skips nonexistent local times during a spring-forward DST gap", () => {
    expect(nextCronOccurrence("30 1 * * *", "Europe/London", "2026-03-28T23:00:00.000Z").toISOString())
      .toBe("2026-03-30T00:30:00.000Z");
  });

  it("treats repeated local times as separate instants during a fall-back DST fold", () => {
    expect(nextCronOccurrence("30 1 * * *", "Europe/London", "2026-10-25T00:30:00.000Z").toISOString())
      .toBe("2026-10-25T01:30:00.000Z");
  });

  it("rejects impossible calendar combinations quickly", () => {
    expect(() => nextCronOccurrence("0 0 31 2 *", "UTC", "2026-01-01T00:00:00.000Z")).toThrow(/no matching calendar date/);
  });

  it("accepts only implemented misfire policies", () => {
    expect(normalizeMisfirePolicy(undefined)).toBe("skip");
    expect(normalizeMisfirePolicy("run_once")).toBe("run_once");
    expect(() => normalizeMisfirePolicy("catch_up_all")).toThrow(/misfire_policy/);
  });
});
