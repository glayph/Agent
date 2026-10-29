import { IconAlertCircle, IconCircleCheck, IconLoader2 } from "@tabler/icons-react"
import { useTranslation } from "react-i18next"

import {
  formatToolDuration,
  summarizeToolCalls,
  type ToolCallsSummary,
} from "@/features/chat/tool-calls"
import type { ChatToolCall } from "@/store/chat"

/** Status icon for the collapsed "Used N tools" row. A failed tool is red even while collapsed. */
export function ToolStatusMark({
  summary,
}: {
  summary: ToolCallsSummary
}) {
  const { t } = useTranslation()
  if (summary.failed > 0) {
    const label = t("chat.tools.failedCount", { count: summary.failed })
    return (
      <span
        className="text-destructive inline-flex items-center gap-1 text-[12px] font-medium"
        role="img"
        aria-label={label}
        title={label}
      >
        <IconAlertCircle className="size-3.5" aria-hidden="true" />
        {label}
      </span>
    )
  }
  if (summary.running > 0) {
    const label = t("chat.tools.statusRunning")
    return (
      <span
        className="text-muted-foreground inline-flex items-center"
        role="img"
        aria-label={label}
        title={label}
      >
        <IconLoader2 className="size-3.5 animate-spin" aria-hidden="true" />
      </span>
    )
  }
  if (!summary.allSucceeded) return null
  const label = t("chat.tools.statusSuccess")
  return (
    <span
      className="inline-flex items-center text-emerald-600 dark:text-emerald-400"
      role="img"
      aria-label={label}
      title={label}
    >
      <IconCircleCheck className="size-3.5" aria-hidden="true" />
    </span>
  )
}

/** Status icon and total duration for a message's tool calls. Renders nothing when the gateway reported neither. */
export function ToolCallSummaryMeta({
  toolCalls,
}: {
  toolCalls?: ChatToolCall[]
}) {
  const { t } = useTranslation()
  if (!toolCalls || toolCalls.length === 0) return null
  const summary = summarizeToolCalls(toolCalls)
  const duration =
    summary.totalDurationMs === undefined
      ? ""
      : formatToolDuration(summary.totalDurationMs, t)
  if (!summary.hasStatus && !duration) return null
  return (
    <span className="ml-auto flex items-center gap-2">
      {summary.hasStatus && <ToolStatusMark summary={summary} />}
      {duration && (
        <span className="text-muted-foreground/70 font-normal tabular-nums">
          {duration}
        </span>
      )}
    </span>
  )
}
