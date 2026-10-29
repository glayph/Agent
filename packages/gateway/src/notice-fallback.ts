/**
 * When no model is available to write a background notice, the user still has to learn that something
 * happened. This builds a plain, factual line from the event fields only (no prose is invented):
 * `[type] key=value; key=value`. It is used only as the last resort after the model path and the
 * provider `detail` text are both unavailable.
 */
const MAX_VALUE_CHARS = 200
const MAX_TOTAL_CHARS = 600

export function factualNoticeFromEvent(event: Record<string, unknown> | undefined): string {
  if (!event) return ""
  const type = typeof event.type === "string" && event.type.trim() ? event.type.trim() : "event"
  const parts: string[] = []
  for (const [key, value] of Object.entries(event)) {
    if (key === "type") continue
    let text = ""
    if (typeof value === "string") text = value.trim()
    else if (typeof value === "number" || typeof value === "boolean") text = String(value)
    else if (Array.isArray(value)) {
      text = value
        .map((item) => (item && typeof item === "object" && typeof (item as Record<string, unknown>).title === "string" ? String((item as Record<string, unknown>).title) : typeof item === "string" || typeof item === "number" ? String(item) : ""))
        .filter(Boolean)
        .join(", ")
    }
    if (!text) continue
    parts.push(`${key}=${text.replace(/\s+/g, " ").slice(0, MAX_VALUE_CHARS)}`)
  }
  return `[${type}]${parts.length ? ` ${parts.join("; ")}` : ""}`.slice(0, MAX_TOTAL_CHARS)
}
