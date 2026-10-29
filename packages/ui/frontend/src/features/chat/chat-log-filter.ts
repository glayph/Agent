type ChatMessageCandidate = {
  role?: unknown
  kind?: unknown
  content?: unknown
}

const SYSTEM_STATUS_KINDS = new Set(["error"])

const MODEL_CONFIGURATION_LOG =
  /No model is configured|No model name is configured|No API key is set for provider/i
const QUOTA_LOG = /quota\s+(?:limit\s+)?(?:reached|exceeded|exhausted)|rate\s*limit|too many requests|\b429\b/i
const PROVIDER_CONNECTION_LOG =
  /\bprovider[._\s-]*(?:plugin[._\s-]*)?(?:ready|connected|connecting|disconnected|disconnecting)\b|\b(?:model|provider|openai|gemini|openrouter|llama(?:\.cpp)?)\b.{0,80}\b(?:connection|connect(?:ed|ing)?|disconnected|disconnecting|ready|initialized|initializing)\b|\b(?:connection|connected|connecting|disconnected|disconnecting|ready|initialized|initializing)\b.{0,80}\b(?:model|provider|openai|gemini|openrouter|llama(?:\.cpp)?)\b/i

/**
 * Hide internal runtime/log messages from the conversation while preserving
 * user messages and assistant replies, including proactive replies and updates.
 */
export function isChatLogMessage(candidate: ChatMessageCandidate): boolean {
  const role = typeof candidate.role === "string" ? candidate.role.toLowerCase() : ""
  if (role === "user") return false
  if (role === "system") return true

  const kind = typeof candidate.kind === "string" ? candidate.kind.toLowerCase() : ""
  if (SYSTEM_STATUS_KINDS.has(kind)) return true

  const content = typeof candidate.content === "string" ? candidate.content : ""
  return (
    MODEL_CONFIGURATION_LOG.test(content) ||
    QUOTA_LOG.test(content) ||
    PROVIDER_CONNECTION_LOG.test(content)
  )
}
