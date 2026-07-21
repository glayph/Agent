import type { ChatMessage } from "@hiro/config";
import { buildAgentTokenBudget } from "./agent-token-budget.js";

describe("buildAgentTokenBudget", () => {
  const baseMessages: ChatMessage[] = [
    { role: "system", content: "You are concise." },
    { role: "user", content: "List available skills" },
  ];

  it("uses compact output caps for simple tasks", () => {
    const budget = buildAgentTokenBudget({
      modelName: "openai/gpt-4.1-mini",
      userMessage: "List available skills",
      messages: baseMessages,
      configuredCycleBudget: 4096,
      spentBudgetTokens: 0,
      defaultMaxTokens: 4096,
    });

    expect(budget.shouldCall).toBe(true);
    expect(budget.maxTokens).toBeLessThanOrEqual(300);
    expect(budget.contextUsage.total_tokens).toBe(1_047_576);
  });

  it("honors the remaining cost-calibrated cycle budget", () => {
    const budget = buildAgentTokenBudget({
      modelName: "openai/gpt-4.1",
      userMessage: "Analyze and optimize this implementation",
      messages: baseMessages,
      configuredCycleBudget: 4096,
      spentBudgetTokens: 6100,
      defaultMaxTokens: 4096,
    });

    expect(budget.remainingCycleBudget).toBeGreaterThan(0);
    expect(budget.maxTokens).toBeLessThanOrEqual(budget.remainingCycleBudget);
  });

  it("stops before a request when the model context window is exhausted", () => {
    const hugeMessages: ChatMessage[] = [
      { role: "system", content: "A".repeat(50_000) },
      { role: "user", content: "Continue" },
    ];

    const budget = buildAgentTokenBudget({
      modelName: "openai/gpt-4",
      userMessage: "Continue",
      messages: hugeMessages,
      configuredCycleBudget: 4096,
      spentBudgetTokens: 0,
      defaultMaxTokens: 4096,
    });

    expect(budget.shouldCall).toBe(false);
    expect(budget.maxTokens).toBe(0);
  });
});
