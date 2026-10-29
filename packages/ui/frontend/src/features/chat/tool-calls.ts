import type { ChatToolCall } from "@/store/chat"

function parseLegacyToolFeedbackContent(
  content: string,
): ChatToolCall[] | undefined {
  const trimmed = content.trim()
  const match =
    /^🔧\s+`([^`\n\r]*?)(?:\.{1,2})?`[^\n\r]*(?:\r?\n([\s\S]*))?$/.exec(trimmed)
  if (!match) {
    return undefined
  }

  const toolName = match[1]?.trim() ?? ""
  const body = match[2]?.trim() ?? ""
  const codeFence = /```(?:json)?\r?\n([\s\S]*?)\r?\n```/m.exec(body)
  const argumentsText = codeFence?.[1]?.trim() ?? ""
  const explanation = body
    .replace(/```(?:json)?\r?\n[\s\S]*?\r?\n```/gm, "")
    .trim()

  return [
    {
      type: "function",
      function: {
        name: toolName,
        ...(argumentsText ? { arguments: argumentsText } : {}),
      },
      ...(explanation
        ? {
            extraContent: {
              toolFeedbackExplanation: explanation,
            },
          }
        : {}),
    },
  ]
}

export function parseToolCallsValue(raw: unknown): ChatToolCall[] | undefined {
  if (!Array.isArray(raw)) {
    return undefined
  }

  const toolCalls: ChatToolCall[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue
    }

    const toolCall = item as Record<string, unknown>
    const rawFunction =
      toolCall.function && typeof toolCall.function === "object"
        ? (toolCall.function as Record<string, unknown>)
        : null
    const rawExtraContent =
      toolCall.extra_content && typeof toolCall.extra_content === "object"
        ? (toolCall.extra_content as Record<string, unknown>)
        : null

    const nextToolCall: ChatToolCall = {
      ...(typeof toolCall.id === "string" ? { id: toolCall.id } : {}),
      ...(typeof toolCall.type === "string" ? { type: toolCall.type } : {}),
    }

    if (
      toolCall.status === "running" ||
      toolCall.status === "success" ||
      toolCall.status === "error"
    ) {
      nextToolCall.status = toolCall.status
    }
    if (
      typeof toolCall.duration_ms === "number" &&
      Number.isFinite(toolCall.duration_ms) &&
      toolCall.duration_ms >= 0
    ) {
      nextToolCall.durationMs = toolCall.duration_ms
    }

    if (rawFunction) {
      const name =
        typeof rawFunction.name === "string" ? rawFunction.name : undefined
      const argumentsText =
        typeof rawFunction.arguments === "string"
          ? rawFunction.arguments
          : undefined

      if (name || argumentsText) {
        nextToolCall.function = {
          ...(name ? { name } : {}),
          ...(argumentsText ? { arguments: argumentsText } : {}),
        }
      }
    }

    if (rawExtraContent) {
      const toolFeedbackExplanation =
        typeof rawExtraContent.tool_feedback_explanation === "string"
          ? rawExtraContent.tool_feedback_explanation
          : undefined

      if (toolFeedbackExplanation) {
        nextToolCall.extraContent = {
          toolFeedbackExplanation,
        }
      }
    }

    if (
      nextToolCall.id ||
      nextToolCall.type ||
      nextToolCall.status ||
      nextToolCall.function ||
      nextToolCall.extraContent
    ) {
      toolCalls.push(nextToolCall)
    }
  }

  return toolCalls.length > 0 ? toolCalls : undefined
}

export function parseToolCallsFromContent(
  content: string,
): ChatToolCall[] | undefined {
  return parseLegacyToolFeedbackContent(content)
}

export function toolCallsSignature(toolCalls?: ChatToolCall[]): string {
  return (toolCalls ?? [])
    .map((toolCall) =>
      [
        toolCall.id ?? "",
        toolCall.type ?? "",
        toolCall.function?.name ?? "",
        toolCall.function?.arguments ?? "",
        toolCall.extraContent?.toolFeedbackExplanation ?? "",
        toolCall.status ?? "",
        toolCall.durationMs ?? "",
      ].join("\u0001"),
    )
    .join("\u0002")
}

export interface ToolCallsSummary {
  count: number
  /** True when at least one call carries a reported status. */
  hasStatus: boolean
  failed: number
  running: number
  /** True only when every call reported success. */
  allSucceeded: boolean
  /** Sum of durations, only when every call reported one. Otherwise undefined: no partial totals. */
  totalDurationMs?: number
}

export function summarizeToolCalls(toolCalls: ChatToolCall[]): ToolCallsSummary {
  let failed = 0
  let running = 0
  let hasStatus = false
  let total = 0
  let allHaveDuration = toolCalls.length > 0
  let allSucceeded = toolCalls.length > 0
  for (const call of toolCalls) {
    if (call.status) hasStatus = true
    if (call.status === "error") failed += 1
    if (call.status === "running") running += 1
    if (call.status !== "success") allSucceeded = false
    if (typeof call.durationMs === "number") total += call.durationMs
    else allHaveDuration = false
  }
  return {
    count: toolCalls.length,
    hasStatus,
    failed,
    running,
    allSucceeded,
    ...(allHaveDuration ? { totalDurationMs: total } : {}),
  }
}

export type DurationParts =
  | { unit: "ms"; value: number }
  | { unit: "s"; value: string }
  | { unit: "m"; minutes: number; seconds: number }

export function splitDuration(ms: number): DurationParts {
  if (ms < 1000) return { unit: "ms", value: Math.round(ms) }
  if (ms < 60_000) return { unit: "s", value: (ms / 1000).toFixed(1) }
  const totalSeconds = Math.round(ms / 1000)
  return {
    unit: "m",
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  }
}

export function formatToolDuration(
  ms: number,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts = splitDuration(ms)
  if (parts.unit === "ms") {
    return t("chat.tools.durationMs", { value: parts.value })
  }
  if (parts.unit === "s") {
    return t("chat.tools.durationSeconds", { value: parts.value })
  }
  return t("chat.tools.durationMinutes", {
    minutes: parts.minutes,
    seconds: parts.seconds,
  })
}
