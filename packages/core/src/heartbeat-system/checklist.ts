import * as fs from "node:fs";
import * as path from "node:path";
import type { ChecklistItem, HeartbeatResponseType } from "./types.js";

/**
 * Parse HEARTBEAT.md into checklist items.
 * Rules:
 * - Skip empty lines and lines starting with # (markdown headers/comments)
 * - Support "- task", "* task", "1. task", or plain lines
 * - Optional type prefix: [notify] [tool] [memory] [noop]
 */
export function parseChecklistMarkdown(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith("#")) continue;
    // strip list markers
    line = line.replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "");
    if (!line) continue;
    items.push({ line: i + 1, text: line });
  }
  return items;
}

export function loadChecklistFile(filePath: string): ChecklistItem[] {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, "utf8");
    return parseChecklistMarkdown(content);
  } catch {
    return [];
  }
}

export function resolveChecklistPath(
  checklistPath: string | undefined,
  workspaceRoot: string,
  role?: string,
): string {
  // Role-specific override: identity/agents/<role>/HEARTBEAT.md when present
  if (role) {
    const rolePath = path.join(
      workspaceRoot,
      "identity",
      "agents",
      role,
      "HEARTBEAT.md",
    );
    try {
      if (fs.existsSync(rolePath)) return rolePath;
    } catch {
      // fall through
    }
  }
  const rel = checklistPath || "identity/HEARTBEAT.md";
  if (path.isAbsolute(rel)) return rel;
  return path.join(workspaceRoot, rel);
}

/** Default classifier from optional [type] prefix on the line. */
export function defaultClassify(item: ChecklistItem): HeartbeatResponseType {
  const m = item.text.match(/^\[(notify|tool|memory|noop)\]\s*/i);
  if (!m) return "no_op";
  switch (m[1]!.toLowerCase()) {
    case "notify":
      return "proactive_notify";
    case "tool":
      return "silent_tool_run";
    case "memory":
      return "memory_update";
    default:
      return "no_op";
  }
}

/** Strip type prefix for display / execution text. */
export function stripTypePrefix(text: string): string {
  return text.replace(/^\[(notify|tool|memory|noop)\]\s*/i, "").trim();
}
