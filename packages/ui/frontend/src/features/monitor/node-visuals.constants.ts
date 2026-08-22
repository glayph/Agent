import {
  type Icon,
  IconCpu,
  IconFileCode,
  IconPlugConnected,
  IconSparkles,
  IconTerminal2,
  IconTool,
} from "@tabler/icons-react"

import type {
  MonitorNodeStatus,
  MonitorNodeType,
} from "@/features/monitor/store"

export const NODE_TYPE_ICON: Record<MonitorNodeType, Icon> = {
  tool: IconTool,
  skill: IconSparkles,
  plugin: IconPlugConnected,
  file: IconFileCode,
  command: IconTerminal2,
  pattern: IconCpu,
  system: IconCpu,
}

export const NODE_TYPE_LABEL: Record<MonitorNodeType, string> = {
  tool: "Tool",
  skill: "Skill",
  plugin: "Plugin",
  file: "File",
  command: "Command",
  pattern: "Working Pattern",
  system: "System",
}

export const NODE_TYPE_ACCENT: Record<MonitorNodeType, string> = {
  tool: "#6ee7ff",
  skill: "#c084fc",
  plugin: "#fbbf24",
  file: "#fb923c",
  command: "#fdba74",
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
