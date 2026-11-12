type ChatMessageCandidate = {
  role?: unknown
  kind?: unknown
  content?: unknown
  context_id?: unknown
  notification_kind?: unknown
}

const HIDDEN_NOTIFICATION_KINDS = new Set(["progress", "warning"])

/**
 * Hide only messages explicitly classified as runtime notifications.
 *
 * Do not inspect assistant text for words such as "quota" or "provider".
 * Those heuristics used to delete legitimate answers that happened to mention
 * the same words. User-facing errors remain visible and are rendered by the
 * assistant error treatment.
 */
export function isChatLogMessage(candidate: ChatMessageCandidate): boolean {
  const role = typeof candidate.role === "string" ? candidate.role.toLowerCase() : ""
  if (role === "user") return false
  if (role === "system") return true

  const notificationKind =
    typeof candidate.notification_kind === "string"
      ? candidate.notification_kind.toLowerCase()
      : ""
  if (HIDDEN_NOTIFICATION_KINDS.has(notificationKind)) return true

  // Older proactive rows did not persist notification_kind. Keep those
  // legacy progress rows hidden, while allowing explicitly classified result
  // and discovery notices to reach the transcript.
  if (
    typeof candidate.context_id === "string" &&
    candidate.context_id.startsWith("proactive:") &&
    !notificationKind
  ) {
    return true
  }

  return false
}
