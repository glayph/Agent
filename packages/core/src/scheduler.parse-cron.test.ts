/**
 * Tests for parseCronToNextRun's supported schedule shorthands
 * (@hourly/@daily/@weekly and "every N minutes/seconds").
 *
 * Regression coverage: "every N seconds" previously accepted any positive
 * integer, including "every 1 seconds". Since this value directly drives
 * how often an automation fires an agent run, that allowed a user to
 * (accidentally or not) create a schedule that re-triggers the agent once
 * per second — a resource-exhaustion / runaway-cost risk with no
 * safeguard. A 30-second floor is now enforced.
 */

import { parseCronToNextRun } from "./scheduler.js";

describe("parseCronToNextRun", () => {
  const FIXED_NOW = 1_700_000_000_000;

  it("resolves @hourly to +1 hour", () => {
    expect(parseCronToNextRun("@hourly", FIXED_NOW)).toBe(
      FIXED_NOW + 60 * 60 * 1000,
    );
  });

  it("resolves @daily to +24 hours", () => {
    expect(parseCronToNextRun("@daily", FIXED_NOW)).toBe(
      FIXED_NOW + 24 * 60 * 60 * 1000,
    );
  });

  it("resolves @weekly to +7 days", () => {
    expect(parseCronToNextRun("@weekly", FIXED_NOW)).toBe(
      FIXED_NOW + 7 * 24 * 60 * 60 * 1000,
    );
  });

  it("resolves 'every N minutes' correctly", () => {
    expect(parseCronToNextRun("every 15 minutes", FIXED_NOW)).toBe(
      FIXED_NOW + 15 * 60 * 1000,
    );
  });

  it("is case-insensitive and tolerates singular 'minute'", () => {
    expect(parseCronToNextRun("EVERY 1 MINUTE", FIXED_NOW)).toBe(
      FIXED_NOW + 1 * 60 * 1000,
    );
  });

  it("rejects 'every 0 minutes'", () => {
    expect(parseCronToNextRun("every 0 minutes", FIXED_NOW)).toBeNull();
  });

  describe("'every N seconds' minimum-interval enforcement (regression)", () => {
    it("accepts 30 seconds (the floor)", () => {
      expect(parseCronToNextRun("every 30 seconds", FIXED_NOW)).toBe(
        FIXED_NOW + 30 * 1000,
      );
    });

    it("accepts intervals above the floor", () => {
      expect(parseCronToNextRun("every 60 seconds", FIXED_NOW)).toBe(
        FIXED_NOW + 60 * 1000,
      );
    });

    it("rejects 1 second (previously accepted — this was the bug)", () => {
      expect(parseCronToNextRun("every 1 seconds", FIXED_NOW)).toBeNull();
    });

    it("rejects 29 seconds (just under the floor)", () => {
      expect(parseCronToNextRun("every 29 seconds", FIXED_NOW)).toBeNull();
    });

    it("rejects 0 seconds", () => {
      expect(parseCronToNextRun("every 0 seconds", FIXED_NOW)).toBeNull();
    });

    it("is case-insensitive and tolerates singular 'second'", () => {
      expect(parseCronToNextRun("EVERY 45 SECOND", FIXED_NOW)).toBe(
        FIXED_NOW + 45 * 1000,
      );
    });
  });

  it("returns null for unsupported expressions", () => {
    expect(parseCronToNextRun("0 9 * * MON-FRI", FIXED_NOW)).toBeNull();
    expect(parseCronToNextRun("not a schedule", FIXED_NOW)).toBeNull();
    expect(parseCronToNextRun("", FIXED_NOW)).toBeNull();
  });

  it("defaults fromTime to Date.now() when omitted", () => {
    const before = Date.now();
    const result = parseCronToNextRun("@hourly");
    const after = Date.now();
    expect(result).not.toBeNull();
    expect(result as number).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
    expect(result as number).toBeLessThanOrEqual(after + 60 * 60 * 1000);
  });
});
