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
          const payload = (await response.json().catch(() => ({}))) as LLMResponse & {
            error?: { message?: string } | string;
          };
          if (response.ok) {
            if (!Array.isArray(payload.choices))
              throw new EngineLLMError(
                "The model provider returned a response without choices.",
              );
            return payload;
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
