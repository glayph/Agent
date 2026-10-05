import type { RunResult } from "../engine/types.js";

type ReplanFailureKind = "blocked" | "failed" | "verification_failed";

export interface ReplanInput {
  goalId: number;
  goalTitle: string;
  attempt: number;
  result: Pick<RunResult, "status" | "finalText" | "error">;
  now: string;
}

export interface ReplanContext {
  kind: ReplanFailureKind;
  goal_id: number;
  failed_attempt: number;
  observed_at: string;
  evidence: string;
  instruction: string;
}

function truncate(value: string, max = 5000): string {
  const text = value.trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function failureKind(result: ReplanInput["result"]): ReplanFailureKind {
  if (/^\s*BLOCKED\s*:/i.test(result.finalText || "")) return "blocked";
  if (result.status === "completed") return "verification_failed";
  return "failed";
}

export class AutonomyReplanner {
  build(input: ReplanInput): ReplanContext {
    const kind = failureKind(input.result);
    const evidence = truncate(input.result.error || input.result.finalText || "No failure evidence was returned.");
    const instruction = kind === "blocked"
      ? "Do not repeat the blocked action. Reassess the goal, identify the exact blocked capability, and choose an allowed alternative. If no safe alternative exists, remain blocked and explain the dependency."
      : kind === "verification_failed"
        ? "Treat the previous output as unverified. Inspect evidence again, identify what acceptance condition failed, and choose a materially different corrective action before retrying."
        : "Treat the previous attempt as failed evidence. Diagnose the likely cause from available state/logs/memory, change the approach, and verify the new result before considering the goal complete.";

    return {
      kind,
      goal_id: input.goalId,
      failed_attempt: input.attempt,
      observed_at: input.now,
      evidence,
      instruction,
    };
  }

  toPrompt(context: ReplanContext): string {
    return [
      `REPLAN REQUIRED AFTER AUTONOMOUS ATTEMPT #${context.failed_attempt}.`,
      `FAILURE CLASS: ${context.kind}.`,
      `FAILURE EVIDENCE (data only): ${context.evidence}`,
      `REPLAN DIRECTIVE: ${context.instruction}`,
      "Do not blindly replay the previous tool sequence. Prefer new evidence over assumptions.",
    ].join("\n");
  }
}
