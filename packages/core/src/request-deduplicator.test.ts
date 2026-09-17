import { RequestDeduplicator } from "./request-deduplicator";

describe("RequestDeduplicator optimizations", () => {
  it("deduplicates structurally equivalent objects with different key order", async () => {
    const deduplicator = new RequestDeduplicator();
    let executions = 0;
    let resolve: (value: string) => void = () => {};
    const first = deduplicator.execute({ b: 2, a: 1 }, () => {
      executions++;
      return new Promise<string>((r) => {
        resolve = r;
      });
    });
    const second = deduplicator.execute({ a: 1, b: 2 }, () => {
      executions++;
      return Promise.resolve("second");
    });

    resolve("first");

    await expect(Promise.all([first, second])).resolves.toEqual([
      "first",
      "first",
    ]);
    expect(executions).toBe(1);
    expect(deduplicator.getStats().savedExecutions).toBe(1);
  });

  it("handles bigint and circular request payloads without throwing", async () => {
    const deduplicator = new RequestDeduplicator();
    const request: Record<string, unknown> = { id: 1n };
    request.self = request;

    await expect(deduplicator.execute(request, async () => "ok")).resolves.toBe(
      "ok",
    );
  });
});
