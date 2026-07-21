import { DependencyResolver, ToolCall } from "./dependency-resolver.js";

function tool(
  id: string,
  dependencies: string[] = [],
  priority?: number,
): ToolCall {
  return {
    id,
    name: `tool_${id}`,
    input: {},
    dependencies,
    priority,
  };
}

describe("DependencyResolver", () => {
  test("groups independent tools by dependency level", () => {
    const resolver = new DependencyResolver();
    const plan = resolver.resolveDependencies([
      tool("prepare"),
      tool("read"),
      tool("write", ["prepare", "read"]),
      tool("verify", ["write"]),
    ]);

    expect(plan.levels.map((level) => level.map((item) => item.id))).toEqual([
      ["prepare", "read"],
      ["write"],
      ["verify"],
    ]);
    expect(plan.parallelizable).toBe(true);
    expect(plan.totalLevels).toBe(3);
  });

  test("rejects missing dependencies", () => {
    const resolver = new DependencyResolver();

    expect(() =>
      resolver.resolveDependencies([tool("write", ["missing"])]),
    ).toThrow('Tool "write" depends on missing tool "missing"');
  });

  test("rejects duplicate and empty tool ids", () => {
    const resolver = new DependencyResolver();

    expect(() =>
      resolver.resolveDependencies([tool("same"), tool("same")]),
    ).toThrow("Duplicate tool id");
    expect(() => resolver.resolveDependencies([tool("")])).toThrow(
      "empty tool id",
    );
  });

  test("rejects self dependencies and cycles", () => {
    const resolver = new DependencyResolver();

    expect(() =>
      resolver.resolveDependencies([tool("self", ["self"])]),
    ).toThrow("cannot depend on itself");
    expect(() =>
      resolver.resolveDependencies([tool("a", ["b"]), tool("b", ["a"])]),
    ).toThrow("Circular dependency detected");
  });

  test("executes levels in dependency order and exposes completed results", async () => {
    const resolver = new DependencyResolver();
    const seen: string[] = [];

    const results = await resolver.executeInOrder(
      [tool("a"), tool("b", ["a"]), tool("c", ["a"]), tool("d", ["b", "c"])],
      async (call, priorResults) => {
        seen.push(call.id);
        if (call.id === "d") {
          expect(priorResults.get("b")).toBe("result:b");
          expect(priorResults.get("c")).toBe("result:c");
        }
        return `result:${call.id}`;
      },
    );

    expect(seen[0]).toBe("a");
    expect(seen.at(-1)).toBe("d");
    expect(results.get("d")).toBe("result:d");
  });

  test("preserves dependency levels while sorting each level by priority", () => {
    const resolver = new DependencyResolver();

    expect(
      resolver
        .optimizeByPriority([
          tool("low", [], 50),
          tool("high", [], 1),
          tool("dependent", ["low"], 0),
        ])
        .map((item) => item.id),
    ).toEqual(["high", "low", "dependent"]);
  });
});
