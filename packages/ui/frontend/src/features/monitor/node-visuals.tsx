import {
  IconAlertTriangle,
  IconCheck,
  IconLoader2,
  IconRefresh,
} from "@tabler/icons-react"

import { STATUS_COLOR } from "@/features/monitor/node-visuals.constants"
import type { MonitorNodeStatus } from "@/features/monitor/store"

export function StatusIcon({
  status,
  size = 14,
}: {
  status: MonitorNodeStatus
  size?: number
}) {
  const color = STATUS_COLOR[status]
  if (status === "running") {
    return (
      <IconLoader2 size={size} className="animate-spin" style={{ color }} />
    )
  }
  if (status === "retrying") {
    return (
      <IconRefresh size={size} className="animate-spin" style={{ color }} />
    )
  }
  if (status === "completed") {
    return <IconCheck size={size} style={{ color }} />
  }
  if (status === "failed") {
    return <IconAlertTriangle size={size} style={{ color }} />
  }
  return <span className="size-2 rounded-full" style={{ background: color }} />
}
