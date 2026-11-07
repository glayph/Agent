const LAST_SESSION_STORAGE_KEY = "Miki:last-session-id"
export const SINGLE_CHAT_SESSION_ID = "miki-main-chat"
const UNIX_MS_THRESHOLD = 1e12

function readStorageValue() {
  return (
    globalThis.localStorage?.getItem(LAST_SESSION_STORAGE_KEY)?.trim() || ""
  )
}

export function readStoredSessionId(): string {
  return readStorageValue()
}

export function writeStoredSessionId(sessionId: string) {
  if (sessionId) {
    globalThis.localStorage?.setItem(LAST_SESSION_STORAGE_KEY, sessionId)
    return
  }

  globalThis.localStorage?.removeItem(LAST_SESSION_STORAGE_KEY)
}

export function clearStoredSessionId() {
  globalThis.localStorage?.removeItem(LAST_SESSION_STORAGE_KEY)
}


export function clearSessionIdFromHash() {
  if (typeof window === "undefined") return
  const hash = window.location.hash
  if (hash.includes("session=")) {
    const cleaned = hash.replace(/[#&]session=[^&]*/, "").replace(/^#/, "")
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${cleaned ? `#${cleaned}` : ""}`,
    )
  }
}

export function getInitialActiveSessionId(): string {
  // Miki intentionally has one durable conversation. Ignore legacy local
  // session selections and shared-session hashes so every launch returns to
  // the canonical transcript.
  return SINGLE_CHAT_SESSION_ID
}

export function normalizeUnixTimestamp(timestamp: number): number {
  return timestamp < UNIX_MS_THRESHOLD ? timestamp * 1000 : timestamp
}
