import type { RunResult } from "../engine/types.js";

type ReplanFailureKind = "failed" | "verification_failed";

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
  // Model-authored prose is evidence, never a control signal. A completed run that
  // failed acceptance is re-planned as an unverified result; structured owner or
  // provider failures are handled by the supervisor before this class is reached.
  return result.status === "completed" ? "verification_failed" : "failed";
}

export class AutonomyReplanner {
  build(input: ReplanInput): ReplanContext {
    const kind = failureKind(input.result);
    const evidence = truncate(input.result.error || input.result.finalText || "No failure evidence was returned.");
    const instruction = kind === "verification_failed"
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
