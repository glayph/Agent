import type { LLMResponse } from "@miki/config";
import type { ControlRisk } from "../control/types.js";
import type { ToolRegistry } from "./tool-registry.js";

export type EngineRisk = ControlRisk;

// ---------------------------------------------------------------------------
// Chat / LLM contracts
// ---------------------------------------------------------------------------

export interface EngineToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
  /** Provider-specific metadata required when continuing a tool call. */
  extra_content?: Record<string, unknown>;
}

export interface EngineMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: EngineToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface EngineToolSchema {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMCompletionOptions {
  tools?: EngineToolSchema[];
  toolChoice?: "auto" | "none";
  signal?: AbortSignal;
  /** Ask the provider for a JSON-object response when it supports that. */
  json?: boolean;
  /** Optional provider-neutral controls for short routing/chat completions. */
  temperature?: number;
  maxCompletionTokens?: number;
  /** Optional provider-compatible thinking level, e.g. off/low/medium/high. */
  thinkingLevel?: string;
}

/** Minimal port the engine needs from any LLM backend. */
export interface EngineLLMClient {
  readonly model: string;
  complete(
    messages: EngineMessage[],
    options?: LLMCompletionOptions,
  ): Promise<LLMResponse>;
}

// ---------------------------------------------------------------------------
// Tools and approvals
// ---------------------------------------------------------------------------

export interface ToolExecutionContext {
  runId: string;
  sessionId?: string;
  callId: string;
  signal: AbortSignal;
}

export interface EngineTool {
  name: string;
  description: string;
  risk: EngineRisk;
  /** JSON-schema object describing the arguments. */
  parameters: Record<string, unknown>;
  /**
   * "auto" runs without asking, "required" always asks the approval gate.
   * Default: `read` risk runs automatically, every other risk asks first.
   */
  approval?: "auto" | "required";
  execute(
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown> | unknown;
}

export interface ToolApprovalRequest {
  runId: string;
  sessionId?: string;
  callId: string;
  toolName: string;
  risk: EngineRisk;
  reason: string;
  input: Record<string, unknown>;
}

export interface ApprovalDecision {
  approved: boolean;
  reason?: string;
  decidedBy?: string;
  approvalId?: string;
}

export interface ToolApprovalDecision {
  mode: "auto" | "approval" | "block";
  reason: string;
}

export interface ToolApprovalPolicy {
  decide(tool: EngineTool, input: Record<string, unknown>): ToolApprovalDecision;
}

export interface ApprovalGate {
  request(
    request: ToolApprovalRequest,
    signal?: AbortSignal,
    hooks?: { onPending?: (approvalId: string, expiresAt: string) => void },
  ): Promise<ApprovalDecision>;
}

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export type PlanStepStatus =
  "pending" | "running" | "done" | "failed" | "skipped";

export interface PlanStep {
  id: string;
  title: string;
  /** Optional name of the tool the step is expected to use. */
  tool?: string;
  /** Step ids that must finish before this step may start. */
  dependsOn?: string[];
  status: PlanStepStatus;
}

export interface AgentPlan {
  id: string;
  goal: string;
  /** llm = produced by the model, heuristic = derived from the goal text, none = trivial request. */
  source: "llm" | "heuristic" | "none";
  complexity: "trivial" | "simple" | "multi_step";
  steps: PlanStep[];
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Runs and events
// ---------------------------------------------------------------------------

export type ToolCallStatus =
  | "requested"
  | "awaiting_approval"
  | "running"
  | "succeeded"
  | "failed"
  | "denied"
  | "blocked"
  | "cancelled";

export interface ToolCallRecord {
  id: string;
  name: string;
  /** Raw JSON arguments as sent by the model. */
  arguments: string;
  risk: EngineRisk;
  status: ToolCallStatus;
  turn: number;
  startedAt: string;
  durationMs?: number;
  resultPreview?: string;
  error?: string;
  approvalId?: string;
}

export type RunStatus = "completed" | "failed" | "cancelled" | "limit_reached";

export interface RunUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type EngineEvent =
  | {
      type: "run.started";
      runId: string;
      sessionId?: string;
      model: string;
      goal: string;
      at: string;
    }
  | { type: "plan.created"; runId: string; plan: AgentPlan }
  | { type: "plan.updated"; runId: string; plan: AgentPlan }
  | { type: "turn.started"; runId: string; turn: number }
  | { type: "thought"; runId: string; turn: number; content: string }
  | { type: "tool.call"; runId: string; turn: number; call: ToolCallRecord }
  | { type: "message.final"; runId: string; content: string }
  | {
      type: "run.finished";
      runId: string;
      status: RunStatus;
      turns: number;
      toolCalls: number;
      usage: RunUsage;
      error?: string;
    };

export interface RunRequest {
  runId?: string;
  sessionId?: string;
  /** Conversation so far; the last entry must be the new user message. */
  history: EngineMessage[];
  /** Overrides the goal derived from the last user message. */
  goal?: string;
  /** Model name forwarded to the LLM resolver. */
  model?: string;
  /** `false` disables planning, an existing plan is reused as-is. */
  plan?: AgentPlan | false;
  /** `false` runs a plain chat completion without tools. */
  allowTools?: boolean;
  /** Optional provider-compatible thinking level for this run. */
  thinkingLevel?: string;
  /** Optional per-run tool registry used by the layered orchestrator. */
  tools?: ToolRegistry;
  signal?: AbortSignal;
  /** Optional per-run approval policy (used by bounded autonomous execution). */
  approvalPolicy?: ToolApprovalPolicy;
  onEvent?: (event: EngineEvent) => void;
}

export interface RunResult {
  runId: string;
  sessionId?: string;
  status: RunStatus;
  model: string;
  goal: string;
  finalText: string;
  error?: string;
  turns: number;
  toolCalls: ToolCallRecord[];
  plan?: AgentPlan;
  usage: RunUsage;
  startedAt: string;
  finishedAt: string;
}
