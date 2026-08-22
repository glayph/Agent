import { randomUUID } from "node:crypto";
import type { LLMProviderDiagnostic } from "./errors.js";
import {
  LLMEntitlementError,
  LLMProviderError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMMissingCredentialError,
} from "./errors.js";
import {
  normalizeDirectModelName,
  type DirectProviderConfig,
} from "./catalog.js";
import { classifyError } from "./openai-compatible-adapter.js";

export type CompletionHealthStatus =
  | "ready"
  | "invalid"
  | "entitlement_blocked"
  | "rate_limited"
  | "unreachable"
  | "model_not_found";

export interface CompletionHealthResult {
  providerId: string;
  modelId: string;
  status: CompletionHealthStatus;
  completionTested: boolean;
  latencyMs: number;
  responseShape?: {
    choiceCount: number;
    contentPresent: boolean;
    finishReason?: string | null;
  };
  diagnostic: LLMProviderDiagnostic;
  error?: string;
}

export interface CompletionHealthInput {
  provider: DirectProviderConfig;
  model: string;
  apiKey: string;
  timeoutMs?: number;
  prompt?: string;
}

type ProviderFailure = {
  status?: number;
  message: string;
};

function statusForError(error: unknown): CompletionHealthStatus {
  if (error instanceof LLMMissingCredentialError) return "invalid";
  if (error instanceof LLMEntitlementError) return "entitlement_blocked";
  if (error instanceof LLMRateLimitError) return "rate_limited";
  if (error instanceof LLMTimeoutError) return "unreachable";
  if (error instanceof LLMProviderError) {
    const message = error.message.toLowerCase();
    if (
      error.status === 404 ||
      (message.includes("model") &&
        (message.includes("not found") || message.includes("does not exist")))
    ) {
      return "model_not_found";
    }
    // A provider-side 400 is a deterministic request/model/configuration
    // rejection, not a network outage. Keep readiness truthful so the UI can
    // guide the user to fix the model identifier or request shape.
    if (error.status === 400) return "invalid";
  }
  return "unreachable";
}

function safeError(error: unknown): string {
  if (error instanceof LLMProviderError) return error.message;
  return "Provider completion probe failed.";
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

function providerHeaders(provider: DirectProviderConfig, apiKey: string) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (apiKey) {
    // This probe targets Gemini's OpenAI-compatible
    // /v1beta/openai/chat/completions endpoint, whose documented auth
    // contract is Authorization: Bearer <Gemini API key>. The native
    // /v1beta/models discovery path uses x-goog-api-key separately.
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

function bodyMessage(body: unknown): string {
  if (typeof body === "string" && body.trim()) return body.trim();
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string" && error.trim()) return error.trim();
    if (error && typeof error === "object") {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    const message = record.message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return "Provider rejected the completion request.";
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export async function probeProviderCompletion(
  input: CompletionHealthInput,
): Promise<CompletionHealthResult> {
  const started = Date.now();
  const modelId = normalizeDirectModelName(input.provider.id, input.model);
  const diagnostic: LLMProviderDiagnostic = {
    correlationId: randomUUID(),
    providerId: input.provider.id,
    model: modelId,
    endpoint: input.provider.baseUrl,
    requestShape: {
      messageCount: 1,
      toolCount: 0,
      payloadBytes: 0,
    },
  };
  const url = `${input.provider.baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const prompt =
    input.prompt ||
    "Reply with exactly one short word: READY. Do not call tools.";
  const payload = {
    model: modelId,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 8,
    temperature: 0,
    stream: false,
  };
  diagnostic.requestShape.payloadBytes = Buffer.byteLength(
    JSON.stringify(payload),
    "utf8",
  );

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: providerHeaders(input.provider, input.apiKey),
      body: JSON.stringify(payload),
      signal: timeoutSignal(input.timeoutMs ?? 120_000),
    });
    const body = await readResponseBody(response);
    if (!response.ok) {
      const failure: ProviderFailure = {
        status: response.status,
        message: bodyMessage(body),
      };
      throw failure;
    }
    const record =
      body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const first =
      choices[0] && typeof choices[0] === "object"
        ? (choices[0] as Record<string, unknown>)
        : undefined;
    const message =
      first?.message && typeof first.message === "object"
        ? (first.message as Record<string, unknown>)
        : undefined;
    const content =
      typeof message?.content === "string" ? message.content.trim() : "";
    return {
      providerId: input.provider.id,
      modelId,
      status: content ? "ready" : "unreachable",
      completionTested: true,
      latencyMs: Date.now() - started,
      responseShape: {
        choiceCount: choices.length,
        contentPresent: Boolean(content),
        finishReason:
          typeof first?.finish_reason === "string" ? first.finish_reason : null,
      },
      diagnostic,
      ...(content ? {} : { error: "Provider returned no completion content." }),
    };
  } catch (error) {
    const failure = error as ProviderFailure;
    const classifiedInput =
      typeof failure.message === "string"
        ? failure
        : {
            message: error instanceof Error ? error.message : String(error),
          };
    try {
      classifyError(classifiedInput, input.provider.id, diagnostic);
    } catch (classified) {
      const providerError = classified as LLMProviderError;
      return {
        providerId: input.provider.id,
        modelId,
        status: statusForError(providerError),
        completionTested: true,
        latencyMs: Date.now() - started,
        diagnostic: providerError.diagnostic || diagnostic,
        error: safeError(providerError),
      };
    }
    return {
      providerId: input.provider.id,
      modelId,
      status: "unreachable",
      completionTested: true,
      latencyMs: Date.now() - started,
      diagnostic,
      error: "Provider completion probe failed.",
    };
  }
}
