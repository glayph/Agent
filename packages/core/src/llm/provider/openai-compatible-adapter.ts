import OpenAI from "openai";
import type { LLMResponse } from "@miki/config";
import {
  directProviderClient,
  type DirectProviderConfig,
  fetchDirectProviderModels,
  testDirectProviderConnection,
} from "./catalog.js";
import {
  LLMAPIError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMMissingCredentialError,
} from "./errors.js";
import type {
  LLMProviderAdapter,
  ProviderCompletionRequest,
  ProviderConnectionResult,
  ProviderModel,
} from "./contracts.js";

const clientCache = new Map<string, OpenAI>();

function getClient(provider: DirectProviderConfig, apiKey: string): OpenAI {
  const cacheKey = `${provider.id}:${apiKey}`;
  const existing = clientCache.get(cacheKey);
  if (existing) return existing;
  const client = directProviderClient(provider, apiKey);
  clientCache.set(cacheKey, client);
  return client;
}

function retryDelayMs(message: string): number | null {
  const retryDelay = message.match(/retryDelay['"]?\s*[:=]\s*['"]?(\d+)s/i);
  if (retryDelay) return Number(retryDelay[1]) * 1000;
  const retryAfter = message.match(/retry(?:-|\s*)after['"]?\s*[:=]\s*['"]?(\d+)/i);
  return retryAfter ? Number(retryAfter[1]) * 1000 : null;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String((error as { message?: unknown }).message ?? error);
  }
  return String(error);
}

function statusCode(error: unknown): number {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    return typeof status === "number" ? status : 0;
  }
  return 0;
}

function classifyError(error: unknown, providerId: string): never {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const status = statusCode(error);

  if (
    status === 401 ||
    status === 403 ||
    lower.includes("invalid api key") ||
    lower.includes("incorrect api key") ||
    lower.includes("authentication") ||
    lower.includes("unauthorized")
  ) {
    throw new LLMMissingCredentialError(
      `The API key for ${providerId} was rejected by the provider.`,
      { providerId, status, cause: error },
    );
  }

  if (
    status === 429 ||
    lower.includes("429") ||
    lower.includes("resource_exhausted") ||
    lower.includes("quota")
  ) {
    const delay = retryDelayMs(message);
    const hint = delay ? ` Retry after about ${Math.ceil(delay / 1000)} seconds.` : "";
    throw new LLMRateLimitError(
      `Provider ${providerId} rate limit or quota reached.${hint}`,
      { providerId, status, cause: error },
    );
  }

  if (status === 408 || lower.includes("timeout") || lower.includes("timed out")) {
    throw new LLMTimeoutError(`Provider ${providerId} request timed out.`, {
      providerId,
      status,
      cause: error,
    });
  }

  throw new LLMAPIError(`Provider ${providerId} request failed: ${message}`, {
    providerId,
    status,
    cause: error,
  });
}

export class OpenAICompatibleAdapter implements LLMProviderAdapter {
  readonly providerId = "openai-compatible";

  async complete(request: ProviderCompletionRequest): Promise<LLMResponse> {
    const { provider, model, apiKey, messages, extra } = request;
    if (!apiKey && !provider.emptyApiKeyAllowed) {
      throw new LLMMissingCredentialError(
        `No API key is configured for ${provider.displayName}.`,
        { providerId: provider.id },
      );
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await getClient(provider, apiKey).chat.completions.create({
          model,
          messages,
          temperature: extra?.temperature as number | undefined,
          max_tokens: extra?.max_tokens as number | undefined,
          ...extra,
        });
      } catch (error) {
        lastError = error;
        const message = errorMessage(error).toLowerCase();
        const status = statusCode(error);
        const retryable =
          status === 408 ||
          status >= 500 ||
          message.includes("timeout") ||
          message.includes("temporarily unavailable") ||
          message.includes("connection");
        if (!retryable || attempt === 2) classifyError(error, provider.id);
        const wait = Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    classifyError(lastError, provider.id);
  }

  listModels(provider: DirectProviderConfig, apiKey: string, timeoutMs?: number): Promise<ProviderModel[]> {
    return fetchDirectProviderModels(provider, apiKey, timeoutMs);
  }

  testConnection(
    provider: DirectProviderConfig,
    apiKey: string,
    timeoutMs?: number,
  ): Promise<ProviderConnectionResult> {
    return testDirectProviderConnection(provider, apiKey, timeoutMs);
  }

  clearCache(): void {
    clientCache.clear();
  }
}

export const openAICompatibleAdapter = new OpenAICompatibleAdapter();
