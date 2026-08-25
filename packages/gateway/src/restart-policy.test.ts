import { describe, expect, it } from "vitest";
import {
  boundedRestartLimit,
  computeRestartBackoff,
} from "./restart-policy.js";

describe("gateway restart policy", () => {
  it("uses a finite default and only permits unlimited with explicit opt-in", () => {
    expect(boundedRestartLimit(undefined)).toBe(5);
    expect(boundedRestartLimit("0")).toBe(5);
    expect(boundedRestartLimit("0", 5, true)).toBe(0);
    expect(boundedRestartLimit("4")).toBe(4);
    expect(boundedRestartLimit("invalid", 7)).toBe(7);
  });

  it("uses capped exponential backoff", () => {
    expect(computeRestartBackoff(1, 60_000)).toBe(2_000);
    expect(computeRestartBackoff(2, 60_000)).toBe(4_000);
    expect(computeRestartBackoff(10, 60_000)).toBe(60_000);
    expect(computeRestartBackoff(0, 60_000)).toBe(2_000);
  });
});
