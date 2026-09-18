import type { AutonomyMode } from "./types.js";

export type AutonomyCommandAction =
  "set_mode" | "enable" | "disable" | "pause" | "resume" | "status";

export interface AutonomyCommand {
  action: AutonomyCommandAction;
  mode?: AutonomyMode;
}

/**
 * Lets the user control autonomy purely through ordinary chat, mirroring
 * the existing `parseAutomationMessage` pattern in automation.ts (a small,
 * pre-LLM message check) rather than requiring a UI. Examples this matches:
 *   "Hey miki, use the turbo mode"
 *   "switch to turbo mode"
 *   "turn off autonomy"
 *   "pause autonomous work"
 *   "what's your current objective?" → status
 *
 * Standard mode has been removed (owner-requested): turbo is the only
 * operating mode, so "use standard/normal mode" is no longer a recognized
 * command — it falls through and returns null like any other unrelated
 * chat message, and the agent stays in turbo.
 *
 * Returns null for anything that isn't clearly an autonomy command, so
 * ordinary conversation is never misrouted.
 */
export function parseAutonomyCommand(message: string): AutonomyCommand | null {
  const text = message.toLowerCase().trim();
  if (!text) return null;

  if (/\bturbo\b/.test(text) && /\bmode\b|\bturbo\b/.test(text)) {
    if (
      /\b(use|switch|go|enable|set|activate)\b/.test(text) ||
      /\bturbo mode\b/.test(text)
    ) {
      return { action: "set_mode", mode: "turbo" };
    }
  }

  if (/\bautonom(y|ous)\b/.test(text)) {
    if (/\b(disable|turn off|stop)\b/.test(text)) return { action: "disable" };
    if (/\b(enable|turn on|start)\b/.test(text)) return { action: "enable" };
    if (/\bpause\b/.test(text)) return { action: "pause" };
    if (/\bresume\b|\bcontinue\b/.test(text)) return { action: "resume" };
    if (/\bstatus\b|\bwhat.*doing\b|\bcurrent objective\b/.test(text)) {
      return { action: "status" };
    }
  }

  if (/\bcurrent objective\b|\bwhat are you working on\b/.test(text)) {
    return { action: "status" };
  }

  return null;
}
