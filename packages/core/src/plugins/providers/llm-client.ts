import type { LLMResponse } from "@miki/config";
import type {
  EngineLLMClient,
  EngineMessage,
  LLMCompletionOptions,
} from "../../engine/types.js";
import { errorMessage, sleep } from "../../engine/util.js";

export class EngineLLMError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, options: { status?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = "EngineLLMError";
    this.status = options.status;
    this.retryable = options.retryable ?? false;
  }
}

export interface FetchLLMClientOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Extra JSON body fields, e.g. provider-specific reasoning settings. */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  fetchImpl?: typeof fetch;
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
  const anyFn = (AbortSignal as unknown as {
    any?: (items: AbortSignal[]) => AbortSignal;
  }).any;
  if (anyFn) return anyFn(signals);
  const controller = new AbortController();
  for (const signal of signals) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}


/** Maximum single setTimeout delay supported reliably by Node.js runtimes. */
const MAX_TIMER_DELAY_MS = 2_147_000_000;

/** Seconds or HTTP-date from a Retry-After header, in ms. Preserve the provider's requested delay. */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const seconds = Number(trimmed);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(trimmed) - now;
  if (!Number.isFinite(ms) || ms < 0 || !Number.isSafeInteger(Math.ceil(ms))) return undefined;
  return Math.ceil(ms);
}

/** Wait through long provider Retry-After periods without overflowing Node's timer range. */
async function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  let remaining = Math.max(0, Math.ceil(ms));
  while (remaining > 0) {
    const slice = Math.min(remaining, MAX_TIMER_DELAY_MS);
    await sleep(slice, signal);
    remaining -= slice;
  }
}

/** Exponential backoff with +/-25% jitter so parallel runs do not retry in lockstep. */
function backoffDelayMs(baseMs: number, attempt: number, retryAfterMs?: number): number {
  const exponential = baseMs * 2 ** attempt * (0.75 + Math.random() * 0.5);
  return Math.max(exponential, retryAfterMs ?? 0);
}

/**
 * Reads an OpenAI-compatible SSE chat-completions stream and assembles it into
 * a normal LLMResponse (content, tool_calls, finish_reason, usage), forwarding
 * every text fragment to `onTextDelta` as it arrives.
 */
async function readChatCompletionStream(
  response: Response,
  onTextDelta: (delta: string) => void,
  idleTimeoutMs: number,
  requestController: AbortController,
): Promise<LLMResponse> {
  if (!response.body) throw new EngineLLMError("The model provider returned an empty stream.", { retryable: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | undefined;
  let usage: LLMResponse["usage"];
  let messageExtraContent: Record<string, unknown> | undefined;
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string }; extra_content?: Record<string, unknown> }> = [];

  /** The parts of an OpenAI-style streaming chunk this parser reads. */
  interface StreamChunk {
    error?: string | { message?: string };
    usage?: LLMResponse["usage"];
    choices?: Array<{
      finish_reason?: string;
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
  }
  const handleData = (data: string) => {
    if (!data || data === "[DONE]") return;
    let chunk: StreamChunk | null;
    try { chunk = JSON.parse(data); } catch { return; }
    if (chunk?.error) {
      const detail = typeof chunk.error === "string" ? chunk.error : chunk.error?.message;
      throw new EngineLLMError(detail || "The model stream reported an error.", { retryable: true });
    }
    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content) {
      content += delta.content;
      try { onTextDelta(delta.content); } catch { /* a broken listener must never break the run */ }
    }
    if (delta.extra_content && typeof delta.extra_content === "object" && !Array.isArray(delta.extra_content)) {
      messageExtraContent = { ...(messageExtraContent ?? {}), ...(delta.extra_content as Record<string, unknown>) };
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const part of delta.tool_calls) {
        const index = typeof part.index === "number" ? part.index : toolCalls.length;
        const target = (toolCalls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
        if (part.id) target.id = part.id;
        if (part.function?.name) target.function.name += part.function.name;
        if (typeof part.function?.arguments === "string") target.function.arguments += part.function.arguments;
        if (part.extra_content && typeof part.extra_content === "object") target.extra_content = { ...(target.extra_content ?? {}), ...part.extra_content };
      }
    }
  };

  try {
    for (;;) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idleRead = reader.read();
      const timedRead = new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        idleTimer = setTimeout(() => {
          const timeoutError = new DOMException(`Model stream idle timeout after ${idleTimeoutMs} ms.`, "TimeoutError");
          requestController.abort(timeoutError);
          reject(new EngineLLMError(timeoutError.message, { retryable: true }));
        }, idleTimeoutMs);
      });
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try { chunk = await Promise.race([idleRead, timedRead]); }
      finally { if (idleTimer) clearTimeout(idleTimer); }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.search(/\r?\n/)) >= 0) {
        const line = buffer.slice(0, newline).trimEnd();
        buffer = buffer.slice(buffer[newline] === "\r" ? newline + 2 : newline + 1);
        if (line.startsWith("data:")) handleData(line.slice(5).trim());
      }
    }
    buffer += decoder.decode();
    for (const line of buffer.split(/\r?\n/)) if (line.startsWith("data:")) handleData(line.slice(5).trim());
  } finally {
    try { reader.releaseLock(); } catch { /* stream may already be cancelled */ }
  }

  const completeCalls = toolCalls.filter((call) => call && call.function.name).map((call, i) => ({ ...call, id: call.id || `call_${i}_${Date.now().toString(36)}` }));
  return {
    choices: [{
      index: 0,
      message: { role: "assistant", content: content || (completeCalls.length ? null : ""), ...(completeCalls.length ? { tool_calls: completeCalls } : {}), ...(messageExtraContent ? { extra_content: messageExtraContent } : {}) },
      finish_reason: finishReason ?? (completeCalls.length ? "tool_calls" : "stop"),
    }],
    ...(usage ? { usage } : {}),
  } as unknown as LLMResponse;
}

/**
 * OpenAI-compatible chat-completions client built on plain fetch, so the
 * gateway can talk to OpenAI, Gemini's compatibility endpoint, OpenRouter,
 * Ollama, llama.cpp and similar servers without any vendor SDK.
 */
function reportsUnsupportedField(payload: unknown, field: string): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const root = payload as Record<string, unknown>;
  const nested = root.error && typeof root.error === "object" && !Array.isArray(root.error)
    ? root.error as Record<string, unknown>
    : {};
  const reportedField = nested.param ?? nested.parameter ?? nested.field ?? nested.target
    ?? root.param ?? root.parameter ?? root.field ?? root.target;
  return typeof reportedField === "string" && reportedField === field;
}

function reportsUnsupportedStreaming(payload: unknown): boolean {
  return reportsUnsupportedField(payload, "stream") || reportsUnsupportedField(payload, "stream_options");
}

export function createFetchLLMClient(options: FetchLLMClientOptions): EngineLLMClient {
  const base = options.baseUrl.replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 1;
  const retryDelayMs = options.retryDelayMs ?? 600;

  return {
    model: options.model,
    async complete(
      messages: EngineMessage[],
      callOptions: LLMCompletionOptions = {},
    ): Promise<LLMResponse> {
      const body: Record<string, unknown> = {
        model: options.model,
        messages: messages.map((message) => ({
          ...message,
          content: message.content ?? (message.tool_calls ? null : ""),
        })),
        ...(options.extraBody ?? {}),
      };
      if (callOptions.tools?.length) {
        body.tools = callOptions.tools;
        body.tool_choice = callOptions.toolChoice ?? "auto";
      }
      if (callOptions.json) body.response_format = { type: "json_object" };
      if (typeof callOptions.temperature === "number") body.temperature = callOptions.temperature;
      if (typeof callOptions.maxCompletionTokens === "number") body.max_completion_tokens = callOptions.maxCompletionTokens;
      if (callOptions.thinkingLevel) body.thinking_level = callOptions.thinkingLevel;
      // Real-time streaming: only for plain-text turns the caller wants to watch.
      let streaming = typeof callOptions.onTextDelta === "function" && !callOptions.json;
      if (streaming) {
        body.stream = true;
        body.stream_options = { include_usage: true };
      }

      let lastError: EngineLLMError | undefined;
      let retryAfterMs: number | undefined;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        retryAfterMs = undefined;
        const timeoutMs = callOptions.timeoutMs ?? options.timeoutMs ?? 120_000;
        const requestController = new AbortController();
        const requestTimer = setTimeout(() => requestController.abort(new DOMException(`Model request timed out after ${timeoutMs} ms.`, "TimeoutError")), timeoutMs);
        const signals = [requestController.signal];
        if (callOptions.signal) signals.push(callOptions.signal);
        try {
          const response = await doFetch(`${base}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(options.apiKey
                ? { Authorization: `Bearer ${options.apiKey}` }
                : {}),
              ...(options.headers ?? {}),
            },
            body: JSON.stringify(body),
            signal: combineSignals(signals),
          });
          if (streaming && response.ok && /text\/event-stream/i.test(response.headers.get("content-type") ?? "")) {
            // Connection establishment is bounded separately. Once headers arrive,
            // only a silent stream times out; a long stream of valid chunks may finish.
            clearTimeout(requestTimer);
            return await readChatCompletionStream(response, callOptions.onTextDelta!, timeoutMs, requestController);
          }
          const payload = (await response.json().catch(() => ({}))) as LLMResponse & {
            error?: { message?: string; code?: string; type?: string; param?: string; parameter?: string; field?: string } | string;
            code?: string; type?: string; param?: string; parameter?: string; field?: string;
          };
          if (streaming && !response.ok && response.status === 400 && reportsUnsupportedStreaming(payload)) {
            // Provider rejects streaming options: fall back to a normal completion.
            clearTimeout(requestTimer);
            streaming = false;
            delete body.stream;
            delete body.stream_options;
            attempt -= 1;
            continue;
          }
          if (response.ok) {
            if (!Array.isArray(payload.choices))
              throw new EngineLLMError(
                "The model provider returned a response without choices.",
              );
            clearTimeout(requestTimer);
            return payload;
          }
          const unsupportedThinking = Boolean(callOptions.thinkingLevel)
            && response.status === 400
            && reportsUnsupportedField(payload, "thinking_level");
          if (unsupportedThinking) {
            delete body.thinking_level;
            // Retry once immediately without the optional provider-specific field.
            const fallback = await doFetch(`${base}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
                ...(options.headers ?? {}),
              },
              body: JSON.stringify(body),
              signal: combineSignals(signals),
            });
            const fallbackPayload = (await fallback.json().catch(() => ({}))) as LLMResponse & { error?: { message?: string } | string };
            if (fallback.ok && Array.isArray(fallbackPayload.choices)) {
              clearTimeout(requestTimer);
              return fallbackPayload;
            }
            const fallbackDetail = typeof fallbackPayload.error === "string" ? fallbackPayload.error : fallbackPayload.error?.message;
            throw new EngineLLMError(fallbackDetail || `Model provider returned HTTP ${fallback.status}.`, { status: fallback.status, retryable: fallback.status === 429 || fallback.status >= 500 });
          }
          const detail =
            typeof payload.error === "string"
              ? payload.error
              : payload.error?.message;
          const retryable = response.status === 429 || response.status >= 500;
          retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
          lastError = new EngineLLMError(
            detail || `Model provider returned HTTP ${response.status}.`,
            { status: response.status, retryable },
          );
          if (!retryable) throw lastError;
        } catch (error) {
          clearTimeout(requestTimer);
          if (callOptions.signal?.aborted) throw new Error("aborted");
          if (error instanceof EngineLLMError && !error.retryable) throw error;
          if (!(error instanceof EngineLLMError)) {
            const timedOut =
              error instanceof Error &&
              (error.name === "TimeoutError" || error.name === "AbortError");
            lastError = new EngineLLMError(
              timedOut
                ? "The model provider timed out."
                : `Could not reach the model provider: ${errorMessage(error)}`,
              { retryable: true },
            );
          }
        }
        clearTimeout(requestTimer);
        if (attempt < retries) {
          try {
            await sleepFor(backoffDelayMs(retryDelayMs, attempt, retryAfterMs), callOptions.signal);
          } catch {
            throw new Error("aborted");
          }
        }
      }
      throw lastError ?? new EngineLLMError("The model request failed.");
    },
  };
}

/** Structural type of core's ProviderRegistry.complete (avoids loading provider plugins here). */
export interface RegistryLike {
  complete(
    model: string,
    messages: Array<{
      role: "system" | "user" | "assistant" | "tool";
      content?: unknown;
      name?: string;
      tool_call_id?: string;
      tool_calls?: unknown[];
    }>,
    options?: { extra?: Record<string, unknown>; timeoutMs?: number; onTextDelta?: (delta: string) => void; signal?: AbortSignal; providerId?: string; baseUrl?: string; credentials?: Readonly<Record<string, string>>; credentialProfile?: string },
  ): Promise<LLMResponse>;
}

/** Adapter so the engine can use core's provider-plugin registry (vault credentials, local models). */
export function createRegistryLLMClient(
  registry: RegistryLike,
  model: string,
  options: { timeoutMs?: number; extra?: Record<string, unknown>; providerId?: string; baseUrl?: string; credentials?: Readonly<Record<string, string>>; credentialProfile?: string; supportsVision?: boolean } = {},
): EngineLLMClient {
  return {
    model,
    routeKey: options.credentialProfile ? `${model}::credential:${options.credentialProfile}` : `${model}::credential:default`,
    ...(options.credentialProfile ? { credentialProfile: options.credentialProfile } : {}),
    supportsVision: options.supportsVision,
    complete(messages, callOptions = {}) {
      const extra: Record<string, unknown> = { ...(options.extra ?? {}) };
      if (callOptions.tools?.length) {
        extra.tools = callOptions.tools;
        extra.tool_choice = callOptions.toolChoice ?? "auto";
      }
      if (callOptions.json) extra.response_format = { type: "json_object" };
      if (typeof callOptions.temperature === "number") extra.temperature = callOptions.temperature;
      if (typeof callOptions.maxCompletionTokens === "number") extra.max_completion_tokens = callOptions.maxCompletionTokens;
      if (callOptions.thinkingLevel) extra.thinking_level = callOptions.thinkingLevel;
      return registry.complete(model, messages, {
        extra,
        timeoutMs: callOptions.timeoutMs ?? options.timeoutMs,
        onTextDelta: callOptions.json ? undefined : callOptions.onTextDelta,
        signal: callOptions.signal,
        providerId: options.providerId,
        baseUrl: options.baseUrl,
        credentials: options.credentialProfile ? undefined : options.credentials,
        credentialProfile: options.credentialProfile,
      });
    },
  };
}
