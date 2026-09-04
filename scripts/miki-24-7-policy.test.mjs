import test from "node:test";
import assert from "node:assert/strict";
import {
  computeRestartDelay,
  DEFAULT_MAX_RESTARTS,
  DEFAULT_RESTART_RESET_AFTER_MS,
  resolveMaxRestarts,
  resolvePositiveDuration,
  restartLimitReached,
} from "./miki-24-7-policy.mjs";

test("defaults to bounded restarts and rejects implicit unlimited mode", () => {
  assert.equal(resolveMaxRestarts({}), DEFAULT_MAX_RESTARTS);
  assert.equal(resolveMaxRestarts({ MIKI_24_7_MAX_RESTARTS: "0" }), DEFAULT_MAX_RESTARTS);
  assert.equal(
    resolveMaxRestarts({
      MIKI_24_7_MAX_RESTARTS: "0",
      MIKI_24_7_ALLOW_UNLIMITED_RESTARTS: "true",
    }),
    0,
  );
  assert.equal(resolveMaxRestarts({ MIKI_24_7_MAX_RESTARTS: "3.8" }), 3);
});

test("computes capped exponential backoff and restart limit", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 8].map((count) => computeRestartDelay(count, 10_000)),
    [1_000, 2_000, 4_000, 8_000, 10_000],
  );
  assert.equal(restartLimitReached(5, 5), false);
  assert.equal(restartLimitReached(5, 6), true);
  assert.equal(restartLimitReached(0, 100), false);
});

test("uses safe duration fallback for invalid values", () => {
  assert.equal(resolvePositiveDuration("", DEFAULT_RESTART_RESET_AFTER_MS), DEFAULT_RESTART_RESET_AFTER_MS);
  assert.equal(resolvePositiveDuration("500", 10_000), 10_000);
  assert.equal(resolvePositiveDuration("12000", 10_000), 12_000);
});
