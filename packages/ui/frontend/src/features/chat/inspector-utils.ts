import type { ChatMessage } from "@/store/chat"

/** Convert supported chat timestamp formats to milliseconds since the epoch. */
export function parseInspectorTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.abs(value) < 1_000_000_000_000 ? value * 1000 : value
  }

  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined

  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed)
    if (!Number.isFinite(numeric)) return undefined
    return Math.abs(numeric) < 1_000_000_000_000
      ? numeric * 1000
      : numeric
  }

  const parsed = Date.parse(trimmed)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function formatInspectorTime(value: unknown): string {
  const timestamp = parseInspectorTimestamp(value)
  if (timestamp === undefined) return "—"

  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(new Date(timestamp))
  } catch {
    return "—"
  }
}

export function getMessageRunIds(messages: ChatMessage[]): Set<string> {
  return new Set(
    messages
      .map((message) => message.runId)
      .filter((runId): runId is string => Boolean(runId)),
  )
}

export function scopeActivityNodes<T extends { runId: string }>(
  nodes: T[],
  runIds: ReadonlySet<string>,
): T[] {
  if (runIds.size === 0) return []
  return nodes.filter((node) => runIds.has(node.runId))
}

function isUserFacingAssistantMessage(message: ChatMessage): boolean {
  return (
    message.role === "assistant" &&
    !message.inspectorOnly &&
    !["thought", "tool_calls", "action_update"].includes(
      message.kind ?? "normal",
    ) &&
    (message.content.trim().length > 0 ||
      Boolean(message.attachments?.length) ||
      Boolean(message.voice?.transcript))
  )
}

/** Return the newest visible assistant response, not the first assistant event. */
export function getLatestAssistantResponse(
  messages: ChatMessage[],
): ChatMessage | undefined {
  let latest: ChatMessage | undefined
  let latestTimestamp = Number.NEGATIVE_INFINITY
  let latestIndex = -1

  messages.forEach((message, index) => {
    if (!isUserFacingAssistantMessage(message)) return

    const parsedTimestamp = parseInspectorTimestamp(message.timestamp)
    const timestamp = parsedTimestamp ?? Number.NEGATIVE_INFINITY
    if (
      !latest ||
      timestamp > latestTimestamp ||
      (timestamp === latestTimestamp && index > latestIndex)
    ) {
      latest = message
      latestTimestamp = timestamp
      latestIndex = index
    }
  })

  return latest
}
