import OpenAI from "openai";
import { settings, resolveConfiguredSecret, readMikiEnv } from "@miki/config";
import { MODEL_COSTS } from "./cost-calibrator.js";
import {
  directProviderForModel,
  getDirectProviderById,
  normalizeDirectModelName,
  resolveProviderApiKey,
  directProviderClient,
  type DirectProviderConfig,
} from "./providers/provider-controller.js";
import { claudeNativeCompletion } from "./providers/claude-native.js";

/**
 * When true, the "claude" provider routes through the native @anthropic-ai/sdk
 * path instead of the OpenAI-compatible endpoint. Controlled by the env var
 * CLAUDE_NATIVE (set to "0" or "false" to disable and fall back to the
 * OpenAI-compat path). Default: enabled.
 */
function isClaudeNativeEnabled(): boolean {
  const val = process.env["CLAUDE_NATIVE"];
  if (val === undefined || val === null) return true; // on by default
  return val !== "0" && val.toLowerCase() !== "false";
}

export class LLMProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LLMProviderError";
  }
}
export class LLMRateLimitError extends LLMProviderError {
  constructor(message: string) {
    super(message);
    this.name = "LLMRateLimitError";
  }
}
export class LLMTimeoutError extends LLMProviderError {
  constructor(message: string) {
    super(message);
    this.name = "LLMTimeoutError";
  }
}
export class LLMAPIError extends LLMProviderError {
  constructor(message: string) {
    super(message);
    this.name = "LLMAPIError";
  }
}
export class LLMMissingCredentialError extends LLMProviderError {
  constructor(message: string) {
    super(message);
    this.name = "LLMMissingCredentialError";
  }
}

export class LiteLLMError extends LLMProviderError {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMError";
  }
}
export class LiteLLMRateLimitError extends LLMRateLimitError {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMRateLimitError";
  }
}
export class LiteLLMTimeoutError extends LLMTimeoutError {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMTimeoutError";
  }
}
export class LiteLLMAPIError extends LLMAPIError {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMAPIError";
  }
}
export class LiteLLMMissingCredentialError extends LLMMissingCredentialError {
  constructor(message: string) {
    super(message);
    this.name = "LiteLLMMissingCredentialError";
  }
}

export type Provider = "gemini" | "openai" | "openrouter";

function workspaceDir(): string {
  return readMikiEnv("MIKI_WORKSPACE_DIR") || process.cwd();
}

function providerForModel(model: string): DirectProviderConfig | undefined {
  return directProviderForModel(model);
}

function providerApiKeyEnv(model: string): string | null {
  const provider = directProviderForModel(model);
  return provider ? provider.apiKeyEnv : null;
}

function setupMessage(envKey: string, model: string): string {
  return [
    `No API key is configured for ${model}.`,
    `Open Credentials in the dashboard or run "mikiagent config set ${envKey} <your key>".`,
    "The key is stored in your user profile, not in the project .env file.",
  ].join(" ");
}

function extractRetryDelayMs(message: string): number | null {
  const retryDelay = message.match(/retryDelay['"]?\s*[:=]\s*['"]?(\d+)s/i);
  if (retryDelay) return Number(retryDelay[1]) * 1000;
  const retryAfter = message.match(
    /retry(?:-|\s*)after['"]?\s*[:=]\s*['"]?(\d+)/i,
  );
  if (retryAfter) return Number(retryAfter[1]) * 1000;
  return null;
}

const clients = new Map<string, OpenAI>();

function getClient(provider: DirectProviderConfig, apiKey: string): OpenAI {
  const cacheKey = `${provider.id}:${apiKey}`;
  const existing = clients.get(cacheKey);
  if (existing) return existing;
  const client = directProviderClient(provider, apiKey);
  clients.set(cacheKey, client);
  return client;
}

export function updateClient(): void {
  clients.clear();
}

export async function achatCompletion(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  extra?: Record<string, unknown>,
): Promise<import("@miki/config").LLMResponse> {
  const maxRetries = 3;
  let lastError: Error | null = null;
  const modelName = settings.defaultModel;
  const provider = providerForModel(modelName);
  if (!provider) {
    throw new LLMMissingCredentialError(
      `No supported provider matches model "${modelName}". Supported providers: Gemini, OpenAI, OpenRouter.`,
    );
  }
  const apiKey = resolveProviderApiKey(provider, workspaceDir());
  if (!apiKey && !provider.emptyApiKeyAllowed) {
    throw new LLMMissingCredentialError(
      setupMessage(provider.apiKeyEnv, modelName),
    );
  }
  const mappedModel = normalizeDirectModelName(provider.id, modelName);

  // Route claude provider through native @anthropic-ai/sdk when enabled.
  // The native path handles its own retry loop, so we call it once and
  // return directly — no need for the OpenAI-compat retry loop below.
  if (provider.id === "claude" && isClaudeNativeEnabled()) {
    return claudeNativeCompletion(
      messages as Parameters<typeof claudeNativeCompletion>[0],
      mappedModel,
      apiKey ?? "",
      extra,
    );
  }

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const apiClient = getClient(provider, apiKey);
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
        status !== 429 &&
        !errStr.toLowerCase().includes("resource_exhausted") &&
        !errStr.toLowerCase().includes("quota") &&
        !errStr.toLowerCase().includes("429") &&
        (errStr.toLowerCase().includes("rate") ||
          errStr.toLowerCase().includes("timeout"));

      if (
        status === 401 ||
        status === 403 ||
        errStr.toLowerCase().includes("invalid api key") ||
        errStr.toLowerCase().includes("incorrect api key") ||
        errStr.toLowerCase().includes("authentication") ||
        errStr.toLowerCase().includes("unauthorized")
      ) {
        const envKey = provider.apiKeyEnv;
        const authMessage = [
          `The API key for ${modelName} was rejected by the provider.`,
          "Open Credentials in the dashboard or run",
          `"mikiagent config set ${envKey} <your key>" with a valid key.`,
        ].join(" ");
        throw new LLMMissingCredentialError(authMessage);
      }

      if (
        status === 429 ||
        errStr.toLowerCase().includes("429") ||
        errStr.toLowerCase().includes("resource_exhausted") ||
        errStr.toLowerCase().includes("quota")
      ) {
        const retryMs = extractRetryDelayMs(errStr);
        const retryText = retryMs
          ? ` Try again after about ${Math.ceil(retryMs / 1000)} seconds.`
          : "";
        const quotaMessage = [
          "Maybe Quota has been exhausted.",
          "Retrying in a loop.",
          retryText,
          "Wait for quota to reset, enable billing, lower traffic, OR configure another provider/model as a fallback.",
        ].join(" ");
        const error = new LLMRateLimitError(
          quotaMessage.replace(/\s+/g, " ").trim(),
        );
        (error as LLMProviderError & { cause?: unknown }).cause = err;
        throw error;
      }

      if (attempt < maxRetries - 1 && isRetryable) {
        const baseMs = Math.pow(2, attempt) * 1000;
        const waitMs = baseMs / 2 + Math.random() * (baseMs / 2);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }

      let error: LLMProviderError;
      if (status === 429) error = new LLMRateLimitError(errStr);
      else if (errStr.toLowerCase().includes("timeout"))
        error = new LLMTimeoutError(errStr);
      else error = new LLMAPIError(errStr);
      (error as LLMProviderError & { cause?: unknown }).cause = err;
      throw error;
    }
  }
  throw lastError || new LLMAPIError("Unknown error in achatCompletion");
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

export function getDirectProviderByIdPublic(id: string) {
  return getDirectProviderById(id);
}
