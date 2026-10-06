import type { EngineLLMClient, EngineMessage, LLMCompletionOptions } from "./engine/types.js"

export type MessageRouteMode = "FAST_CHAT" | "FULL_AGENT"

export interface MessageRouteDecision {
  mode: MessageRouteMode
  confidence: number
  latencyMs: number
  reason?: string
}

export interface FastChatResult {
  answer: string
  requiresFullAgent: boolean
  latencyMs: number
}

export interface MessageRouterOptions {
  llmFor(model?: string): EngineLLMClient | undefined
  log?: (message: string, details?: Record<string, unknown>) => void
  recentMessageLimit?: number
}

const ROUTER_PROMPT = `You are Miki's semantic pre-execution router. Classify the meaning and implied outcome of the user's request, not its wording or vocabulary.

Return only a JSON object with this shape:
{"mode":"FAST_CHAT"|"FULL_AGENT","confidence":0.0,"reason":"brief semantic explanation"}

FAST_CHAT is appropriate only when a direct conversational answer can satisfy the request without external information retrieval, file or workspace access, memory mutation or retrieval, installed skills, browser/network actions, approvals, tool execution, or multi-step planning.
FULL_AGENT is required when the request implies any external side effect, information lookup beyond the supplied conversation, access to user state, tool/skill use, planning, verification, execution, or meaningful uncertainty about whether such work is needed.

Use semantic understanding across languages. Do not decide from a fixed vocabulary or phrase list. When uncertain, choose FULL_AGENT with a lower confidence.`

const FAST_CHAT_PROMPT = `You are Miki in lightweight conversational mode. Answer the user's request using only the recent conversation and your general knowledge. Do not claim to have inspected files, called tools, searched the web, changed settings, or completed an external action.

Return only JSON with this shape:
{"answer":"the helpful conversational response","requires_full_agent":false}

Set requires_full_agent to true if satisfying the request requires any external information retrieval, file or workspace access, memory, skill, browser/network action, approval, tool execution, planning, verification, or other action outside a direct conversational response. If uncertain, set it to true and keep the answer brief.`

function recentHistory(history: EngineMessage[], limit: number): EngineMessage[] {
  return history
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-limit)
}

function parseObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function confidence(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : Number(value)
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : undefined
}

function completionOptions(signal?: AbortSignal, json = true): LLMCompletionOptions {
  return {
    json,
    signal,
    temperature: 0,
    maxCompletionTokens: json ? 160 : 768,
  }
}

export class MessageRouter {
  private readonly recentMessageLimit: number

  constructor(private readonly options: MessageRouterOptions) {
    this.recentMessageLimit = options.recentMessageLimit ?? 8
  }

  async route(
    history: EngineMessage[],
    model?: string,
    signal?: AbortSignal,
  ): Promise<MessageRouteDecision> {
    const started = Date.now()
    const llm = this.options.llmFor(model)
    if (!llm) {
      return { mode: "FULL_AGENT", confidence: 0, latencyMs: Date.now() - started, reason: "No model available for semantic routing." }
    }

    try {
      const response = await llm.complete(
        [
          { role: "system", content: ROUTER_PROMPT },
          {
            role: "user",
            content: JSON.stringify({ conversation: recentHistory(history, this.recentMessageLimit) }),
          },
        ],
        completionOptions(signal),
      )
      const text = response.choices?.[0]?.message?.content
      const parsed = typeof text === "string" ? parseObject(text) : undefined
      const parsedConfidence = parsed ? confidence(parsed.confidence) : undefined
      const mode = parsed?.mode
      const latencyMs = Date.now() - started
      if ((mode !== "FAST_CHAT" && mode !== "FULL_AGENT") || parsedConfidence === undefined) {
        const decision = { mode: "FULL_AGENT" as const, confidence: 0, latencyMs, reason: "Semantic router returned an invalid decision." }
        this.options.log?.("message-router.route", decision)
        return decision
      }
      const decision: MessageRouteDecision = {
        mode: mode as MessageRouteMode,
        confidence: parsedConfidence,
        latencyMs,
        ...(typeof parsed.reason === "string" ? { reason: parsed.reason.slice(0, 240) } : {}),
      }
      this.options.log?.("message-router.route", { ...decision })
      return decision
    } catch (error) {
      const decision = {
        mode: "FULL_AGENT" as const,
        confidence: 0,
        latencyMs: Date.now() - started,
        reason: error instanceof Error ? `Semantic router failed: ${error.message}` : "Semantic router failed.",
      }
      this.options.log?.("message-router.route", decision)
      return decision
    }
  }

  async fastChat(
    history: EngineMessage[],
    model?: string,
    signal?: AbortSignal,
  ): Promise<FastChatResult> {
    const started = Date.now()
    const llm = this.options.llmFor(model)
    if (!llm) throw new Error("No model is configured for fast chat.")
    const response = await llm.complete(
      [
        { role: "system", content: FAST_CHAT_PROMPT },
        ...recentHistory(history, this.recentMessageLimit),
      ],
      completionOptions(signal),
    )
    const text = response.choices?.[0]?.message?.content
    const parsed = typeof text === "string" ? parseObject(text) : undefined
    const answer = parsed && typeof parsed.answer === "string" ? parsed.answer.trim() : ""
    const requiresFullAgent = parsed?.requires_full_agent === true
    const latencyMs = Date.now() - started
    this.options.log?.("message-router.fast_chat", { latencyMs, requiresFullAgent, answerLength: answer.length })
    if (!answer || (parsed && typeof parsed.requires_full_agent !== "boolean")) {
      return { answer: "", requiresFullAgent: true, latencyMs }
    }
    return { answer, requiresFullAgent, latencyMs }
  }
}
