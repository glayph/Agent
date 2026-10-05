/** Tool groups the dashboard can toggle, keyed by their config key. */
export const TOOL_GROUP_KEYS = ["filesystem", "memory", "skills", "control", "goals", "web_search", "browser", "terminal", "computer"] as const
export type ToolGroupKey = (typeof TOOL_GROUP_KEYS)[number]

/**
 * The dashboard sends the group's display name (e.g. "web-search",
 * "agent-control") while config stores the key (e.g. "web_search",
 * "control"). Accept both so a toggle never 404s.
 */
const ALIASES: Record<string, ToolGroupKey> = {
  "web-search": "web_search",
  websearch: "web_search",
  "agent-control": "control",
  agent_control: "control",
  "agent-goals": "goals",
  shell: "terminal",
  "computer-use": "computer",
  computer_use: "computer",
}

export function resolveToolGroupKey(name: string): ToolGroupKey | undefined {
  const normalized = name.trim().toLowerCase()
  if ((TOOL_GROUP_KEYS as readonly string[]).includes(normalized)) return normalized as ToolGroupKey
  return ALIASES[normalized]
}
