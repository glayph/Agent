import type { ChatMessage, ToolDefinition } from "@hiro/config";
import { CostCalibrator } from "./cost-calibrator.js";
import {
  globalTokenBudgetManager,
  type ContextUsageSnapshot,
  type TaskComplexity,
  type TokenBudgetManager,
} from "./token-budget-manager.js";

const DEFAULT_OUTPUT_CAP = 4_096;

export interface AgentTokenBudgetInput {
  modelName: string;
  userMessage: string;
  messages: ChatMessage[];
  toolsSchema?: ToolDefinition[];
  configuredCycleBudget: number;
  spentBudgetTokens: number;
  defaultMaxTokens?: number;
  manager?: TokenBudgetManager;
}

export interface AgentTokenBudgetSnapshot {
  maxTokens: number;
  shouldCall: boolean;
  inputTokens: number;
  effectiveCycleBudget: number;
  remainingCycleBudget: number;
  contextUsage: ContextUsageSnapshot;
  tier: TaskComplexity;
  suggestedModel: string;
}

export function buildAgentTokenBudget({
  modelName,
  userMessage,
  messages,
  toolsSchema,
  configuredCycleBudget,
  spentBudgetTokens,
  defaultMaxTokens,
  manager = globalTokenBudgetManager,
}: AgentTokenBudgetInput): AgentTokenBudgetSnapshot {
  const contextText = messages
    .map((message) => `${message.role}: ${message.content || ""}`)
    .join("\n");
  const adaptiveBudget = manager.allocateBudget(userMessage, contextText);
  const inputTokens = manager.estimateMessagesTokens(messages, toolsSchema);
  const limits = manager.getModelLimits(modelName);
  const contextReserve = Math.max(
    256,
    Math.min(4_096, Math.ceil(limits.contextWindowTokens * 0.02)),
  );
  const contextAvailableForOutput = Math.max(
    0,
    limits.contextWindowTokens - inputTokens - contextReserve,
  );

  const effectiveCycleBudget = CostCalibrator.effectiveBudget(
    sanePositiveInteger(configuredCycleBudget, DEFAULT_OUTPUT_CAP),
    modelName,
  );
  const remainingCycleBudget = Number.isFinite(effectiveCycleBudget)
    ? Math.max(0, effectiveCycleBudget - Math.max(0, spentBudgetTokens))
    : Number.POSITIVE_INFINITY;

  const configuredOutputCap = sanePositiveInteger(
    defaultMaxTokens,
    DEFAULT_OUTPUT_CAP,
  );
  const boundedOutput = Math.min(
    adaptiveBudget.maxTokens,
    configuredOutputCap,
    limits.maxOutputTokens,
    contextAvailableForOutput,
    remainingCycleBudget,
  );
  const maxTokens = Math.max(0, Math.floor(boundedOutput));

  return {
    maxTokens,
    shouldCall: maxTokens > 0,
    inputTokens,
    effectiveCycleBudget,
    remainingCycleBudget,
    contextUsage: manager.buildContextUsage(modelName, inputTokens),
    tier: adaptiveBudget.tier,
    suggestedModel: adaptiveBudget.model,
  };
}

function sanePositiveInteger(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(128_000, Math.floor(value)));
}
