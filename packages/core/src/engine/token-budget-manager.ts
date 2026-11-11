/**
 * TokenBudgetManager: Adaptively allocate tokens based on task complexity and cost
 * - Classify task complexity (simple, standard, complex)
 * - Allocate tokens accordingly
 * - Monitor per-model costs and switch models if beneficial
 * - Implement token tier system for cost optimization
 */

import { settings } from "@miki/config";

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

/** Code points above this value are treated as non-Latin (Bengali, Devanagari, CJK, emoji, ...). */
const LATIN_CODE_POINT_LIMIT = 0x024f;

interface ScriptCounts {
  codePoints: number;
  nonLatin: number;
}

function countScripts(text: string): ScriptCounts {
  let codePoints = 0;
  let nonLatin = 0;
  for (const ch of text) {
    codePoints += 1;
    if ((ch.codePointAt(0) ?? 0) > LATIN_CODE_POINT_LIMIT) nonLatin += 1;
  }
  return { codePoints, nonLatin };
}

/**
 * Characters per token for a piece of text, between 1 and 4.
 * Latin text is about 4 characters per token. Bengali and other non-Latin scripts cost about one
 * token per character, so the value falls toward 1 as the non-Latin share grows. This is the single
 * conversion used for every token <-> character budget in the runtime.
 */
export function charsPerToken(text: string): number {
  if (!text) return 4;
  const { codePoints, nonLatin } = countScripts(text);
  if (codePoints === 0) return 4;
  const tokens = nonLatin + (codePoints - nonLatin) / 4;
  return Math.min(4, Math.max(1, codePoints / tokens));
}

export class TokenBudgetManager {
  private modelProfiles: Map<string, ModelProfile> = new Map([
    [
      "gemini/gemini-3.5-flash-lite",
      {
        name: "gemini/gemini-3.5-flash-lite",
        costPer1kTokens: 0,
        speedRank: 1,
        qualityRank: 3,
        bestFor: [
          "simple_qa",
          "classification",
          "extraction",
          "standard_reasoning",
        ],
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 8_192,
      },
    ],
    [
      "llama.cpp/local-model",
      {
        name: "llama.cpp/local-model",
        costPer1kTokens: 0,
        speedRank: 2,
        qualityRank: 2,
        bestFor: ["code_generation", "complex_reasoning", "debugging"],
        contextWindowTokens: 128_000,
        maxOutputTokens: 8_192,
      },
    ],
  ]);

  estimateTokenCount(text = ""): number {
    if (!text) return 0;
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    // Latin text is about 4 characters per token. Bengali and other non-Latin scripts cost about one
    // token per character or more, so they are counted per character instead of being under-counted.
    const { codePoints, nonLatin } = countScripts(text);
    const charEstimate = Math.ceil((codePoints - nonLatin) / 4) + nonLatin;
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

    if (normalized.includes("gemini-")) {
      return { contextWindowTokens: 1_000_000, maxOutputTokens: 8_192 };
    }
    if (normalized.includes("llama") || normalized.includes("local-model")) {
      return { contextWindowTokens: 128_000, maxOutputTokens: 8_192 };
    }

    return { contextWindowTokens: 128_000, maxOutputTokens: 4_096 };
  }

  buildContextUsage(
    model: string,
    usedTokens: number,
    options: { contextWindowTokens?: number; compressPercent?: number } = {},
  ): ContextUsageSnapshot {
    const limits = this.getModelLimits(model);
    const configuredTotal = Number(options.contextWindowTokens);
    const total =
      Number.isFinite(configuredTotal) && configuredTotal > 0
        ? Math.max(1_024, Math.min(1_000_000, Math.floor(configuredTotal)))
        : limits.contextWindowTokens;
    const configuredPercent = Number(options.compressPercent);
    const compressPercent = Number.isFinite(configuredPercent)
      ? Math.max(50, Math.min(95, configuredPercent))
      : 85;
    const used = Math.max(0, Math.ceil(usedTokens));
    return {
      used_tokens: used,
      total_tokens: total,
      compress_at_tokens: Math.floor(total * (compressPercent / 100)),
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
    const normalizedQuery = query.trim();
    const queryTokens = this.estimateTokenCount(normalizedQuery);
    const contextTokens = this.estimateTokenCount(context);
    const nonEmptyLines = `${normalizedQuery}\n${context}`.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    const questionCount = (normalizedQuery.match(/[?？]/g) || []).length;
    const codeSignalCount = (context.match(/[{}()[\]<>;`]/g) || []).length;
    let score = 0;

    // Structural signals only: no task words or hard-coded natural-language keyword list.
    if (contextTokens > 5_000) score += 2;
    else if (contextTokens > 1_500) score += 1;
    if (contextTokens > 5_000 && queryTokens > 8) score += 1;
    if (queryTokens > 1_000) score += 2;
    else if (queryTokens > 250) score += 1;
    if (nonEmptyLines > 12) score += 2;
    else if (nonEmptyLines > 4) score += 1;
    if (questionCount > 2) score += 1;
    if (codeSignalCount > 80) score += 2;
    else if (codeSignalCount > 20) score += 1;

    if (queryTokens <= 12 && contextTokens === 0 && questionCount <= 1) score -= 2;
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
        model: "gemini/gemini-3.5-flash-lite",
        estimatedCost: 0,
        tier: "simple" as const,
      },
      standard: {
        maxTokens: 1200,
        model: "gemini/gemini-3.5-flash-lite",
        estimatedCost: 0,
        tier: "standard" as const,
      },
      complex: {
        maxTokens: 2400,
        model: "llama.cpp/local-model",
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
    let bestModel = settings.defaultModel; // Centralized provider-aware default
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
    return model.trim().toLowerCase();
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
