import {
  AdaptiveMessageCoordinator,
  DEFAULT_ADAPTIVE_MESSAGING_CONFIG,
  chunkContent,
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

  test("long structured response becomes meaningful multi-message output", () => {
    const content = "# Found\n\nThe configuration is missing. This explanation is long enough to make the adaptive planner treat this as meaningful output.\n\n# Fix\n\nI will add the missing configuration, run the relevant checks, and report the verified result without unnecessary fragmentation.";
    const plan = planAdaptiveOutput({ id: "b", channel: "web", kind: "response", content, final: true }, undefined, { ...DEFAULT_ADAPTIVE_MESSAGING_CONFIG, multiMessageMinLength: 80 });
    expect(plan.length).toBe(2);
    expect(plan.map((m) => m.sequence)).toEqual([1, 2]);
    expect(plan[1].final).toBe(true);
  });

  test("channel message limits cause safe chunks", () => {
    const content = `before\n\n\`\`\`json\n${"x".repeat(2500)}\n\`\`\`\n\nafter`;
    const chunks = chunkContent(content, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.some((chunk) => chunk.includes("```json") && chunk.includes("```"))).toBe(true);
  });

  test("web can stream long-running output while discord uses bounded messages", () => {
    const candidate = { id: "c", channel: "web" as const, kind: "response" as const, content: "x".repeat(2400), longRunning: true, streamingRequested: true, final: true };
    expect(chooseMessagingStrategy(candidate, getChannelMessagingCapabilities("web"))).toBe("streaming");
    expect(planAdaptiveOutput({ ...candidate, channel: "discord" }, getChannelMessagingCapabilities("discord"))[0].strategy).toBe("chunked");
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
