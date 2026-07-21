/**
 * TokenBudgetManager: Adaptively allocate tokens based on task complexity and cost
 * - Classify task complexity (simple, standard, complex)
 * - Allocate tokens accordingly
 * - Monitor per-model costs and switch models if beneficial
 * - Implement token tier system for cost optimization
 */

export type TaskComplexity = "simple" | "standard" | "complex";

export interface TokenBudget {
  maxTokens: number;
  model: string;
  estimatedCost: number;
  tier: TaskComplexity;
  estimatedInputTokens: number;
  reservedOutputTokens: number;
}

export interface ModelProfile {
  name: string;
  costPer1kTokens: number;
  speedRank: number; // 1 = fastest, 10 = slowest
  qualityRank: number; // 1 = best quality, 10 = lowest
  bestFor: string[]; // task types this model excels at
  contextWindowTokens?: number;
  maxOutputTokens?: number;
}

export interface ModelTokenLimits {
  contextWindowTokens: number;
  maxOutputTokens: number;
}

export interface ContextUsageSnapshot {
  used_tokens: number;
  total_tokens: number;
  compress_at_tokens: number;
  used_percent: number;
}

export interface TokenCountableMessage {
  role?: string;
  content?: string | null;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

export class TokenBudgetManager {
  private modelProfiles: Map<string, ModelProfile> = new Map([
    [
      "openai/gpt-4.1-nano",
      {
        name: "openai/gpt-4.1-nano",
        costPer1kTokens: 0.0004,
        speedRank: 1,
        qualityRank: 5,
        bestFor: ["simple_qa", "classification", "extraction"],
        contextWindowTokens: 1_047_576,
        maxOutputTokens: 32_768,
      },
    ],
    [
      "openai/gpt-4.1-mini",
      {
        name: "openai/gpt-4.1-mini",
        costPer1kTokens: 0.0016,
        speedRank: 2,
        qualityRank: 3,
        bestFor: ["standard_reasoning", "summarization", "translation"],
        contextWindowTokens: 1_047_576,
        maxOutputTokens: 32_768,
      },
    ],
    [
      "openai/gpt-4.1",
      {
        name: "openai/gpt-4.1",
        costPer1kTokens: 0.008,
        speedRank: 3,
        qualityRank: 1,
        bestFor: ["complex_reasoning", "code_generation", "design"],
        contextWindowTokens: 1_047_576,
        maxOutputTokens: 32_768,
      },
    ],
  ]);

  private complexityKeywords = {
    simple: ["count", "list", "what is", "define", "lookup", "fetch", "get"],
    complex: [
      "analyze",
      "reason",
      "compare",
      "debug",
      "design",
      "optimize",
      "improve",
      "refactor",
      "explain how",
      "system prompt",
      "context",
      "mcp",
    ],
  };

  estimateTokenCount(text = ""): number {
    if (!text) return 0;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const charEstimate = Math.ceil(text.length / 4);
    return Math.max(words, charEstimate);
  }

  estimateMessagesTokens(
    messages: TokenCountableMessage[],
    toolsSchema?: unknown,
  ): number {
    const messageText = messages
      .map((message) => {
        const parts = [
          message.role || "",
          message.name || "",
          message.tool_call_id || "",
          message.content || "",
        ];
        if (message.tool_calls) {
          parts.push(this.stringifyForEstimate(message.tool_calls));
        }
        return parts.filter(Boolean).join("\n");
      })
      .join("\n\n");

    const toolTokens = toolsSchema
      ? this.estimateTokenCount(this.stringifyForEstimate(toolsSchema))
      : 0;

    return this.estimateTokenCount(messageText) + toolTokens;
  }

  getModelLimits(model: string): ModelTokenLimits {
    const normalized = this.normalizeModelName(model);
    const exact = this.modelProfiles.get(normalized);
    if (exact?.contextWindowTokens && exact.maxOutputTokens) {
      return {
        contextWindowTokens: exact.contextWindowTokens,
        maxOutputTokens: exact.maxOutputTokens,
      };
    }

    if (normalized.includes("gpt-4.1")) {
      return { contextWindowTokens: 1_047_576, maxOutputTokens: 32_768 };
    }
    if (normalized.includes("gpt-4o") || normalized.includes("gpt-4-turbo")) {
      return { contextWindowTokens: 128_000, maxOutputTokens: 16_384 };
    }
    if (normalized.includes("gpt-4")) {
      return { contextWindowTokens: 8_192, maxOutputTokens: 8_192 };
    }
    if (normalized.includes("gemini-2.")) {
      return { contextWindowTokens: 1_000_000, maxOutputTokens: 8_192 };
    }
    if (normalized.includes("claude-3.")) {
      return { contextWindowTokens: 200_000, maxOutputTokens: 8_192 };
    }
    if (normalized.includes("llama-4")) {
      return { contextWindowTokens: 1_000_000, maxOutputTokens: 8_192 };
    }
    if (normalized.includes("llama-3")) {
      return { contextWindowTokens: 128_000, maxOutputTokens: 8_192 };
    }

    return { contextWindowTokens: 128_000, maxOutputTokens: 4_096 };
  }

  buildContextUsage(model: string, usedTokens: number): ContextUsageSnapshot {
    const limits = this.getModelLimits(model);
    const used = Math.max(0, Math.ceil(usedTokens));
    const total = limits.contextWindowTokens;
    return {
      used_tokens: used,
      total_tokens: total,
      compress_at_tokens: Math.floor(total * 0.85),
      used_percent: Math.min(100, Math.round((used / total) * 100)),
    };
  }

  /**
   * Estimate task complexity based on query and context
   */
  private estimateComplexity(
    query: string,
    context: string = "",
  ): TaskComplexity {
    const text = (query + " " + context).toLowerCase();
    let score = 0;

    // Complexity signals
    for (const keyword of this.complexityKeywords.complex) {
      if (text.includes(keyword)) {
        score += 2;
      }
    }

    for (const keyword of this.complexityKeywords.simple) {
      if (text.includes(keyword)) {
        score -= 1;
      }
    }

    // Context length is a signal
    if (context.length > 10000) score += 2;
    else if (context.length > 5000) score += 1;

    // Question complexity signals
    const questionCount = (query.match(/\?/g) || []).length;
    if (questionCount > 2) score += 1;

    // Multi-step indicators
    if (
      text.includes("first") ||
      text.includes("then") ||
      text.includes("after") ||
      text.includes("step")
    ) {
      score += 1;
    }

    if (score >= 3) return "complex";
    if (score <= -1) return "simple";
    return "standard";
  }

  /**
   * Allocate token budget based on task complexity
   */
  allocateBudget(query: string, context?: string): TokenBudget {
    const complexity = this.estimateComplexity(query, context);
    const estimatedInputTokens = this.estimateTokenCount(
      `${query}\n${context || ""}`,
    );

    const budgets = {
      simple: {
        maxTokens: 300,
        model: "openai/gpt-4.1-nano",
        estimatedCost: 0,
        tier: "simple" as const,
      },
      standard: {
        maxTokens: 1200,
        model: "openai/gpt-4.1-mini",
        estimatedCost: 0,
        tier: "standard" as const,
      },
      complex: {
        maxTokens: 2400,
        model: "openai/gpt-4.1",
        estimatedCost: 0,
        tier: "complex" as const,
      },
    };

    const selected = budgets[complexity];
    const contextPressure = Math.max(0, estimatedInputTokens - 8000);
    const reservedOutputTokens = Math.min(
      Math.max(selected.maxTokens, Math.ceil(estimatedInputTokens * 0.18)),
      complexity === "complex" ? 4096 : 2048,
    );
    const maxTokens =
      contextPressure > 0
        ? Math.max(selected.maxTokens, reservedOutputTokens)
        : selected.maxTokens;

    return {
      ...selected,
      maxTokens,
      reservedOutputTokens,
      estimatedInputTokens,
      estimatedCost: this.estimateCost(
        estimatedInputTokens + maxTokens,
        selected.model,
      ),
    };
  }

  /**
   * Get optimal model for task type
   */
  getBestModel(taskType: string): string {
    let bestModel = "gpt-4o-mini"; // Default
    let bestScore = 0;

    for (const [modelName, profile] of this.modelProfiles) {
      if (profile.bestFor.includes(taskType)) {
        const qualityScore = 11 - profile.qualityRank;
        const speedScore = 11 - profile.speedRank;
        const costScore = 1 / Math.max(profile.costPer1kTokens, 0.000001);
        const score = qualityScore * 3 + speedScore + costScore;
        if (score > bestScore) {
          bestModel = modelName;
          bestScore = score;
        }
      }
    }

    return bestModel;
  }

  /**
   * Estimate cost for a given token count and model
   */
  estimateCost(tokenCount: number, model: string): number {
    const profile = this.modelProfiles.get(model);
    if (!profile) return 0;
    return (tokenCount / 1000) * profile.costPer1kTokens;
  }

  /**
   * Check if switching to a cheaper model would be acceptable
   */
  shouldSwitchModel(
    currentModel: string,
    currentTokens: number,
    qualityThreshold: number = 0.9,
  ): { shouldSwitch: boolean; suggestedModel?: string; savings?: number } {
    const currentProfile = this.modelProfiles.get(currentModel);
    if (!currentProfile) {
      return { shouldSwitch: false };
    }

    const currentCost = this.estimateCost(currentTokens, currentModel);

    // Find cheaper models with acceptable quality
    for (const [modelName, profile] of this.modelProfiles) {
      if (modelName === currentModel) continue;

      const qualityRatio =
        (11 - profile.qualityRank) / (11 - currentProfile.qualityRank);
      if (qualityRatio >= qualityThreshold) {
        const newCost = this.estimateCost(currentTokens, modelName);
        const savings = currentCost - newCost;

        if (savings > 0) {
          return {
            shouldSwitch: true,
            suggestedModel: modelName,
            savings,
          };
        }
      }
    }

    return { shouldSwitch: false };
  }

  /**
   * Register a new model profile
   */
  registerModel(profile: ModelProfile): void {
    this.modelProfiles.set(profile.name, profile);
  }

  /**
   * Get all available models
   */
  getAvailableModels(): ModelProfile[] {
    return Array.from(this.modelProfiles.values());
  }

  private normalizeModelName(model: string): string {
    return model
      .trim()
      .toLowerCase()
      .replace(/^openrouter\//, "")
      .replace(/^gemini\//, "google/gemini/");
  }

  private stringifyForEstimate(value: unknown): string {
    try {
      return JSON.stringify(value) || "";
    } catch {
      return String(value);
    }
  }
}

export const globalTokenBudgetManager = new TokenBudgetManager();
