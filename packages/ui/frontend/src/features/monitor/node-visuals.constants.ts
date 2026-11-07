import {
  type Icon,
  IconActivity,
  IconBrain,
  IconBriefcase,
  IconCalendarEvent,
  IconChartBar,
  IconCloud,
  IconCode,
  IconCpu,
  IconDeviceDesktop,
  IconFileCode,
  IconFolder,
  IconGitBranch,
  IconMail,
  IconMessageCircle,
  IconNetwork,
  IconNotes,
  IconPlugConnected,
  IconSearch,
  IconSparkles,
  IconTarget,
  IconTerminal2,
  IconTool,
  IconWorld,
} from "@tabler/icons-react"

import type {
  MonitorNodeStatus,
  MonitorNodeType,
} from "@/features/monitor/store"

/** Shared canvas geometry: keep Dagre measurements identical to the rendered node cards. */
export const MONITOR_NODE_DIMENSIONS = {
  minimized: { width: 56, height: 56 },
  expanded: { width: 268, height: 168 },
} as const

/**
 * Completed/failed cards remain inspectable until their run is removed.
 * Do not fade the card itself: React Flow would leave its handles and edges behind.
 */
export function monitorNodeMotionTarget(
  status: MonitorNodeStatus,
  accent: string,
) {
  const isActive = status === "running" || status === "retrying"
  return {
    opacity: 1,
    scale: 1,
    boxShadow: isActive
      ? `0 0 0 1px ${accent}55, 0 0 22px 2px ${accent}33`
      : `0 0 0 1px rgba(255,255,255,0.06), 0 2px 10px rgba(0,0,0,0.4)`,
  }
}

/** Type fallback for older monitor events without explicit icon metadata. */
export const NODE_TYPE_ICON: Record<MonitorNodeType, Icon> = {
  agent: IconSparkles,
  tool: IconTool,
  skill: IconSparkles,
  plugin: IconPlugConnected,
  file: IconFileCode,
  command: IconTerminal2,
  pattern: IconGitBranch,
  system: IconCpu,
  browser: IconWorld,
  computer: IconDeviceDesktop,
  terminal: IconTerminal2,
  memory: IconBrain,
  mcp: IconNetwork,
  search: IconSearch,
  goal: IconTarget,
  workflow: IconGitBranch,
}

/**
 * Bundled icon registry. Plugin manifests can choose only these stable keys;
 * unknown keys fall back to the node category icon and never load remote assets.
 */
export const NODE_ICON_REGISTRY: Record<string, Icon> = {
  agent: IconSparkles,
  tool: IconTool,
  skill: IconSparkles,
  plugin: IconPlugConnected,
  file: IconFileCode,
  folder: IconFolder,
  command: IconTerminal2,
  terminal: IconTerminal2,
  pattern: IconGitBranch,
  system: IconCpu,
  browser: IconWorld,
  computer: IconDeviceDesktop,
  memory: IconBrain,
  mcp: IconNetwork,
  search: IconSearch,
  goal: IconTarget,
  workflow: IconGitBranch,
  activity: IconActivity,
  github: IconCode,
  slack: IconMessageCircle,
  gmail: IconMail,
  calendar: IconCalendarEvent,
  notion: IconNotes,
  linear: IconChartBar,
  hubspot: IconBriefcase,
  salesforce: IconBriefcase,
  jira: IconGitBranch,
  drive: IconCloud,
  discord: IconMessageCircle,
}

export const NODE_TYPE_LABEL: Record<MonitorNodeType, string> = {
  agent: "Agent",
  tool: "Tool",
  skill: "Skill",
  plugin: "Plugin",
  file: "File",
  command: "Command",
  pattern: "Working Pattern",
  system: "System",
  browser: "Browser",
  computer: "Computer",
  terminal: "Terminal",
  memory: "Memory",
  mcp: "MCP",
  search: "Web Search",
  goal: "Goal",
  workflow: "Workflow",
}

export const NODE_TYPE_ACCENT: Record<MonitorNodeType, string> = {
  agent: "#6EE7B7",
  tool: "#FFB45C",
  skill: "#A8B8C8",
  plugin: "#B8B8B8",
  file: "#8F98A3",
  command: "#777777",
  pattern: "#FFC477",
  system: "#5D6470",
  browser: "#60A5FA",
  computer: "#A78BFA",
  terminal: "#9CA3AF",
  memory: "#34D399",
  mcp: "#22D3EE",
  search: "#38BDF8",
  goal: "#FBBF24",
  workflow: "#C084FC",
}

export const STATUS_COLOR: Record<MonitorNodeStatus, string> = {
  pending: "#5D6470",
  running: "#FFB45C",
  retrying: "#B8B8B8",
  completed: "#FFC477",
  failed: "#f87171",
}
