import OpenAI from "openai";
import { settings } from "@hiro/config";
import { MODEL_COSTS } from "./cost-calibrator.js";
import { litellmBaseUrlFromEnv } from "./litellm-config.js";
import { resolveLiteLLMMasterKey } from "@hiro/config/security";

export class LiteLLMError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMError";
  }
}
export class LiteLLMRateLimitError extends LiteLLMError {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMRateLimitError";
  }
}
export class LiteLLMTimeoutError extends LiteLLMError {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMTimeoutError";
  }
}
export class LiteLLMAPIError extends LiteLLMError {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMAPIError";
  }
}

export type Provider = "litellm";

function mapModelName(model: string): string {
  if (model.startsWith("google/")) {
    return model.replace(/^google\//, "gemini/");
  }
  return model;
}

let openaiClient: OpenAI | null = null;

function getOpenAIClient(): OpenAI {
  if (openaiClient) return openaiClient;

  const masterKeyDir = process.env["Hiro_WORKSPACE_DIR"] || process.cwd();
  openaiClient = new OpenAI({
    baseURL: litellmBaseUrlFromEnv(),
    apiKey: resolveLiteLLMMasterKey({ workspaceDir: masterKeyDir }),
    timeout: settings.defaultTimeout * 1000,
    maxRetries: 0,
  });
  return openaiClient;
}

export function updateClient(): void {
  openaiClient = null; // Force recreation if configuration changes
}

export async function achatCompletion(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  extra?: Record<string, unknown>,
): Promise<import("@hiro/config").LLMResponse> {
  const maxRetries = 3;
  let lastError: Error | null = null;
  const mappedModel = mapModelName(settings.defaultModel);

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const apiClient = getOpenAIClient();
      return await apiClient.chat.completions.create({
        model: mappedModel,
        messages: messages,
        temperature: settings.defaultTemperature,
        max_tokens: settings.defaultMaxTokens,
        ...extra,
      });
    } catch (err: unknown) {
      lastError = err as Error;
      const isOpenAIError =
        typeof err === "object" && err !== null && "status" in err;
      const status =
        isOpenAIError && typeof err === "object"
          ? ((err as Record<string, unknown>).status as number)
          : 0;
      const errStr =
        (typeof err === "object" && err !== null && "message" in err
          ? String((err as Record<string, unknown>).message)
          : String(err)) || "";

      const isRetryable =
        status === 429 ||
        errStr.toLowerCase().includes("rate") ||
        errStr.toLowerCase().includes("timeout") ||
        errStr.toLowerCase().includes("429") ||
        errStr.toLowerCase().includes("quota");

      if (attempt < maxRetries - 1 && isRetryable) {
        const baseMs = Math.pow(2, attempt) * 1000;
        const waitMs = baseMs / 2 + Math.random() * (baseMs / 2);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      let error: LiteLLMError;
      if (status === 429) error = new LiteLLMRateLimitError(errStr);
      else if (errStr.toLowerCase().includes("timeout"))
        error = new LiteLLMTimeoutError(errStr);
      else error = new LiteLLMAPIError(errStr);
      (error as LiteLLMError & { cause?: unknown }).cause = err;
      throw error;
    }
  }
  throw lastError || new LiteLLMAPIError("Unknown error in achatCompletion");
}

export function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const normalized = model.replace(/^openrouter\//, "");
  const candidates = [
    model,
    normalized,
    normalized.replace(/^gemini\//, "google/"),
  ];
  const costs = candidates
    .map((candidate) => MODEL_COSTS[candidate])
    .find(Boolean);

  if (!costs) return 0;
  return Number(
    (promptTokens * costs.prompt + completionTokens * costs.completion).toFixed(
      8,
    ),
  );
}
