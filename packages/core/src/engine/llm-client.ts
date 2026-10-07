import type { LLMResponse } from "@miki/config";
import type {
  EngineLLMClient,
  EngineMessage,
  LLMCompletionOptions,
} from "./types.js";
import { errorMessage, sleep } from "./util.js";

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


/**
 * Reads an OpenAI-compatible SSE chat-completions stream and assembles it into
 * a normal LLMResponse (content, tool_calls, finish_reason, usage), forwarding
 * every text fragment to `onTextDelta` as it arrives.
 */
async function readChatCompletionStream(
  response: Response,
  onTextDelta: (delta: string) => void,
): Promise<LLMResponse> {
  if (!response.body) throw new EngineLLMError("The model provider returned an empty stream.", { retryable: true });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | undefined;
  let usage: LLMResponse["usage"];
  const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string }; extra_content?: Record<string, unknown> }> = [];

  const handleData = (data: string) => {
    if (!data || data === "[DONE]") return;
    let chunk: any;
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

  for (;;) {
    const { done, value } = await reader.read();
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

  const completeCalls = toolCalls.filter((call) => call && call.function.name).map((call, i) => ({ ...call, id: call.id || `call_${i}_${Date.now().toString(36)}` }));
  return {
    choices: [{
      index: 0,
      message: { role: "assistant", content: content || (completeCalls.length ? null : ""), ...(completeCalls.length ? { tool_calls: completeCalls } : {}) },
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
export function createFetchLLMClient(options: FetchLLMClientOptions): EngineLLMClient {
  const base = options.baseUrl.replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const retries = options.retries ?? 2;
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
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        const signals = [AbortSignal.timeout(options.timeoutMs ?? 120_000)];
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
            return await readChatCompletionStream(response, callOptions.onTextDelta!);
          }
          const payload = (await response.json().catch(() => ({}))) as LLMResponse & {
            error?: { message?: string } | string;
          };
          if (streaming && !response.ok && response.status === 400 && /stream/i.test(typeof payload.error === "string" ? payload.error : payload.error?.message || "")) {
            // Provider rejects streaming options: fall back to a normal completion.
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
            return payload;
          }
          const unsupportedThinking =
            Boolean(callOptions.thinkingLevel) &&
            response.status === 400 &&
            /thinking[_ ]level|reasoning[_ ]effort|unknown (field|parameter)|unrecognized.*thinking/i.test(
              typeof payload.error === "string" ? payload.error : payload.error?.message || "",
            );
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
            if (fallback.ok && Array.isArray(fallbackPayload.choices)) return fallbackPayload;
            const fallbackDetail = typeof fallbackPayload.error === "string" ? fallbackPayload.error : fallbackPayload.error?.message;
            throw new EngineLLMError(fallbackDetail || `Model provider returned HTTP ${fallback.status}.`, { status: fallback.status, retryable: fallback.status === 429 || fallback.status >= 500 });
          }
          const detail =
            typeof payload.error === "string"
              ? payload.error
              : payload.error?.message;
          const retryable = response.status === 429 || response.status >= 500;
          lastError = new EngineLLMError(
            detail || `Model provider returned HTTP ${response.status}.`,
            { status: response.status, retryable },
          );
          if (!retryable) throw lastError;
        } catch (error) {
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
        if (attempt < retries) {
          try {
            await sleep(retryDelayMs * 2 ** attempt, callOptions.signal);
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
    options?: { extra?: Record<string, unknown>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<LLMResponse>;
}

/** Adapter so the engine can use core's provider-plugin registry (vault credentials, local models). */
export function createRegistryLLMClient(
  registry: RegistryLike,
  model: string,
  options: { timeoutMs?: number; extra?: Record<string, unknown> } = {},
): EngineLLMClient {
  return {
    model,
    complete(messages, callOptions = {}) {
      const extra: Record<string, unknown> = { ...(options.extra ?? {}) };
      if (callOptions.tools?.length) {
        extra.tools = callOptions.tools;
        extra.tool_choice = callOptions.toolChoice ?? "auto";
      }
      if (callOptions.json) extra.response_format = { type: "json_object" };
      return registry.complete(model, messages, {
        extra,
        timeoutMs: options.timeoutMs,
        signal: callOptions.signal,
      });
    },
  };
}
