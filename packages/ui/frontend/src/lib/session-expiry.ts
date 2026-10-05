import { useSyncExternalStore } from "react"

/** Show the top warning banner only when this little time is left. */
export const SESSION_WARNING_THRESHOLD_MS = 5 * 60 * 1000

let expiresAt: number | null = null
let now = Date.now()
let timer: ReturnType<typeof globalThis.setInterval> | null = null
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((listener) => listener())

function ensureTimer() {
  if (timer !== null || listeners.size === 0) return
  timer = globalThis.setInterval(() => {
    now = Date.now()
    emit()
  }, 1000)
}

function clearTimerIfIdle() {
  if (listeners.size === 0 && timer !== null) {
    globalThis.clearInterval(timer)
    timer = null
  }
}

export function setSessionExpiresAt(value: number | null) {
  expiresAt = value
  now = Date.now()
  emit()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  ensureTimer()
  return () => {
    listeners.delete(listener)
    clearTimerIfIdle()
  }
}

/** Remaining session time in ms, or null when unknown. Ticks every second. */
export function useSessionRemainingMs(): number | null {
  const tick = useSyncExternalStore(
    subscribe,
    () => now,
    () => now,
  )
  return expiresAt === null ? null : expiresAt - tick
}

/** Compact human format: 29d 23h / 12h 05m / 4:32. */
export function formatSessionRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}d ${String(hours).padStart(2, "0")}h`
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`
  return `${minutes}:${String(seconds).padStart(2, "0")}`
}
