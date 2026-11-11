/** Wire-format helpers for the tool-call status the chat UI shows. Only real engine data is forwarded. */
export type WireToolStatus = "running" | "success" | "error"

export function wireToolStatus(status: string): WireToolStatus | undefined {
  switch (status) {
    case "requested":
    case "awaiting_approval":
    case "running":
      return "running"
    case "succeeded":
      return "success"
    case "failed":
    case "denied":
    case "blocked":
    case "cancelled":
      return "error"
    default:
      return undefined
  }
}

/** `status` / `duration_ms` fields for a tool call; a missing or invalid value is omitted, never guessed. */
export function wireToolCallExtras(call: { status: string; durationMs?: number }): { status?: WireToolStatus; duration_ms?: number } {
  const status = wireToolStatus(call.status)
  const duration = call.durationMs
  return {
    ...(status ? { status } : {}),
    ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0 ? { duration_ms: Math.round(duration) } : {}),
  }
}
