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
  /** Images attached to this message (URLs or data URLs); the provider adapter turns them into image parts. */
  image_urls?: string[];
}

/** A user message handed to a run that is still working. */
export interface SteerInput {
  text: string;
  /** Images sent with the message. */
  imageUrls?: string[];
  /** Id of the stored chat message, so the caller learns when the run actually read it. */
  messageId?: string;
}

/** A steered message waiting in a run's inbox. */
export interface SteerItem {
  text: string;
  imageUrls: string[];
  messageId?: string;
  /** Wall-clock time at which the message was received. */
  receivedAt: number;
  /** What the user was already told about this message while the run was busy, so the run does not repeat it. */
  acknowledgedWith?: string;
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
  /**
   * When set, the client streams the completion and calls this for every text
   * fragment as it arrives. The returned LLMResponse is still the complete,
   * assembled response, so callers keep one code path.
   */
  onTextDelta?: (delta: string) => void;
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
  /**
   * Opt-in: the tool has no ordering dependency on other calls of the same
   * turn, so independent calls to it may run concurrently. Only meaningful for
   * read-only tools; everything else always runs in the order the model gave.
   */
  parallelSafe?: boolean;
  /** Polling-style tool: repeating the same call is expected and must not count as a loop or use up the call budget. */
  repeatSafe?: boolean;
  /**
   * Per-tool timeout override in ms. `0` disables the engine's per-call timeout. Tools that
   * manage their own long-running work (terminal processes) use this so a slow command is
   * waited on in bounded slices instead of being killed by the default tool timeout.
   */
  timeoutMs?: number;
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
  /** Set on a blocked call that stopped at an approval gate (a learned "ask" rule or a hard policy). */
  gate?: "learned_rule" | "policy";
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
  | { type: "system.notice"; runId: string; turn: number; count: number }
  /**
   * Text the model wrote in a turn that did not end the run. `interim: true` means the text was
   * addressed to the user (written alongside tool calls, or an answer the run moved past because
   * the user sent a new message) and must stay visible; otherwise it was a discarded draft.
   */
  | { type: "thought"; runId: string; turn: number; content: string; interim?: boolean }
  | { type: "message.delta"; runId: string; turn: number; delta: string }
  | { type: "tool.call"; runId: string; turn: number; call: ToolCallRecord }
  | { type: "message.final"; runId: string; content: string }
  | { type: "user.steer"; runId: string; turn: number; count: number; messageIds?: string[] }
  | {
      type: "context.compacted";
      runId: string;
      turn: number;
      droppedMessages: number;
      summaryChars: number;
    }
  | {
      type: "run.budget";
      runId: string;
      elapsedMs: number;
      wallTimeMs: number;
      outcome: RunStatus;
    }
  | { type: "model.fallback"; runId: string; turn: number; from: string; to: string; reason: string }
  | { type: "model.retrying"; runId: string; turn: number; retry: number; delayMs: number; reason: string }
  | { type: "model.resumed"; runId: string; turn: number; retries: number }
  | { type: "model.steer_interrupt"; runId: string; turn: number }
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
  /** Generate a dynamic user-facing task-understanding update before the first tool call when that turn has no text. */
  preActionUpdates?: boolean;
  /** Optional provider-compatible thinking level for this run. */
  thinkingLevel?: string;
  /** Optional per-run tool registry, useful for scoped foreground/background execution. */
  tools?: ToolRegistry;
  /**
   * Keep retrying a transient model failure (network, timeout, 429, 5xx) in place, with
   * exponential backoff (default 2s minimum, 12s maximum; `baseDelayMs`/`maxDelayMs` override), until the call succeeds or `signal` aborts.
   * The run continues from the exact step that failed instead of starting over.
   */
  retryTransient?: boolean | { baseDelayMs?: number; maxDelayMs?: number };
  /**
   * Never switch to a fallback model during this run. A transient failure is then handled by
   * `retryTransient` (wait for the same model and resume) or fails the run.
   */
  disableModelFallback?: boolean;
  /** Optional per-run tool-call budget override. */
  maxToolCalls?: number;
  /** Optional per-completion output-token cap. */
  maxCompletionTokens?: number;
  /** Optional cumulative per-run token budget (prompt + completion tokens). */
  maxTotalTokens?: number;
  /** Optional per-run wall-clock budget override in ms. Zero disables the deadline. */
  maxWallTimeMs?: number;
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
