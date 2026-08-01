import { TokenBudgetManager } from "./token-budget-manager.js";

describe("TokenBudgetManager", () => {
  it("allocates compact budgets for simple tasks with input estimates", () => {
    const manager = new TokenBudgetManager();

    const budget = manager.allocateBudget("List available skills");

    expect(budget.tier).toBe("simple");
    expect(budget.model).toBe("openai/gpt-4.1-nano");
    expect(budget.estimatedInputTokens).toBeGreaterThan(0);
    expect(budget.reservedOutputTokens).toBeGreaterThan(0);
  });

  it("reserves more output budget under high context pressure", () => {
    const manager = new TokenBudgetManager();
    const context = "context ".repeat(12000);

    const budget = manager.allocateBudget(
      "Optimize plugin skills MCP and system prompt integration",
      context,
    );

    expect(budget.tier).toBe("complex");
    expect(budget.maxTokens).toBeGreaterThanOrEqual(2400);
    expect(budget.reservedOutputTokens).toBeLessThanOrEqual(4096);
  });

  it("scores best-for models using quality, speed, and cost in the right direction", () => {
    const manager = new TokenBudgetManager();

    expect(manager.getBestModel("code_generation")).toBe("openai/gpt-4.1");
    expect(manager.getBestModel("classification")).toBe("openai/gpt-4.1-nano");
  });

  it("suggests cheaper models only when quality remains acceptable", () => {
    const manager = new TokenBudgetManager();

    const conservative = manager.shouldSwitchModel("openai/gpt-4.1", 10_000);
    const aggressive = manager.shouldSwitchModel("openai/gpt-4.1", 10_000, 0.5);

    expect(conservative.shouldSwitch).toBe(false);
    expect(aggressive.shouldSwitch).toBe(true);
    expect(aggressive.savings).toBeGreaterThan(0);
  });

  it("estimates message and tool schema tokens for runtime context accounting", () => {
    const manager = new TokenBudgetManager();

    const tokens = manager.estimateMessagesTokens(
      [
        { role: "system", content: "Follow concise instructions." },
        { role: "user", content: "Inspect these files and summarize risk." },
      ],
      [
        {
          type: "function",
          function: {
            name: "file_read",
            description: "Read a workspace file",
            parameters: { type: "object", properties: { path: {} } },
          },
        },
      ],
    );

    expect(tokens).toBeGreaterThan(20);
  });

  it("resolves model-aware context usage snapshots", () => {
    const manager = new TokenBudgetManager();

    const usage = manager.buildContextUsage("openrouter/openai/gpt-4.1", 1200);

    expect(usage.total_tokens).toBe(1_047_576);
    expect(usage.compress_at_tokens).toBeGreaterThan(800_000);
    expect(usage.used_percent).toBe(0);
  });
});
