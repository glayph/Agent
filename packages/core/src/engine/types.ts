import type { LLMResponse } from "@miki/config";
import type { ControlRisk } from "../control/types.js";
import type { ToolRegistry } from "./tool-registry.js";

export type EngineRisk = ControlRisk;

// ---------------------------------------------------------------------------
// Chat / LLM contracts
// ---------------------------------------------------------------------------

export type ToolMonitorCategory =
  | "tool" | "browser" | "computer" | "terminal" | "file" | "memory"
  | "skill" | "plugin" | "mcp" | "search" | "goal" | "workflow" | "system";

/** Trusted, local presentation metadata for the live execution graph. */
export interface ToolMonitorPresentation {
  category: ToolMonitorCategory;
  iconKey: string;
  displayName?: string;
  pluginId?: string;
  providerId?: string;
}

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
  /** Provider-specific message metadata required when continuing a provider turn. */
  extra_content?: Record<string, unknown>;
  tool_call_id?: string;
  name?: string;
  /** Images attached to this message (URLs or data URLs); the provider adapter turns them into image parts. */
  image_urls?: string[];
}

/** A typed tool result that carries bounded media separately from ordinary tool text. */
export interface EngineToolResult {
  kind: "engine_tool_result";
  content: string;
  /** Image URLs/data URLs to attach to a follow-up user evidence message. */
  imageUrls?: string[];
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
  /** Optional provider request timeout. Omitted by the agent engine so calls can finish naturally. */
  timeoutMs?: number;
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
  readonly providerId?: string;
  /** Stable identity for same-model provider/credential routes within a run. */
  readonly routeKey?: string;
  /** True for an explicitly selected alternate provider credential profile. */
  readonly credentialProfile?: string;
  /** True only when the configured provider integration advertises image input; undefined means unverified. */
  readonly supportsVision?: boolean;
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
  /** Report a meaningful heartbeat while a long operation is actively progressing or waiting. */
  heartbeat?: (detail?: string) => void;
  /** Renew this call's tool execution lease; returns false after cancellation. */
  extendLease?: (durationMs?: number) => boolean;
}

export interface EngineTool {
  name: string;
  /** Safe, local icon/category metadata used by Monitoring; never executable markup or a URL. */
  monitor?: ToolMonitorPresentation;
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
  /** Resolve a timeout from validated per-call input (e.g. file_run.timeoutSeconds). */
  timeoutMsForInput?: (input: Record<string, unknown>) => number;
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
  /** Stable current-plan step that owns this tool action, when known. */
  planStepId?: string;
  /** The current plan sub-goal this individual tool action is intended to advance. */
  actionGoal?: string;
  /** Independent semantic check of whether this action achieved its intended result. */
  actionVerification?: { status: "verified" | "needs_more_evidence" | "failed"; reason: string; evidence: string[] };
  /** Two independent intent checks completed before this action was allowed to execute. */
  preActionVerification?: { status: "passed" | "blocked" | "unavailable"; checks: Array<{ pass: 1 | 2; status: "proceed" | "block" | "unavailable"; reason: string }> };
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
  /** What the tool's structured result said about its own effect (see tool-effect.ts); undefined when it said nothing. */
  effectConfirmed?: boolean;
  /**
   * Longer, already-redacted result text (up to 1,500 characters) kept only so the gateway can store
   * a compact tool-activity record for later turns. It is never sent to the UI; `resultPreview` stays 300.
   */
  traceResult?: string;
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

/** A safe, turn-boundary snapshot for durable continuation after a process restart. */
export interface EngineRunCheckpoint {
  schemaVersion: 1;
  messages: EngineMessage[];
  toolCalls: ToolCallRecord[];
  plan?: AgentPlan;
  usage: RunUsage;
  turns: number;
  toolIterations: number;
  turnCap?: number;
  iterationCap?: number;
  callCap?: number;
  extensions: number;
  blockedStreak: number;
  loopDetected: boolean;
  /** Internal loop guards persisted so a restart does not repeat nudges or verification attempts. */
  nudged?: boolean;
  /** Legacy checkpoint marker from the removed extra completion-classifier pass. */
  planOnlyNudged?: boolean;
  revisions?: number;
  preActionNoticeAttempted?: boolean;
  limitReason?: string;
}

export type EngineEvent =
  | {
      type: "run.started";
      runId: string;
      sessionId?: string;
      userMessageId?: string;
      providerId?: string;
      model: string;
      goal: string;
      at: string;
    }
  | { type: "plan.created"; runId: string; plan: AgentPlan; sessionId?: string; userMessageId?: string; goal?: string; model?: string; providerId?: string }
  | { type: "plan.updated"; runId: string; plan: AgentPlan; sessionId?: string; userMessageId?: string; goal?: string; model?: string; providerId?: string }
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
  | { type: "tool.heartbeat"; runId: string; turn: number; callId: string; tool: string; at: string; detail?: string }
  | { type: "message.final"; runId: string; content: string }
  | { type: "run.phase"; runId: string; turn: number; phase: "verification" | "revision"; status: "started" | "completed" | "unavailable"; detail?: string }
  | { type: "user.steer"; runId: string; turn: number; count: number; messageIds?: string[]; items?: Array<{ messageId?: string; receivedAt: string; text: string; imageCount: number }> }
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
  | { type: "model.retrying"; runId: string; turn: number; retry: number; delayMs: number; reason: string; failureKind?: ModelFailureKind }
  | { type: "model.resumed"; runId: string; turn: number; retries: number }
  | { type: "model.retry_exhausted"; runId: string; turn: number; retries: number; reason: string }
  | { type: "model.steer_interrupt"; runId: string; turn: number }
  | {
      type: "run.finished";
      runId: string;
      sessionId?: string;
      userMessageId?: string;
      goal?: string;
      model?: string;
      providerId?: string;
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
  /** Persisted identity of the interactive user message that owns this run. */
  userMessageId?: string;
  /** Model name forwarded to the LLM resolver. */
  model?: string;
  /** Optional stable stored-model row ID, used when model names are duplicated. */
  modelIndex?: number;
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
   * Retry transient model failures in place. When `maxRetries` is omitted, retries continue
   * until success or cancellation. An explicit finite `maxRetries` remains available for
   * callers that deliberately want a bounded attempt. Backoff is capped to avoid retry storms.
   */
  retryTransient?: boolean | {
    baseDelayMs?: number;
    maxDelayMs?: number;
    maxRetries?: number;
    /** Fixed cadence used after the bounded exponential retry burst. */
    continueRetryingEveryMs?: number;
    /** Disable jitter when a caller requires exact retry intervals. Defaults to enabled. */
    jitter?: boolean;
    /** Also wait and retry on 401/403 and billing/quota blocks instead of failing the run. */
    retryPermanentFailures?: boolean;
  };
  /**
   * Never switch to a fallback model during this run. A transient failure is then handled by
   * `retryTransient` (wait for the same model and resume) or fails the run.
   */
  disableModelFallback?: boolean;
  /** Optional per-run tool-call budget override. */
  maxToolCalls?: number;
  /** Override the runtime's independent per-action verification setting. */
  verifyActions?: boolean;
  /** Optional per-completion output-token cap. */
  maxCompletionTokens?: number;
  /** Optional cumulative per-run token budget (prompt + completion tokens). */
  maxTotalTokens?: number;
  /** Optional per-run wall-clock budget override in ms. Zero disables the deadline. */
  maxWallTimeMs?: number;
  /** Restore a previously saved turn-boundary checkpoint. System messages are rebuilt on resume. */
  resume?: EngineRunCheckpoint;
  /** Persist a safe checkpoint after prompt setup and every completed tool turn. */
  onCheckpoint?: (checkpoint: EngineRunCheckpoint) => void | Promise<void>;
  signal?: AbortSignal;
  /** Optional per-run approval policy (used by bounded autonomous execution). */
  approvalPolicy?: ToolApprovalPolicy;
  onEvent?: (event: EngineEvent) => void;
}

/**
 * Why a run ended because of the model/provider, decided from the original error object (status, code,
 * error class) at the place it was caught, so consumers never have to guess it back from message text.
 * `auth`: credentials rejected. `entitlement`: billing/quota block. `transient`: outage worth retrying.
 * `no_model`: no usable model or credentials are configured.
 */
export type ModelFailureKind = "auth" | "authorization" | "entitlement" | "transient" | "no_model" | "rate_limit" | "network" | "model_not_found" | "invalid_request" | "provider_unavailable";

export interface RunResult {
  runId: string;
  sessionId?: string;
  userMessageId?: string;
  providerId?: string;
  status: RunStatus;
  model: string;
  goal: string;
  finalText: string;
  error?: string;
  /** Set when the run ended because of a model/provider failure; absent for every other outcome. */
  failureKind?: ModelFailureKind;
  turns: number;
  toolCalls: ToolCallRecord[];
  plan?: AgentPlan;
  usage: RunUsage;
  startedAt: string;
  finishedAt: string;
}

