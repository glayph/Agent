import {
  AdaptiveMessageCoordinator,
  DEFAULT_ADAPTIVE_MESSAGING_CONFIG,
  chooseMessagingStrategy,
  getChannelMessagingCapabilities,
  planAdaptiveOutput,
} from "./messaging-adaptive.js";

describe("adaptive messaging", () => {
  test("simple response stays one message", () => {
    const plan = planAdaptiveOutput({ id: "a", channel: "web", kind: "response", content: "Done.", final: true });
    expect(plan).toHaveLength(1);
    expect(plan[0].strategy).toBe("single");
  });

  test("a long structured response within the channel limit is never split", () => {
    const content = "# Found\n\nThe configuration is missing. This explanation is long enough to be treated as meaningful output.\n\n# Fix\n\nI will add the missing configuration, run the relevant checks, and report the verified result without fragmentation.";
    const plan = planAdaptiveOutput({ id: "b", channel: "web", kind: "response", content, final: true });
    expect(plan).toHaveLength(1);
    expect(plan[0].strategy).toBe("single");
    expect(plan[0].content).toBe(content);
  });

  test("a very long reply is never split on any channel", () => {
    const content = `before\n\n\`\`\`json\n${"x".repeat(25000)}\n\`\`\`\n\nafter`;
    for (const channel of ["web", "discord", "telegram"] as const) {
      const plan = planAdaptiveOutput({ id: "long", channel, kind: "response", content, final: true });
      expect(plan).toHaveLength(1);
      expect(plan[0].strategy).toBe("single");
      expect(plan[0].content).toBe(content);
    }
  });

  test("web can stream long-running output", () => {
    const candidate = { id: "c", channel: "web" as const, kind: "response" as const, content: "x".repeat(2400), longRunning: true, streamingRequested: true, final: true };
    expect(chooseMessagingStrategy(candidate, getChannelMessagingCapabilities("web"))).toBe("streaming");
    expect(planAdaptiveOutput({ ...candidate, channel: "discord" }, getChannelMessagingCapabilities("discord"))[0].strategy).toBe("single");
  });

  test("coordinator suppresses duplicate delivery and throttles progress", () => {
    const coordinator = new AdaptiveMessageCoordinator();
    const candidate = { id: "d", runId: "run-1", channel: "web" as const, kind: "response" as const, content: "hello", final: true };
    const first = coordinator.plan(candidate);
    expect(first).toHaveLength(1);
    coordinator.markEmitted(first[0]);
    expect(coordinator.plan(candidate)).toHaveLength(0);
    expect(coordinator.canEmitProgress("run-1:progress", 2000)).toBe(true);
    expect(coordinator.canEmitProgress("run-1:progress", 2500)).toBe(false);
    expect(coordinator.canEmitProgress("run-1:progress", 4000)).toBe(true);
  });
});
