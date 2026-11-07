import { randomUUID } from "node:crypto";
import type { LLMResponse } from "@miki/config";
import type { ProviderTransportConfig } from "./transport.js";
import {
  LLMAPIError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMMissingCredentialError,
  LLMAuthorizationError,
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

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNUNREACH",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TIMEOUT_ERROR_CODES = new Set(["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
const AUTH_ERROR_CODES = new Set(["invalid_api_key", "authentication_error", "unauthorized"]);

function errorCodeChain(error: unknown): string[] {
  const codes: string[] = [];
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 8) {
    const current = pending.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const value = current as { code?: unknown; errno?: unknown; cause?: unknown; name?: unknown };
    for (const candidate of [value.code, value.errno, value.name]) {
      if (typeof candidate === "string" && candidate.trim()) codes.push(candidate.toUpperCase());
    }
    if (value.cause) pending.push(value.cause);
  }
  return codes;
}

function structuredRetryDelayMs(error: unknown, body: unknown): number | null {
  const direct = error && typeof error === "object"
    ? (error as { retryAfterMs?: unknown }).retryAfterMs
    : undefined;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return Math.ceil(direct);
  if (!body || typeof body !== "object") return null;
  const root = body as Record<string, unknown>;
  const nested = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : {};
  const millisecondValues = [nested.retry_after_ms, root.retry_after_ms, nested.retryAfterMs, root.retryAfterMs];
  for (const candidate of millisecondValues) {
    const value = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : NaN;
    if (Number.isFinite(value) && value >= 0) return Math.ceil(value);
  }
  const secondValues = [nested.retryDelay, root.retryDelay, nested.retry_after, root.retry_after];
  for (const candidate of secondValues) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return Math.ceil(candidate * 1000);
    if (typeof candidate === "string") {
      const match = candidate.trim().match(/^(\d+(?:\.\d+)?)s?$/i);
      if (match) return Math.ceil(Number(match[1]) * 1000);
    }
  }
  const details = Array.isArray(nested.details) ? nested.details : Array.isArray(root.details) ? root.details : [];
  for (const detail of details) {
    if (!detail || typeof detail !== "object") continue;
    const record = detail as Record<string, unknown>;
    const candidate = record.retryDelay ?? record.retry_delay;
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) return Math.ceil(candidate * 1000);
    if (typeof candidate === "string") {
      const match = candidate.trim().match(/^(\d+(?:\.\d+)?)s?$/i);
      if (match) return Math.ceil(Number(match[1]) * 1000);
    }
  }
  return null;
}

function retryAfterHeaderMs(value: string | null, now = Date.now()): number | null {
  if (!value?.trim()) return null;
  const raw = value.trim();
  const seconds = Number(raw);
  const milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
  return Number.isFinite(milliseconds) && milliseconds >= 0 && Number.isSafeInteger(Math.ceil(milliseconds))
    ? Math.ceil(milliseconds)
    : null;
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
      value.message,
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
  if (typeof error !== "object" || error === null) return 0;
  const value = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const status of [value.status, value.statusCode, value.response?.status])
    if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) return status;
  return 0;
}

function structuredProviderError(error: unknown): { code?: string; type?: string; body?: unknown } {
  if (typeof error !== "object" || error === null) return {};
  const value = error as { payload?: unknown; body?: unknown; response?: { data?: unknown } };
  const body = value.payload ?? value.body ?? value.response?.data;
  if (!body || typeof body !== "object") return { body };
  const record = body as Record<string, unknown>;
  const nested = record.error && typeof record.error === "object"
    ? record.error as Record<string, unknown>
    : {};
  const code = nested.code ?? record.code;
  const type = nested.type ?? record.type;
  return {
    ...(typeof code === "string" ? { code: code.toLowerCase() } : {}),
    ...(typeof type === "string" ? { type: type.toLowerCase() } : {}),
    body,
  };
}

const ENTITLEMENT_CODES = new Set([
  "payment_required",
  "payment_method_required",
  "billing_hard_limit",
  "billing_not_active",
  "account_payment_required",
  "insufficient_quota",
]);
const RATE_LIMIT_CODES = new Set([
  "rate_limit_exceeded",
  "resource_exhausted",
  "too_many_requests",
]);

function sanitizeEndpoint(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/(?:api[-_]?key|access[-_]?token|token|secret|password)\/[^/]+/gi, "/[redacted]");
    return url.toString().slice(0, 240);
  } catch {
    return value.split(/[?#]/, 1)[0].slice(0, 240);
  }
}

function sanitizeDetail(message: string, knownSecrets: readonly string[] = []): string {
  let safe = message
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|token|authorization|secret|password)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1[redacted]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[0-9A-Za-z_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{16,})\b/g, "[redacted-token]")
    .replace(/https?:\/\/[^\s]+/gi, "[endpoint]");
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 4) safe = safe.split(secret).join("[redacted]");
  }
  return safe.slice(0, 240);
}

export function classifyError(
  error: unknown,
  providerId: string,
  diagnostic: LLMProviderDiagnostic,
  knownSecrets: readonly string[] = [],
): never {
  const message = errorMessage(error);
  const status = statusCode(error);
  const errorCodes = errorCodeChain(error);
  const rawProviderRetryAfter = error && typeof error === "object"
    ? (error as { retryAfterMs?: unknown }).retryAfterMs
    : undefined;
  const providerRetryAfter = typeof rawProviderRetryAfter === "number" && Number.isFinite(rawProviderRetryAfter)
    ? rawProviderRetryAfter
    : Number.NaN;
  const structured = structuredProviderError(error);
  diagnostic.status = status || diagnostic.status;
  diagnostic.providerCode = structured.code ? sanitizeDetail(structured.code, knownSecrets) : undefined;
  diagnostic.providerType = structured.type ? sanitizeDetail(structured.type, knownSecrets) : undefined;
  if (diagnostic.endpoint) diagnostic.endpoint = sanitizeEndpoint(diagnostic.endpoint);

  // HTTP 402 is the unambiguous payment-required response. Other statuses are
  // classified as entitlement only when the provider supplies a documented
  // structured code/type; prose alone (including the word "billing") is not enough.
  const explicitEntitlement = Boolean(
    structured.code && ENTITLEMENT_CODES.has(structured.code)
    || structured.type && ENTITLEMENT_CODES.has(structured.type),
  );
  if (status === 402 || (status !== 401 && explicitEntitlement)) {
    throw new LLMEntitlementError(
      `Provider ${providerId} requires an active payment method, credits, or subscription before completion.`,
      { providerId, status, cause: error, diagnostic },
    );
  }

  if (status === 401 || (status === 0 && errorCodes.some((code) => AUTH_ERROR_CODES.has(code.toLowerCase())))) {
    throw new LLMMissingCredentialError(
      `The API key for ${providerId} was rejected by the provider.`,
      { providerId, status, cause: error, diagnostic },
    );
  }

  if (status === 403) {
    throw new LLMAuthorizationError(
      `Provider ${providerId} rejected the configured authorization.`,
      { providerId, status, cause: error, diagnostic },
    );
  }

  const explicitRateLimit = Boolean(
    structured.code && RATE_LIMIT_CODES.has(structured.code)
    || structured.type && RATE_LIMIT_CODES.has(structured.type),
  );
  if (status === 429 || (status === 0 && explicitRateLimit)) {
    const delay = Number.isFinite(providerRetryAfter) && providerRetryAfter >= 0
      ? Math.ceil(providerRetryAfter)
      : structuredRetryDelayMs(error, structured.body);
    const hint = delay
      ? ` Retry after about ${Math.ceil(delay / 1000)} seconds.`
      : "";
    throw new LLMRateLimitError(
      `Provider ${providerId} rate limit or quota reached.${hint}`,
      { providerId, status, retryAfterMs: delay ?? undefined, cause: error, diagnostic },
    );
  }

  if (status === 408 || errorCodes.some((code) => TIMEOUT_ERROR_CODES.has(code)) || errorCodes.includes("TIMEOUTERROR")) {
    throw new LLMTimeoutError(`Provider ${providerId} request timed out.`, {
      providerId,
      status,
      cause: error,
      diagnostic,
    });
  }

  const detail = sanitizeDetail(message, knownSecrets);
  const networkFailure = errorCodes.some((code) => NETWORK_ERROR_CODES.has(code));
  const suffix =
    status === 400
      ? ` Request rejected; verify the model and supported request fields. (${diagnostic.correlationId})`
      : ` (${diagnostic.correlationId})`;
  throw new LLMAPIError(
    `Provider ${providerId} request failed${status ? ` with HTTP ${status}` : ""}.${detail ? ` ${detail}` : ""}${suffix}`,
    { providerId, status, retryable: status >= 500 || networkFailure, cause: error, diagnostic },
  );
}

interface StreamChunk {
  choices?: Array<{
    index?: number;
    finish_reason?: string | null;
    delta?: {
      content?: unknown;
      extra_content?: unknown;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: unknown };
        extra_content?: unknown;
      }>;
    };
  }>;
  usage?: LLMResponse["usage"];
}

class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: unknown,
    readonly retryAfterMs?: number | null,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

function providerErrorMetadata(error: unknown): Record<string, unknown> {
  const payload = error instanceof ProviderHttpError ? error.payload : undefined;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const root = payload as Record<string, unknown>;
  const nested = root.error && typeof root.error === "object" && !Array.isArray(root.error)
    ? root.error as Record<string, unknown>
    : {};
  return { ...root, ...nested };
}

function reportsUnsupportedField(error: unknown, field: string): boolean {
  if (statusCode(error) !== 400) return false;
  const metadata = providerErrorMetadata(error);
  const reportedField = metadata.param ?? metadata.parameter ?? metadata.field ?? metadata.target;
  return typeof reportedField === "string" && reportedField === field;
}

function reportsUnsupportedStreaming(error: unknown): boolean {
  if (statusCode(error) !== 400) return false;
  const metadata = providerErrorMetadata(error);
  const reportedField = metadata.param ?? metadata.parameter ?? metadata.field ?? metadata.target;
  const code = String(metadata.code ?? metadata.type ?? "").toLowerCase();
  return reportedField === "stream" || reportedField === "stream_options"
    || ["unsupported_streaming", "stream_not_supported", "streaming_not_supported"].includes(code);
}

function providerResponseMessage(raw: string, status: number): { message: string; payload?: unknown } {
  try {
    const payload = JSON.parse(raw) as unknown;
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const nested = record.error && typeof record.error === "object" ? record.error as Record<string, unknown> : {};
    const detail = nested.message ?? record.message ?? record.error;
    return { message: typeof detail === "string" ? detail.slice(0, 1_000) : `HTTP ${status}`, payload };
  } catch {
    return { message: raw.slice(0, 1_000) || `HTTP ${status}` };
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
    const parsed = providerResponseMessage(raw, response.status);
    throw new ProviderHttpError(parsed.message, response.status, parsed.payload, retryAfterHeaderMs(response.headers.get("retry-after")));
  }
  return await response.json() as LLMResponse;
}

async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number,
  requestController: AbortController,
): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idleRead = reader.read();
      const timedRead = new Promise<Awaited<ReturnType<typeof reader.read>>>((_resolve, reject) => {
        idleTimer = setTimeout(() => {
          const timeoutError = new DOMException(`Model stream idle timeout after ${idleTimeoutMs} ms.`, "TimeoutError");
          requestController.abort(timeoutError);
          reject(timeoutError);
        }, idleTimeoutMs);
      });
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await Promise.race([idleRead, timedRead]); }
      finally { if (idleTimer) clearTimeout(idleTimer); }
      const { done, value } = chunk;
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
    try { reader.releaseLock(); } catch { /* stream may already be cancelled */ }
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
  const timeoutMs = request.timeoutMs ?? defaultTimeoutMs(provider);
  const requestController = new AbortController();
  const timeout = setTimeout(
    () => requestController.abort(new DOMException(`Provider request timed out after ${timeoutMs} ms.`, "TimeoutError")),
    timeoutMs,
  );
  const signal = request.signal ? AbortSignal.any([request.signal, requestController.signal]) : requestController.signal;
  const endpoint = `${provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${effectiveKey}`,
        "content-type": "application/json",
        accept: "text/event-stream, application/json",
      },
      body: JSON.stringify(requestBody),
      signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }

  if (!response.ok) {
    try {
      const raw = await response.text().catch(() => "");
      const parsed = providerResponseMessage(raw, response.status);
      throw new ProviderHttpError(parsed.message, response.status, parsed.payload, retryAfterHeaderMs(response.headers.get("retry-after")));
    } finally {
      clearTimeout(timeout);
    }
  }

  if (!response.body) {
    clearTimeout(timeout);
    throw new Error("Provider returned an empty streaming response.");
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("text/event-stream")) {
    try {
      const body = await response.json() as LLMResponse;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content === "string") {
        try { request.onTextDelta?.(content); } catch { /* listeners must not break completion */ }
      }
      return body;
    } finally {
      clearTimeout(timeout);
    }
  }

  // Connection setup has a total timeout. After headers, the idle timer is reset
  // on each SSE read, so a long but live model response is allowed to complete.
  clearTimeout(timeout);
  return readStreamingCompletion(parseSseStream(response.body, timeoutMs, requestController), request, model);
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
  let messageExtraContent: Record<string, unknown> | undefined;
  const calls: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    extra_content?: Record<string, unknown>;
  }> = [];

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
    if (delta.extra_content && typeof delta.extra_content === "object" && !Array.isArray(delta.extra_content)) {
      messageExtraContent = { ...(messageExtraContent ?? {}), ...(delta.extra_content as Record<string, unknown>) };
    }
    for (const part of delta.tool_calls ?? []) {
      const index = typeof part.index === "number" ? part.index : calls.length;
      const target = (calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
      if (part.id) target.id = part.id;
      if (part.function?.name) target.function.name += part.function.name;
      if (typeof part.function?.arguments === "string") target.function.arguments += part.function.arguments;
      if (part.extra_content && typeof part.extra_content === "object" && !Array.isArray(part.extra_content)) {
        target.extra_content = { ...(target.extra_content ?? {}), ...(part.extra_content as Record<string, unknown>) };
      }
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
        ...(messageExtraContent ? { extra_content: messageExtraContent } : {}),
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
      endpoint: sanitizeEndpoint(provider.baseUrl),
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
    for (let attempt = 0; attempt < 1; attempt += 1) {
      try {
        if (streaming) return await requestStreamingCompletion(provider, apiKey, requestBody, request, model);
        return await requestNonStreamingCompletion(provider, apiKey, requestBody, request);
      } catch (error) {
        lastError = error;
        const status = statusCode(error);
        // Providers identify invalid request fields through structured parameter metadata.
        if (Object.hasOwn(requestBody, "thinking_level") && reportsUnsupportedField(error, "thinking_level")) {
          delete requestBody.thinking_level;
          attempt -= 1;
          continue;
        }
        // Some otherwise-compatible servers stream correctly but reject usage
        // metadata in the SSE request. Keep streaming and retry without that option.
        if (
          streaming &&
          Object.hasOwn(requestBody, "stream_options") &&
          reportsUnsupportedField(error, "stream_options")
        ) {
          // Some OpenAI-compatible endpoints stream correctly but reject usage
          // metadata in the SSE request. Keep streaming and retry without that option.
          delete requestBody.stream_options;
          attempt -= 1;
          continue;
        }
        if (streaming && status === 400 && reportsUnsupportedStreaming(error)) {
          streaming = false;
          delete requestBody.stream;
          delete requestBody.stream_options;
          attempt -= 1;
          continue;
        }
        // Transient retries are owned by AgentEngine, which can preserve the current
        // tool/turn checkpoint and report retry state. Do not stack a second retry
        // loop inside this transport adapter. Optional request-field fallbacks
        // above remain immediate and bounded.
        if (request.signal?.aborted) throw new Error("aborted");
        classifyError(error, provider.id, diagnostic, [apiKey, provider.baseUrl]);
      }
    }
    classifyError(lastError, provider.id, diagnostic, [apiKey, provider.baseUrl]);
  }

  clearCache(): void {
    // Requests are stateless fetches; there is no provider client cache to clear.
  }
}

export const openAICompatibleAdapter = new OpenAICompatibleAdapter();
