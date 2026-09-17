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
  tool: "#FFB45C",
  skill: "#A8B8C8",
  plugin: "#B8B8B8",
  file: "#8F98A3",
  command: "#777777",
  pattern: "#FFC477",
  system: "#5D6470",
}

export const STATUS_COLOR: Record<MonitorNodeStatus, string> = {
  pending: "#5D6470",
  running: "#FFB45C",
  retrying: "#B8B8B8",
  completed: "#FFC477",
  failed: "#f87171",
}
