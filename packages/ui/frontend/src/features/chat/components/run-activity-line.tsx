import { useAtomValue } from "jotai"
import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"
import {
  describeRunActivity,
  formatElapsed,
  STALE_AFTER_MS,
} from "@/features/chat/run-activity"
import { chatAtom } from "@/store/chat"

export function RunActivityLine() {
  const { isTyping, runActivity, runningRunIds, activeRunId } =
    useAtomValue(chatAtom)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!isTyping) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isTyping])

  if (!isTyping || !runActivity) return null
  const belongsToRun =
    runningRunIds.includes(runActivity.runId) || activeRunId === runActivity.runId
  if (!belongsToRun || now - runActivity.receivedAt > STALE_AFTER_MS) return null

  const sinceBeat = Math.max(0, Math.floor((now - runActivity.receivedAt) / 1000))
  const elapsed = runActivity.elapsedSeconds + sinceBeat
  const idle = runActivity.idleSeconds + sinceBeat
  const { text, slow } = describeRunActivity(runActivity, idle)

  return (
    <div
      role="status"
      aria-live="off"
      data-testid="run-activity"
      className={cn(
        "flex flex-wrap items-center gap-x-2 py-1 text-[11px]",
        slow ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground/80",
      )}
    >
      <span className="[overflow-wrap:anywhere]">
        {text}
      </span>
      <span className="tabular-nums opacity-70">{formatElapsed(elapsed)}</span>
    </div>
  )
}
