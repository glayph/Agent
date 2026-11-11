/** Tool groups the dashboard can toggle, keyed by their config key. */
export const TOOL_GROUP_KEYS = ["filesystem", "memory", "skills", "control", "models", "goals", "web_search", "browser", "terminal", "computer", "plugins", "mcp"] as const
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
  "model-management": "models",
  model_management: "models",
  "agent-goals": "goals",
  shell: "terminal",
  "computer-use": "computer",
  computer_use: "computer",
  "installed-plugins": "plugins",
  plugin: "plugins",
  "external-mcp": "mcp",
  "mcp-connectors": "mcp",
}

export function resolveToolGroupKey(name: string): ToolGroupKey | undefined {
  const normalized = name.trim().toLowerCase()
  if ((TOOL_GROUP_KEYS as readonly string[]).includes(normalized)) return normalized as ToolGroupKey
  return ALIASES[normalized]
}

/** Resolve a group's effective state without conflating approval policy with capability policy. */
export function resolveToolGroupEnabled(
  configuredValue: unknown,
  defaultEnabled: boolean,
  hardPolicyAllowed = true,
): boolean {
  const configuredEnabled = typeof configuredValue === "boolean" ? configuredValue : defaultEnabled;
  return configuredEnabled && hardPolicyAllowed;
}
