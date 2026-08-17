import { MetricsCollector } from "./metrics-collector";

describe("MetricsCollector optimizations", () => {
  it("records total operation counters with latency samples", () => {
    const metrics = new MetricsCollector();

    metrics.recordLatency("db", 10);
    metrics.recordLatency("db", 20);

    expect(metrics.getCounter("total_db")).toBe(2);
    expect(metrics.getStats("latency_db")).toMatchObject({
      count: 2,
      min: 10,
      max: 20,
    });
  });

  it("keeps latency histograms bounded", () => {
    const metrics = new MetricsCollector();

    for (let i = 0; i < 1_100; i++) {
      metrics.recordLatency("hot_path", i);
    }

    expect(metrics.getStats("latency_hot_path")?.count).toBe(1_000);
  });

  it("rejects invalid metric names and non-finite values", () => {
    const metrics = new MetricsCollector();

    expect(() => metrics.incrementCounter("", 1)).toThrow(/Metric name/);
    expect(() => metrics.incrementCounter("requests", Number.NaN)).toThrow(
      /finite number/,
    );
    expect(() => metrics.setGauge("memory", Number.POSITIVE_INFINITY)).toThrow(
      /finite number/,
    );
    expect(() => metrics.recordLatency("db", -1)).toThrow(
      /must not be negative/,
    );
  });

  it("uses normalized tags consistently for counters and errors", () => {
    const metrics = new MetricsCollector();
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    metrics.recordLatency("request", 12, { route: "/chat", empty: "" });
    metrics.recordError("request", { empty: "", route: "/chat" });

    expect(metrics.getCounter("total_request", { route: "/chat" })).toBe(1);
    expect(metrics.getCounter("errors_request", { route: "/chat" })).toBe(1);
    warnSpy.mockRestore();
  });

  it("returns defensive timeseries copies", () => {
    const metrics = new MetricsCollector();
    metrics.recordLatency("db", 10, { shard: "a" });

    const first = metrics.getTimeseries("latency_db");
    first[0].value = 999;
    first[0].tags!.shard = "mutated";

    const second = metrics.getTimeseries("latency_db");
    expect(second[0].value).toBe(10);
    expect(second[0].tags?.shard).toBe("a");
  });
});
