import { TokenBudgetManager, charsPerToken } from "./token-budget-manager.js";

describe("TokenBudgetManager", () => {
  it("allocates compact budgets for simple tasks with input estimates", () => {
    const manager = new TokenBudgetManager();

    const budget = manager.allocateBudget("List available skills");

    expect(budget.tier).toBe("simple");
    expect(budget.model).toBe("gemini/gemini-3.5-flash-lite");
    expect(budget.estimatedInputTokens).toBeGreaterThan(0);
    expect(budget.reservedOutputTokens).toBeGreaterThan(0);
  });

  it("uses structural complexity rather than task-word keywords", () => {
    const manager = new TokenBudgetManager();
    expect(manager.allocateBudget("Compare this?").tier).toBe("simple");
    const structured = Array.from({ length: 18 }, (_, index) => `step ${index}: { value: [${index}] }`).join("\n");
    expect(manager.allocateBudget("Do this", structured).tier).toBe("complex");
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

    expect(manager.getBestModel("code_generation")).toBe(
      "llama.cpp/local-model",
    );
    expect(manager.getBestModel("classification")).toBe(
      "gemini/gemini-3.5-flash-lite",
    );
  });

  it("suggests cheaper models only when quality remains acceptable", () => {
    const manager = new TokenBudgetManager();

    manager.registerModel({
      name: "paid/quality-model",
      costPer1kTokens: 1,
      speedRank: 3,
      qualityRank: 1,
      bestFor: ["code_generation"],
    });

    const conservative = manager.shouldSwitchModel(
      "paid/quality-model",
      10_000,
      0.95,
    );
    const aggressive = manager.shouldSwitchModel(
      "paid/quality-model",
      10_000,
      0.5,
    );

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

    expect(usage.total_tokens).toBe(128_000);
    expect(usage.compress_at_tokens).toBeGreaterThan(100_000);
    expect(usage.used_percent).toBe(1);
  });
});

describe("script-aware token estimation", () => {
  it("estimates Latin text at about one token per four characters", () => {
    const manager = new TokenBudgetManager();
    expect(manager.estimateTokenCount("a".repeat(400))).toBe(100);
    expect(charsPerToken("a".repeat(400))).toBe(4);
  });

  it("counts Bengali text about one token per character instead of under-counting it", () => {
    const manager = new TokenBudgetManager();
    const bengali = "ক".repeat(400);
    expect(manager.estimateTokenCount(bengali)).toBeGreaterThanOrEqual(400);
    expect(charsPerToken(bengali)).toBe(1);
  });

  it("lands mixed text between the Latin and non-Latin estimates", () => {
    const manager = new TokenBudgetManager();
    const mixed = "ক".repeat(100) + "a".repeat(400);
    const tokens = manager.estimateTokenCount(mixed);
    expect(tokens).toBeGreaterThan(100);
    expect(tokens).toBeLessThan(500);
    expect(charsPerToken(mixed)).toBeGreaterThan(1);
    expect(charsPerToken(mixed)).toBeLessThan(4);
  });

  it("returns zero tokens and four chars per token for empty text", () => {
    const manager = new TokenBudgetManager();
    expect(manager.estimateTokenCount("")).toBe(0);
    expect(charsPerToken("")).toBe(4);
  });
});
