import {
  AgentRunRecorder,
  type AgentRun,
  type VerificationEvidence,
} from "./agent-run.js";

export interface WorkflowContext {
  runId: string;
  sessionId?: string;
  signal: AbortSignal;
  metadata?: Record<string, unknown>;
}

export interface PlannedStep {
  id: string;
  title: string;
  phase?: "planner" | "executor" | "verifier";
}

export interface ExecutionResult {
  ok: boolean;
  summary: string;
  output?: Record<string, unknown>;
}

export interface WorkflowPlanner {
  plan(objective: string, signal: AbortSignal): Promise<PlannedStep[]>;
}

export interface WorkflowExecutor {
  execute(
    step: PlannedStep,
    context: WorkflowContext,
  ): Promise<ExecutionResult>;
}

export interface WorkflowVerifier {
  verify(
    step: PlannedStep,
    result: ExecutionResult,
    context: WorkflowContext,
  ): Promise<VerificationEvidence>;
}

export interface WorkflowRunInput {
  objective: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  planner: WorkflowPlanner;
  executor: WorkflowExecutor;
  verifier: WorkflowVerifier;
  signal?: AbortSignal;
}

export class WorkflowEngine {
  constructor(private readonly recorder = new AgentRunRecorder()) {}

  async run(input: WorkflowRunInput): Promise<AgentRun> {
    const signal = input.signal ?? new AbortController().signal;
    const planned = await input.planner.plan(input.objective, signal);
    if (planned.length === 0)
      throw new Error("Planner returned no executable steps");
    const run = this.recorder.create(
      input.objective,
      planned.map((step) => step.title),
    );

    for (let index = 0; index < planned.length; index += 1) {
      const step = planned[index];
      const recorded = run.steps[index];
      if (!recorded) throw new Error(`Missing recorded step ${step.id}`);
      if (signal.aborted) throw new Error("Workflow aborted");
      this.recorder.startStep(run.id, recorded.id);
      this.recorder.recordPlannerStep(
        run.id,
        recorded.id,
        `Planned: ${step.title}`,
        {
          plannedStepId: step.id,
        },
      );
      try {
        const result = await input.executor.execute(step, {
          runId: run.id,
          sessionId: input.sessionId,
          signal,
          metadata: input.metadata,
        });
        this.recorder.recordExecutorStep(run.id, recorded.id, result.summary, {
          ok: result.ok,
          output: result.output,
        });
        const evidence = await input.verifier.verify(step, result, {
          runId: run.id,
          sessionId: input.sessionId,
          signal,
          metadata: input.metadata,
        });
        this.recorder.completeStep(run.id, recorded.id, {
          ...evidence,
          phase: "verifier",
          source: evidence.source ?? "verifier",
        });
        if (!evidence.ok) break;
      } catch (error: unknown) {
        this.recorder.failStep(run.id, recorded.id, error);
        break;
      }
    }
    return this.recorder.get(run.id) ?? run;
  }
}
