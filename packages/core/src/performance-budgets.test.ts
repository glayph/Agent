import {
  PerformanceBudgetChecker,
  StartupTimer,
} from "./performance-budgets.js";

describe("performance budgets", () => {
  it("records timings and detects exceeded budgets", () => {
    const timer = new StartupTimer();
    timer.measure("startup.core", () => undefined);

    const checker = new PerformanceBudgetChecker([
      { name: "startup.core", maxMs: 1000 },
      { name: "bundle.initial", maxBytes: 1024 },
    ]);
    const results = [
      ...checker.checkTimings(timer.report()),
      ...checker.checkSizes({ "bundle.initial": 2048 }),
    ];

    expect(results.find((item) => item.name === "startup.core")?.passed).toBe(
      true,
    );
    expect(results.find((item) => item.name === "bundle.initial")?.passed).toBe(
      false,
    );
    expect(() => checker.assert(results)).toThrow(
      /Performance budget exceeded/,
    );
  });
});
