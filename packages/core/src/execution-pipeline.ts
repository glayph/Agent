import { parseAutonomyMessage } from "./autonomy/autonomous-goal-manager.js";
import { classifyAgentTask, type AgentTaskProfile } from "./task-profile.js";

export type ExecutionMode = "simple_message" | "task" | "autonomous_task";

export interface ExecutionPipelineDecision {
  mode: ExecutionMode;
  profile: AgentTaskProfile;
  reason: string;
  useTools: boolean;
  requiresVerification: boolean;
  iterative: boolean;
}

const TASK_MARKERS = [
  "implement",
  "build",
  "create",
  "write",
  "edit",
  "fix",
  "debug",
  "run",
  "execute",
  "update",
  "change",
  "test",
  "verify",
  "file",
  "repository",
  "repo",
  "code",
  "ফাইল",
  "তৈরি",
  "ঠিক",
  "লিখ",
  "চালাও",
];

const SKILL_MANAGEMENT_MARKER =
  /(?:\bskills?\b|\bskill\s+(?:pack|plugin)|স্কিল)/i;
const SKILL_ACTION_MARKER =
  /(?:install|add|create|update|remove|delete|enable|disable|ইনস্টল|স্থাপন|যোগ|তৈরি|আপডেট)/i;

const AUTONOMOUS_MARKER = /(?:\[\[miki-autonomy:[^\]]+\]\]|\bautonomous(?: task| work)?\b|\bbackground task\b|\bkeep working\b|\bwork until (?:done|complete)\b|\bনিজে নিজে\b|\bস্বয়ংক্রিয়(?:ভাবে)? কাজ\b)/i;

function hasMarker(text: string): boolean {
  const normalized = text.toLowerCase();
  return TASK_MARKERS.some((marker) => normalized.includes(marker));
}

function isInformationalQuestion(text: string): boolean {
  return /[?؟]\s*$/.test(text.trim()) ||
    /^(?:what|why|how|when|where|who|which|is|are|can|could|would|do|does|কি|কেন|কীভাবে|কখন|কোথায়|কে|কোন)/i.test(
      text.trim(),
    );
}

/**
 * Single routing contract for the user/event boundary.
 *
 * This is deliberately deterministic: routing must not require an additional
 * model call. The existing task profile supplies complexity and verification
 * signals; this layer only chooses the execution mode and lets the existing
 * agent/tool/autonomy components execute it.
 */
export function classifyExecutionPipeline(
  message: string,
  profile = classifyAgentTask(message),
): ExecutionPipelineDecision {
  const autonomous = Boolean(parseAutonomyMessage(message)) || AUTONOMOUS_MARKER.test(message);
  if (autonomous) {
    return {
      mode: "autonomous_task",
      profile,
      reason: "explicit autonomous/background objective",
      useTools: true,
      requiresVerification: true,
      iterative: true,
    };
  }

  // Skill discovery and installation are actions even when phrased as a
  // conversational question. Otherwise they enter simple_message, whose
  // contract explicitly forbids tools and the model can only narrate.
  const skillManagementAction =
    SKILL_MANAGEMENT_MARKER.test(message) && SKILL_ACTION_MARKER.test(message);
  const explicitAction = hasMarker(message) || skillManagementAction;
  const task =
    explicitAction ||
    (!isInformationalQuestion(message) &&
      (profile.complexity !== "simple" || profile.verificationDepth !== "none"));
  if (task) {
    return {
      mode: "task",
      profile,
      reason: profile.complexity !== "simple" ? "task profile requires execution" : "explicit action marker",
      useTools: true,
      requiresVerification: profile.verificationDepth !== "none",
      iterative: false,
    };
  }

  return {
    mode: "simple_message",
    profile,
    reason: "no action, verification, or autonomous marker",
    useTools: false,
    requiresVerification: false,
    iterative: false,
  };
}

export function formatExecutionPipelineDecision(
  decision: ExecutionPipelineDecision,
): string {
  return [
    `[Execution Pipeline]`,
    `mode: ${decision.mode}`,
    `tools: ${decision.useTools}`,
    `verification: ${decision.requiresVerification}`,
    `iterative: ${decision.iterative}`,
    `reason: ${decision.reason}`,
  ].join("\n");
}
