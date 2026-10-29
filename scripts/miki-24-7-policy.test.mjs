import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRestartDelay,
  DEFAULT_MAX_BACKOFF_MS,
  DEFAULT_RESTART_RESET_AFTER_MS,
  MAX_BACKOFF_CEILING_MS,
  resolveMaxBackoffMs,
  resolvePositiveDuration,
} from "./miki-24-7-policy.mjs";
import * as policy from "./miki-24-7-policy.mjs";

test("restarts are unlimited: no restart limit exists in the policy", () => {
  assert.equal(policy.resolveMaxRestarts, undefined);
  assert.equal(policy.restartLimitReached, undefined);
  assert.equal(policy.DEFAULT_MAX_RESTARTS, undefined);
});

test("backoff cap defaults to and never exceeds three minutes", () => {
  assert.equal(DEFAULT_MAX_BACKOFF_MS, 180_000);
  assert.equal(MAX_BACKOFF_CEILING_MS, 180_000);
  assert.equal(resolveMaxBackoffMs(undefined), 180_000);
  assert.equal(resolveMaxBackoffMs("30000"), 30_000);
  assert.equal(resolveMaxBackoffMs("900000"), 180_000);
  assert.equal(resolveMaxBackoffMs("not-a-number"), 180_000);
  assert.equal(resolveMaxBackoffMs("500"), 180_000);
});

test("computes capped exponential backoff that reaches the three minute cap", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 8].map((count) => computeRestartDelay(count, 10_000)),
    [1_000, 2_000, 4_000, 8_000, 10_000],
  );
  // 1s, 2s, 4s ... 64s, 128s, then 180s (3 minutes) forever.
  assert.deepEqual(
    [6, 7, 8, 9, 50, 1_000_000].map((count) => computeRestartDelay(count)),
    [32_000, 64_000, 128_000, 180_000, 180_000, 180_000],
  );
  assert.equal(computeRestartDelay(30, 900_000), 180_000);
  assert.equal(computeRestartDelay(Number.POSITIVE_INFINITY), 180_000);
});

test("uses safe duration fallback for invalid values", () => {
  assert.equal(resolvePositiveDuration("", DEFAULT_RESTART_RESET_AFTER_MS), DEFAULT_RESTART_RESET_AFTER_MS);
  assert.equal(resolvePositiveDuration("500", 10_000), 10_000);
  assert.equal(resolvePositiveDuration("12000", 10_000), 12_000);
});
