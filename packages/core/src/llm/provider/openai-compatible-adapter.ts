import OpenAI from "openai";
import { randomUUID } from "node:crypto";
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
  LLMEntitlementError,
  type LLMProviderDiagnostic,
} from "./errors.js";
import type {
  LLMProviderAdapter,
  ProviderCompletionRequest,
  ProviderConnectionResult,
  ProviderModel,
} from "./contracts.js";
import { normalizeGeminiExtra } from "./gemini-compat.js";

const clientCache = new Map<string, OpenAI>();

function defaultTimeoutMs(provider: DirectProviderConfig): number {
  if (provider.id === "llama.cpp") {
    const configured = Number.parseInt(
      process.env.MIKI_LOCAL_LLM_TIMEOUT_MS || "300000",
      10,
    );
    return Number.isFinite(configured) && configured >= 90_000
      ? configured
      : 300_000;
  }
  return 120_000;
}

function getClient(
  provider: DirectProviderConfig,
  apiKey: string,
  timeoutMs?: number,
): OpenAI {
  const effectiveTimeout = timeoutMs ?? defaultTimeoutMs(provider);
  const cacheKey = `${provider.id}:${apiKey}:${effectiveTimeout}`;
  const existing = clientCache.get(cacheKey);
  if (existing) return existing;
  const client = directProviderClient(provider, apiKey, effectiveTimeout);
  clientCache.set(cacheKey, client);
  return client;
}

function retryDelayMs(message: string): number | null {
  const retryDelay = message.match(/retryDelay['"]?\s*[:=]\s*['"]?(\d+)s/i);
  if (retryDelay) return Number(retryDelay[1]) * 1000;
  const retryAfter = message.match(
    /retry(?:-|\s*)after['"]?\s*[:=]\s*['"]?(\d+)/i,
  );
  return retryAfter ? Number(retryAfter[1]) * 1000 : null;
}

function errorMessage(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const value = error as {
      message?: unknown;
      error?: { message?: unknown; code?: unknown } | unknown;
      response?: { data?: unknown };
      body?: unknown;
    };
    const candidates: unknown[] = [
      value.message,
      typeof value.error === "object" && value.error !== null
        ? (value.error as { message?: unknown; code?: unknown }).message
        : value.error,
      value.response?.data,
      value.body,
    ];
    const meaningful = candidates.find((candidate) => {
      if (candidate === undefined || candidate === null) return false;
      if (typeof candidate === "string") return candidate.trim().length > 0;
      if (typeof candidate === "object")
        return Object.keys(candidate as object).length > 0;
      return true;
    });
    if (meaningful !== undefined) {
      return typeof meaningful === "string"
        ? meaningful
        : JSON.stringify(meaningful);
    }
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

function sanitizeDetail(message: string): string {
  return message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(
      /(api[_-]?key|token|authorization)[=:]\s*[^\s,;]+/gi,
      "$1=[redacted]",
    )
    .replace(/https?:\/\/[^\s]+/gi, "[endpoint]")
    .slice(0, 240);
}

export function classifyError(
  error: unknown,
  providerId: string,
  diagnostic: LLMProviderDiagnostic,
): never {
  const message = errorMessage(error);
  const lower = message.toLowerCase();
  const status = statusCode(error);

  const entitlementBlocked =
    lower.includes("no payment method") ||
    lower.includes("payment method required") ||
    lower.includes("payment required") ||
    lower.includes("billing") ||
    lower.includes("creditserror") ||
    lower.includes("insufficient credits") ||
    lower.includes("entitlement") ||
    lower.includes("subscription required");
  if (entitlementBlocked) {
    throw new LLMEntitlementError(
      `Provider ${providerId} requires an active payment method, credits, or subscription before completion.`,
      { providerId, status, cause: error, diagnostic },
    );
  }

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
      { providerId, status, cause: error, diagnostic },
    );
  }

  if (
    status === 429 ||
    lower.includes("429") ||
    lower.includes("resource_exhausted") ||
    lower.includes("quota")
  ) {
    const delay = retryDelayMs(message);
    const hint = delay
      ? ` Retry after about ${Math.ceil(delay / 1000)} seconds.`
      : "";
    throw new LLMRateLimitError(
      `Provider ${providerId} rate limit or quota reached.${hint}`,
      { providerId, status, cause: error, diagnostic },
    );
  }

  if (
    status === 408 ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    throw new LLMTimeoutError(`Provider ${providerId} request timed out.`, {
      providerId,
      status,
      cause: error,
      diagnostic,
    });
  }

  const detail = sanitizeDetail(message);
  const suffix =
    status === 400
      ? ` Request rejected; verify the model and supported request fields. (${diagnostic.correlationId})`
      : ` (${diagnostic.correlationId})`;
  throw new LLMAPIError(
    `Provider ${providerId} request failed${status ? ` with HTTP ${status}` : ""}.${detail ? ` ${detail}` : ""}${suffix}`,
    { providerId, status, cause: error, diagnostic },
  );
}

function serializeMultimodalMessages(
  messages: ProviderCompletionRequest["messages"],
): ProviderCompletionRequest["messages"] {
  return messages.map((message) => {
    const candidate = message as unknown as {
      content?: unknown;
      image_urls?: unknown;
      audio?: { data?: unknown; mimeType?: unknown; filename?: unknown };
    };
    const imageUrls = Array.isArray(candidate.image_urls)
      ? candidate.image_urls.filter(
          (url): url is string =>
            typeof url === "string" && url.trim().length > 0,
        )
      : [];
    const audioData =
      typeof candidate.audio?.data === "string" && candidate.audio.data.trim()
        ? candidate.audio.data.trim()
        : undefined;
    const audioMime =
      typeof candidate.audio?.mimeType === "string"
        ? candidate.audio.mimeType.split(";", 1)[0].trim().toLowerCase()
        : "audio/wav";
    if (imageUrls.length === 0 && !audioData) return message;
    const text = typeof candidate.content === "string" ? candidate.content : "";
    const audioFormat = audioMime.split("/", 2)[1] || "wav";
    return {
      ...(message as object),
      content: [
        ...(text ? [{ type: "text", text }] : []),
        ...imageUrls.map((url) => ({ type: "image_url", image_url: { url } })),
        ...(audioData
          ? [
              {
                type: "input_audio",
                input_audio: { data: audioData, format: audioFormat },
              },
            ]
          : []),
      ],
      image_urls: undefined,
      audio: undefined,
    } as unknown as ProviderCompletionRequest["messages"][number];
  });
}

export class OpenAICompatibleAdapter implements LLMProviderAdapter {
  readonly providerId = "openai-compatible";

  async complete(request: ProviderCompletionRequest): Promise<LLMResponse> {
    const { provider, model, apiKey, extra } = request;
    const messages = serializeMultimodalMessages(request.messages);
    if (!apiKey && !provider.emptyApiKeyAllowed) {
      throw new LLMMissingCredentialError(
        `No API key is configured for ${provider.displayName}.`,
        { providerId: provider.id },
      );
    }

    const diagnostic: LLMProviderDiagnostic = {
      correlationId: randomUUID(),
      providerId: provider.id,
      model,
      endpoint: provider.baseUrl,
      requestShape: {
        messageCount: messages.length,
        toolCount: Array.isArray(extra?.tools) ? extra.tools.length : 0,
        payloadBytes: Buffer.byteLength(
          JSON.stringify({
            model,
            messages,
            extra:
              provider.id === "gemini" ? normalizeGeminiExtra(extra) : extra,
          }),
        ),
      },
    };
    const providerExtra =
      provider.id === "gemini" ? normalizeGeminiExtra(extra) : (extra ?? {});
    let requestBody: Record<string, unknown> = {
      model,
      messages,
      ...providerExtra,
    };
    for (const key of Object.keys(requestBody)) {
      if (requestBody[key] === undefined) delete requestBody[key];
    }

    let lastError: unknown;
    let geminiToolFallbackAttempted = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await getClient(
          provider,
          apiKey,
          request.timeoutMs,
        ).chat.completions.create(requestBody as never);
      } catch (error) {
        lastError = error;
        const message = errorMessage(error).toLowerCase();
        const status = statusCode(error);
        if (
          provider.id === "gemini" &&
          status === 400 &&
          !geminiToolFallbackAttempted &&
          Array.isArray(requestBody.tools) &&
          requestBody.tools.length > 0
        ) {
          // Some Gemini OpenAI-compatible model versions reject function
          // declarations even after schema normalization. Retry once as a
          // plain completion so the user receives an honest limitation instead
          // of an opaque repeated 400; artifact contracts still prevent false
          // task completion when no files were produced.
          geminiToolFallbackAttempted = true;
          const plainBody = { ...requestBody };
          delete plainBody.tools;
          delete plainBody.tool_choice;
          delete plainBody.response_format;
          requestBody = plainBody;
          continue;
        }
        const retryable =
          status === 408 ||
          status >= 500 ||
          message.includes("timeout") ||
          message.includes("temporarily unavailable") ||
          message.includes("connection");
        if (!retryable || attempt === 2) {
          classifyError(error, provider.id, diagnostic);
        }
        const wait =
          Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    classifyError(lastError, provider.id, diagnostic);
  }

  listModels(
    provider: DirectProviderConfig,
    apiKey: string,
    timeoutMs?: number,
  ): Promise<ProviderModel[]> {
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
