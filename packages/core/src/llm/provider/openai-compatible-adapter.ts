import { randomUUID } from "node:crypto";
import type { LLMResponse } from "@miki/config";
import type { ProviderTransportConfig } from "./transport.js";
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
} from "./contracts.js";

export function defaultTimeoutMs(provider: ProviderTransportConfig): number {
  if (provider.local) {
    const configured = Number.parseInt(
      process.env.MIKI_LOCAL_LLM_TIMEOUT_MS || "90000",
      10,
    );
    return Number.isFinite(configured) && configured >= 60_000
      ? configured
      : 90_000;
  }
  return 120_000;
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
      typeof value.error === "object" && value.error !== null
        ? (value.error as { message?: unknown; code?: unknown }).message
        : value.error,
      value.response?.data,
      value.body,
      value.message,
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

interface StreamChunk {
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: unknown;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: unknown };
      }>;
    };
  }>;
  usage?: LLMResponse["usage"];
}

class ProviderHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

async function requestNonStreamingCompletion(
  provider: ProviderTransportConfig,
  apiKey: string,
  requestBody: Record<string, unknown>,
  request: ProviderCompletionRequest,
): Promise<LLMResponse> {
  const effectiveKey = apiKey || (provider.emptyApiKeyAllowed ? "local-no-auth-required" : apiKey);
  const timeout = AbortSignal.timeout(request.timeoutMs ?? defaultTimeoutMs(provider));
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${effectiveKey}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(requestBody),
    signal,
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
      const detail = parsed.error?.message ?? parsed.message;
      if (typeof detail === "string") message = detail;
    } catch { /* keep the bounded provider response text */ }
    throw new ProviderHttpError(message.slice(0, 1_000) || `HTTP ${response.status}`, response.status);
  }
  return await response.json() as LLMResponse;
}

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      let boundary = pending.search(/\r?\n\r?\n/);
      while (boundary >= 0) {
        const block = pending.slice(0, boundary);
        const separator = pending.slice(boundary).match(/^\r?\n\r?\n/)?.[0] ?? "\n\n";
        pending = pending.slice(boundary + separator.length);
        const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data && data !== "[DONE]") {
          try { yield JSON.parse(data) as StreamChunk; }
          catch { throw new Error("Provider returned malformed server-sent event data."); }
        }
        boundary = pending.search(/\r?\n\r?\n/);
      }
      if (done) break;
    }
    const tail = pending.trim();
    if (tail.startsWith("data:") && tail.slice(5).trim() !== "[DONE]") {
      try { yield JSON.parse(tail.slice(5).trim()) as StreamChunk; }
      catch { throw new Error("Provider returned malformed server-sent event data."); }
    }
  } finally {
    reader.releaseLock();
  }
}

async function requestStreamingCompletion(
  provider: ProviderTransportConfig,
  apiKey: string,
  requestBody: Record<string, unknown>,
  request: ProviderCompletionRequest,
  model: string,
): Promise<LLMResponse> {
  const effectiveKey = apiKey || (provider.emptyApiKeyAllowed ? "local-no-auth-required" : apiKey);
  const timeout = AbortSignal.timeout(request.timeoutMs ?? defaultTimeoutMs(provider));
  const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${effectiveKey}`,
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(requestBody),
    signal,
  });
  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    let message = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown }; message?: unknown };
      const detail = parsed.error?.message ?? parsed.message;
      if (typeof detail === "string") message = detail;
    } catch { /* keep the bounded provider response text */ }
    throw new ProviderHttpError(message.slice(0, 1_000) || `HTTP ${response.status}`, response.status);
  }
  if (!response.body) throw new Error("Provider returned an empty streaming response.");
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    const body = await response.json() as LLMResponse;
    const content = body.choices?.[0]?.message?.content;
    if (typeof content === "string") {
      try { request.onTextDelta?.(content); } catch { /* listeners must not break completion */ }
    }
    return body;
  }
  return readStreamingCompletion(parseSseStream(response.body), request, model);
}

async function readStreamingCompletion(
  streamValue: unknown,
  request: ProviderCompletionRequest,
  model: string,
): Promise<LLMResponse> {
  const stream = streamValue as AsyncIterable<StreamChunk>;
  let content = "";
  let finishReason: string | undefined;
  let usage: LLMResponse["usage"];
  const calls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

  for await (const chunk of stream) {
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      try { request.onTextDelta?.(delta.content); } catch { /* UI listeners must not break generation */ }
    }
    for (const part of delta.tool_calls ?? []) {
      const index = typeof part.index === "number" ? part.index : calls.length;
      const target = (calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (part.id) target.id = part.id;
      if (part.function?.name) target.function.name += part.function.name;
      if (typeof part.function?.arguments === "string") target.function.arguments += part.function.arguments;
    }
  }

  const completeCalls = calls.filter((call) => call && call.function.name).map((call, index) => ({
    ...call,
    id: call.id || `call_${index}_${randomUUID().slice(0, 8)}`,
  }));
  return {
    choices: [{
      message: {
        role: "assistant",
        content: content || "",
        ...(completeCalls.length ? { tool_calls: completeCalls } : {}),
      },
      finish_reason: finishReason ?? (completeCalls.length ? "tool_calls" : "stop"),
    }],
    ...(usage ? { usage } : {}),
    model,
  } as LLMResponse;
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
    const serializedMessages = serializeMultimodalMessages(request.messages);
    const messages = serializedMessages;
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
            extra: extra ?? {},
          }),
        ),
      },
    };
    const providerExtra = extra ?? {};
    let requestBody: Record<string, unknown> = {
      model,
      messages,
      ...providerExtra,
    };
    let streaming = typeof request.onTextDelta === "function";
    if (streaming) {
      requestBody.stream = true;
      requestBody.stream_options = { include_usage: true };
    }
    for (const key of Object.keys(requestBody)) {
      if (requestBody[key] === undefined) delete requestBody[key];
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (streaming) return await requestStreamingCompletion(provider, apiKey, requestBody, request, model);
        return await requestNonStreamingCompletion(provider, apiKey, requestBody, request);
      } catch (error) {
        lastError = error;
        const message = errorMessage(error).toLowerCase();
        const status = statusCode(error);
        // Optional provider-specific thinking controls are not recognized by
        // every OpenAI-compatible server. Retry immediately without that field,
        // matching the direct-fetch client while preserving all other settings.
        if (
          status === 400 &&
          Object.hasOwn(requestBody, "thinking_level") &&
          /thinking[_ -]?level|reasoning[_ -]?effort|unknown (field|parameter)|unrecognized.*thinking/.test(message)
        ) {
          delete requestBody.thinking_level;
          attempt -= 1;
          continue;
        }
        // Some otherwise-compatible servers stream correctly but reject usage
        // metadata in the SSE request. Keep streaming and retry without that option.
        if (
          streaming &&
          status === 400 &&
          Object.hasOwn(requestBody, "stream_options") &&
          /stream[_ -]?options/.test(message)
        ) {
          // Some OpenAI-compatible endpoints stream correctly but reject usage
          // metadata in the SSE request. Keep streaming and retry without that option.
          delete requestBody.stream_options;
          attempt -= 1;
          continue;
        }
        if (streaming && status === 400 && /stream/.test(message)) {
          streaming = false;
          delete requestBody.stream;
          delete requestBody.stream_options;
          attempt -= 1;
          continue;
        }
        const retryable =
          status === 408 ||
          status === 429 ||
          status >= 500 ||
          message.includes("timeout") ||
          message.includes("temporarily unavailable") ||
          message.includes("connection");
        if (!retryable || attempt === 2) {
          classifyError(error, provider.id, diagnostic);
        }
        const wait =
          Math.min(8_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, wait);
          if (!request.signal) return;
          const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
          if (request.signal.aborted) abort();
          else request.signal.addEventListener("abort", abort, { once: true });
        });
      }
    }
    classifyError(lastError, provider.id, diagnostic);
  }

  clearCache(): void {
    // Requests are stateless fetches; there is no provider client cache to clear.
  }
}

export const openAICompatibleAdapter = new OpenAICompatibleAdapter();
