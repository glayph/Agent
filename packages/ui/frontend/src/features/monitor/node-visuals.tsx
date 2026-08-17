import {
  IconAlertTriangle,
  IconCheck,
  IconCpu,
  IconLoader2,
  IconPlugConnected,
  IconRefresh,
  IconSparkles,
  IconTool,
  type Icon,
} from "@tabler/icons-react"

import type { MonitorNodeStatus, MonitorNodeType } from "@/features/monitor/store"

export const NODE_TYPE_ICON: Record<MonitorNodeType, Icon> = {
  tool: IconTool,
  skill: IconSparkles,
  plugin: IconPlugConnected,
  pattern: IconCpu,
  system: IconCpu,
}

export const NODE_TYPE_LABEL: Record<MonitorNodeType, string> = {
  tool: "Tool",
  skill: "Skill",
  plugin: "Plugin",
  pattern: "Working Pattern",
  system: "System",
}

export const NODE_TYPE_ACCENT: Record<MonitorNodeType, string> = {
  tool: "#6ee7ff",
  skill: "#c084fc",
  plugin: "#fbbf24",
  pattern: "#34d399",
  system: "#f472b6",
}

export const STATUS_COLOR: Record<MonitorNodeStatus, string> = {
  pending: "#6b7280",
  running: "#38bdf8",
  retrying: "#f59e0b",
  completed: "#34d399",
  failed: "#f87171",
}

export function StatusIcon({
  status,
  size = 14,
}: {
  status: MonitorNodeStatus
  size?: number
}) {
  const color = STATUS_COLOR[status]
  if (status === "running") {
    return <IconLoader2 size={size} className="animate-spin" style={{ color }} />
  }
  if (status === "retrying") {
    return <IconRefresh size={size} className="animate-spin" style={{ color }} />
  }
  if (status === "completed") {
    return <IconCheck size={size} style={{ color }} />
  }
  if (status === "failed") {
    return <IconAlertTriangle size={size} style={{ color }} />
  }
  return <span className="size-2 rounded-full" style={{ background: color }} />
}
