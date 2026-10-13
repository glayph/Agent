import type { RunActivity } from "@/store/chat"

/** A model that has produced nothing for this long is called out as slow. */
export const SLOW_MODEL_SECONDS = 60
/** Heartbeats arrive every 5s; if none arrived for this long the data is stale and hidden. */
export const STALE_AFTER_MS = 30_000

export function formatElapsed(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`
}

const isCommandTool = (label?: string) => Boolean(label && label.startsWith("terminal_"))

/** Pure so it can be tested: what to say for a given activity and how long it has been quiet. */
export function describeRunActivity(
  activity: RunActivity,
  idleSeconds: number,
): { text: string; slow: boolean } {
  switch (activity.activity) {
    case "model":
      return idleSeconds >= SLOW_MODEL_SECONDS
        ? {
            text: `The model is slow to answer (nothing for ${formatElapsed(idleSeconds)}). You can keep waiting or press Stop.`,
            slow: true,
          }
        : { text: "Waiting for the model", slow: false }
    case "writing":
      return { text: "Writing the answer", slow: false }
    case "approval":
      return { text: "Waiting for your approval", slow: false }
    case "tool":
      return {
        text: isCommandTool(activity.label)
          ? "Running a command (it is never stopped automatically)"
          : `Using ${activity.label || "a tool"}`,
        slow: false,
      }
  }
}

