const VISIBLE_REPLY_CHAR_LIMIT = 180
const VISIBLE_REPLY_LINE_LIMIT = 2

function shortVisibleReply(content: string): string {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const compact = lines.slice(0, VISIBLE_REPLY_LINE_LIMIT).join(" ")
  if (compact.length <= VISIBLE_REPLY_CHAR_LIMIT) return compact
  return `${compact.slice(0, VISIBLE_REPLY_CHAR_LIMIT - 1).trimEnd()}…`
}

export function preservesFullAssistantContent(content: string): boolean {
  const trimmed = content.trim()
  if (!trimmed) return false
  if (trimmed.startsWith("``")) return true
  if (/\[[^\]]+\]\(https?:\/\/[^)]+\)/i.test(trimmed)) return true
  if (/^(?:def|function)\s+[A-Za-z_]\w*\s*\(/.test(trimmed)) {
    return true
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return false
  try {
    JSON.parse(trimmed)
    return true
  } catch {
    return false
  }
}

export function visibleAssistantContent(content: string): string {
  const trimmed = content.trim()
  return preservesFullAssistantContent(trimmed)
    ? trimmed
    : shortVisibleReply(trimmed)
}
