import type {
  MonitorNode,
  MonitorNodeStatus,
  MonitorNodeType,
} from "@/features/monitor/store"

const TYPE_LABEL: Record<MonitorNodeType, string> = {
  tool: "Tool",
  skill: "Skill",
  plugin: "Plugin",
  file: "File",
  command: "Command",
  pattern: "Workflow",
  system: "System",
}

export function humanizeActivityLabel(value: string): string {
  const normalized = value
    .replace(/^(skill|plugin|file|command|pattern|system|tool):/i, "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()

  if (!normalized) return "Working"

  return normalized.replace(/\b\w/g, (character) => character.toUpperCase())
}

export function activityTitle(node: MonitorNode): string {
  return humanizeActivityLabel(node.label)
}

export function activityTypeLabel(type: MonitorNodeType): string {
  return TYPE_LABEL[type]
}

export function activityStatusLabel(status: MonitorNodeStatus): string {
  switch (status) {
    case "running":
      return "In progress"
    case "retrying":
      return "Retrying"
    case "completed":
      return "Completed"
    case "failed":
      return "Needs attention"
    default:
      return "Queued"
  }
}

export function formatActivityDuration(durationMs?: number): string {
  if (!durationMs || durationMs < 0) return "—"
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`
  return `${(durationMs / 1000).toFixed(1)}s`
}

export function formatActivityTime(timestamp?: number): string {
  if (!timestamp) return ""
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(timestamp)
}

export function activitySummary(node: MonitorNode): string {
  if (node.status === "completed" || node.status === "failed") {
    if (node.resultMessage) return node.resultMessage
  }
  if (node.status === "running" || node.status === "retrying") {
    if (node.action) return node.action
  }

  const title = activityTitle(node)
  switch (node.status) {
    case "running":
      return `${title} is working now.`
    case "retrying":
      return `${title} is retrying after a failed attempt.`
    case "completed":
      return `${title} finished successfully.`
    case "failed":
      return `${title} needs attention.`
    default:
      return `${title} is queued.`
  }
}
