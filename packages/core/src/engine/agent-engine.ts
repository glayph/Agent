import { randomUUID } from "node:crypto";
import type {
  AgentPlan,
  ApprovalGate,
  EngineEvent,
  EngineLLMClient,
  EngineMessage,
  EngineToolCall,
  RunRequest,
  RunResult,
  RunStatus,
  RunUsage,
  ToolCallRecord,
} from "./types.js";
import { ToolRegistry } from "./tool-registry.js";
import { analyzeGoal, createPlan } from "./planner.js";
import { buildSystemPrompt } from "./prompt.js";
import {
  errorMessage,
  raceAbort,
  redactSecrets,
  stableStringify,
  truncate,
  validateArguments,
} from "./util.js";

export type LLMResolver = (model?: string) => EngineLLMClient | undefined;

export interface AgentEngineOptions {
  /** A fixed client, or a resolver that picks one per run (requested model, vault keys...). */
  llm: EngineLLMClient | LLMResolver;
  tools: ToolRegistry;
  /** Decides tool calls that need confirmation. Without a gate, such calls are denied. */
  approvals?: ApprovalGate;
  systemPrompt?: string;
  /** Maximum model round-trips per run. */
  maxTurns?: number;
  /** Maximum tool calls per run across all turns. */
  maxToolCalls?: number;
  toolTimeoutMs?: number;
  maxToolResultChars?: number;
  /** An identical call may be made this many times before it is blocked as a loop. */
  duplicateCallLimit?: number;
  /** Diagnostic hook for non-fatal problems (planner fallback, listener errors). */
  logger?: (message: string, details?: Record<string, unknown>) => void;
}

export class NoModelConfiguredError extends Error {
  constructor(model?: string) {
    super(
      model
        ? `Model "${model}" is not configured or has no credentials.`
        : "No model is configured. Add a model in the Models page or set OPENAI_API_KEY and OPENAI_MODEL.",
    );
    this.name = "NoModelConfiguredError";
  }
}

interface RunState {
  runId: string;
  sessionId?: string;
  signal: AbortSignal;
  emit: (event: EngineEvent) => void;
  messages: EngineMessage[];
  records: ToolCallRecord[];
  plan?: AgentPlan;
  callCounts: Map<string, number>;
  blockedStreak: number;
  loopDetected: boolean;
}

const EMPTY_USAGE = (): RunUsage => ({
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
});

function normalizeToolCalls(raw: unknown): EngineToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: EngineToolCall[] = [];
  for (const item of raw) {
    const call = item as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
    };
    const name = typeof call?.function?.name === "string" ? call.function.name : "";
    if (!name) continue;
    const args = call.function?.arguments;
    calls.push({
      id:
        typeof call.id === "string" && call.id
          ? call.id
          : `call_${randomUUID().slice(0, 12)}`,
      type: "function",
      function: {
        name,
        arguments:
          typeof args === "string"
            ? args
            : args && typeof args === "object"
              ? JSON.stringify(args)
              : "{}",
      },
    });
  }
  return calls;
}

function lastUserText(history: EngineMessage[]): string {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (message.role === "user" && typeof message.content === "string")
      return message.content;
  }
  return "";
}

/**
 * Orchestrates one agent run: plan -> (model turn -> tool calls -> results)* -> answer.
 * It owns the tool-call lifecycle (requested, approval, running, result), loop
 * protection, budgets, cancellation and event emission. It is transport-agnostic;
 * the gateway maps its events onto WebSocket/HTTP responses.
 */
export class AgentEngine {
  private readonly maxTurns: number;
  private readonly maxToolCalls: number;
  private readonly toolTimeoutMs: number;
  private readonly maxToolResultChars: number;
  private readonly duplicateCallLimit: number;

  constructor(private readonly options: AgentEngineOptions) {
    this.maxTurns = options.maxTurns ?? 12;
    this.maxToolCalls = options.maxToolCalls ?? 40;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 60_000;
    this.maxToolResultChars = options.maxToolResultChars ?? 12_000;
    this.duplicateCallLimit = options.duplicateCallLimit ?? 2;
  }

  get tools(): ToolRegistry {
    return this.options.tools;
  }

  /** Resolve the model client for a run; undefined when nothing usable is configured. */
  resolveLLM(model?: string): EngineLLMClient | undefined {
    const source = this.options.llm;
    return typeof source === "function" ? source(model) : source;
  }

  /** Build a plan for a goal without running anything. */
  async plan(goal: string, options: { model?: string; signal?: AbortSignal } = {}): Promise<AgentPlan> {
    return createPlan({
      goal,
      llm: this.resolveLLM(options.model),
      toolNames: this.tools.names(),
      signal: options.signal,
      onFallback: (reason) =>
        this.options.logger?.("planner.fallback", { reason }),
    });
  }

  async run(request: RunRequest): Promise<RunResult> {
    const runId = request.runId ?? `run_${randomUUID()}`;
    const startedAt = new Date().toISOString();
    const goal = (request.goal ?? lastUserText(request.history)).trim();
    const usage = EMPTY_USAGE();
    let turns = 0;

    const controller = new AbortController();
    if (request.signal) {
      if (request.signal.aborted) controller.abort();
      else
        request.signal.addEventListener("abort", () => controller.abort(), {
          once: true,
        });
    }
    const signal = controller.signal;

    const emit = (event: EngineEvent) => {
      try {
        request.onEvent?.(event);
      } catch (error) {
        this.options.logger?.("listener.error", { error: errorMessage(error) });
      }
    };

    const state: RunState = {
      runId,
      sessionId: request.sessionId,
      signal,
      emit,
      messages: [],
      records: [],
      callCounts: new Map(),
      blockedStreak: 0,
      loopDetected: false,
    };

    const llm = this.resolveLLM(request.model);
    const model = llm?.model ?? request.model ?? "";

    const finish = (
      status: RunStatus,
      finalText: string,
      error?: string,
    ): RunResult => {
      this.settlePlan(state, status);
      const finishedAt = new Date().toISOString();
      emit({
        type: "run.finished",
        runId,
        status,
        turns,
        toolCalls: state.records.length,
        usage,
        ...(error ? { error } : {}),
      });
      return {
        runId,
        sessionId: request.sessionId,
        status,
        model,
        goal,
        finalText,
        ...(error ? { error } : {}),
        turns,
        toolCalls: state.records,
        ...(state.plan ? { plan: state.plan } : {}),
        usage,
        startedAt,
        finishedAt,
      };
    };

    emit({
      type: "run.started",
      runId,
      sessionId: request.sessionId,
      model,
      goal,
      at: startedAt,
    });

    if (!llm) return finish("failed", "", new NoModelConfiguredError(request.model).message);
    if (!goal) return finish("failed", "", "The request has no user message.");

    const toolsEnabled = request.allowTools !== false && this.tools.size > 0;

    // 1. Plan (only for multi-step work; planner failures never fail the run).
    if (request.plan === false) {
      // Planning explicitly disabled for this run.
    } else if (request.plan) {
      state.plan = request.plan;
    } else if (toolsEnabled && analyzeGoal(goal).complexity === "multi_step") {
      try {
        state.plan = await createPlan({
          goal,
          llm,
          toolNames: this.tools.names(),
          signal,
          onFallback: (reason) =>
            this.options.logger?.("planner.fallback", { reason }),
        });
      } catch {
        if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
      }
    }
    if (state.plan && state.plan.source !== "none")
      emit({ type: "plan.created", runId, plan: structuredClone(state.plan) });

    state.messages = [
      {
        role: "system",
        content: buildSystemPrompt({
          base: this.options.systemPrompt,
          plan: state.plan,
          toolNames: toolsEnabled ? this.tools.names() : [],
        }),
      },
      ...request.history.filter((message) => message.role !== "system"),
    ];

    // 2. Agent loop.
    const schemas = toolsEnabled ? this.tools.schemas() : [];
    let nudged = false;
    let limitReason: string | undefined;

    for (let turn = 1; turn <= this.maxTurns; turn += 1) {
      if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
      turns = turn;
      emit({ type: "turn.started", runId, turn });

      let response;
      try {
        response = await llm.complete(state.messages, {
          ...(schemas.length ? { tools: schemas, toolChoice: "auto" as const } : {}),
          signal,
        });
      } catch (error) {
        if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
        return finish("failed", "", errorMessage(error));
      }
      usage.promptTokens += response.usage?.prompt_tokens ?? 0;
      usage.completionTokens += response.usage?.completion_tokens ?? 0;
      usage.totalTokens +=
        response.usage?.total_tokens ??
        (response.usage?.prompt_tokens ?? 0) +
          (response.usage?.completion_tokens ?? 0);

      const message = response.choices?.[0]?.message;
      if (!message) return finish("failed", "", "The model returned no choices.");
      const text = typeof message.content === "string" ? message.content : "";
      const calls = toolsEnabled ? normalizeToolCalls(message.tool_calls) : [];

      if (calls.length === 0) {
        if (!text.trim()) {
          if (state.records.length > 0 && !nudged) {
            nudged = true;
            state.messages.push({
              role: "user",
              content:
                "Give your final answer to the user now, based on the tool results above.",
            });
            continue;
          }
          return finish("failed", "", "The model returned an empty response.");
        }
        const finalText = text.trim();
        emit({ type: "message.final", runId, content: finalText });
        return finish("completed", finalText);
      }

      state.messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: calls,
      });
      if (text.trim()) emit({ type: "thought", runId, turn, content: text.trim() });

      for (const call of calls) {
        if (state.records.length >= this.maxToolCalls) {
          limitReason = `Tool call budget of ${this.maxToolCalls} reached.`;
          this.answerSkippedCall(state, call, turn, limitReason);
          continue;
        }
        await this.runToolCall(state, call, turn);
        if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
      }

      if (state.loopDetected) {
        limitReason = "Repeated identical tool calls were blocked (loop detected).";
        break;
      }
      if (limitReason) break;
    }

    // 3. Budget exhausted: ask for a wrap-up without tools so the user still gets an answer.
    limitReason ??= `Step limit of ${this.maxTurns} turns reached.`;
    if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
    let summary = "";
    try {
      state.messages.push({
        role: "user",
        content: `${limitReason} Without calling any tools, summarize what you accomplished, what remains, and any blockers.`,
      });
      const wrap = await llm.complete(state.messages, { signal });
      const wrapText = wrap.choices?.[0]?.message?.content;
      summary = typeof wrapText === "string" ? wrapText.trim() : "";
    } catch (error) {
      if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
      this.options.logger?.("wrapup.failed", { error: errorMessage(error) });
    }
    // Rule 1: never substitute canned conversational text. When the model cannot
    // produce a wrap-up, the run ends with an empty answer and an error state
    // that the caller reports as a system error, not as an agent reply.
    const finalText = summary;
    if (finalText) emit({ type: "message.final", runId, content: finalText });
    return finish("limit_reached", finalText, limitReason);
  }

  // -------------------------------------------------------------------------
  // Tool-call lifecycle
  // -------------------------------------------------------------------------

  private snapshot(state: RunState, turn: number, record: ToolCallRecord): void {
    state.emit({ type: "tool.call", runId: state.runId, turn, call: { ...record } });
  }

  private pushToolResult(state: RunState, call: EngineToolCall, content: string): void {
    state.messages.push({
      role: "tool",
      tool_call_id: call.id,
      name: call.function.name,
      content,
    });
  }

  /** Every tool_call id must get an answer, even when the call is skipped. */
  private answerSkippedCall(
    state: RunState,
    call: EngineToolCall,
    turn: number,
    reason: string,
  ): void {
    const record: ToolCallRecord = {
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      risk: this.tools.get(call.function.name)?.risk ?? "read",
      status: "blocked",
      turn,
      startedAt: new Date().toISOString(),
      error: reason,
    };
    state.records.push(record);
    this.snapshot(state, turn, record);
    this.pushToolResult(state, call, JSON.stringify({ ok: false, error: reason }));
  }

  private async runToolCall(
    state: RunState,
    call: EngineToolCall,
    turn: number,
  ): Promise<void> {
    const tool = this.tools.get(call.function.name);
    const record: ToolCallRecord = {
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      risk: tool?.risk ?? "read",
      status: "requested",
      turn,
      startedAt: new Date().toISOString(),
    };
    state.records.push(record);
    this.markPlanRunning(state, record.name);
    this.snapshot(state, turn, record);

    const fail = (
      status: ToolCallRecord["status"],
      message: string,
      startedMs?: number,
    ) => {
      record.status = status;
      record.error = message;
      if (startedMs !== undefined) record.durationMs = Date.now() - startedMs;
      this.snapshot(state, turn, record);
      this.pushToolResult(state, call, JSON.stringify({ ok: false, error: message }));
    };

    if (!tool) {
      fail(
        "failed",
        `Unknown tool "${call.function.name}". Available tools: ${this.tools.names().join(", ") || "none"}.`,
      );
      return;
    }

    let args: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(call.function.arguments || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("arguments must be a JSON object");
      args = parsed as Record<string, unknown>;
    } catch (error) {
      fail("failed", `Invalid JSON arguments: ${errorMessage(error)}.`);
      return;
    }
    const invalid = validateArguments(tool.parameters, args);
    if (invalid) {
      fail("failed", invalid);
      return;
    }

    // Loop protection: identical calls repeat only a few times between state changes.
    const key = `${tool.name}:${stableStringify(args)}`;
    const seen = (state.callCounts.get(key) ?? 0) + 1;
    state.callCounts.set(key, seen);
    if (seen > this.duplicateCallLimit) {
      state.blockedStreak += 1;
      if (state.blockedStreak >= 3) state.loopDetected = true;
      fail(
        "blocked",
        "This exact call was already made several times with the same result. Use the earlier result or change your approach.",
      );
      return;
    }
    state.blockedStreak = 0;

    if (ToolRegistry.needsApproval(tool)) {
      record.status = "awaiting_approval";
      this.snapshot(state, turn, record);
      const gate = this.options.approvals;
      const decision = gate
        ? await gate.request(
            {
              runId: state.runId,
              sessionId: state.sessionId,
              callId: call.id,
              toolName: tool.name,
              risk: tool.risk,
              reason: `The agent wants to run "${tool.name}" (${tool.risk}).`,
              input: args,
            },
            state.signal,
            {
              onPending: (approvalId) => {
                record.approvalId = approvalId;
                this.snapshot(state, turn, record);
              },
            },
          )
        : {
            approved: false,
            reason: "No approval channel is configured for this tool.",
          };
      if (decision.approvalId) record.approvalId = decision.approvalId;
      if (state.signal.aborted) {
        fail("cancelled", "The run was cancelled.");
        return;
      }
      if (!decision.approved) {
        fail("denied", `The user did not approve this call. ${decision.reason ?? ""}`.trim());
        return;
      }
    }

    // Execute with a per-call timeout that also honours run cancellation.
    const startedMs = Date.now();
    record.status = "running";
    this.snapshot(state, turn, record);
    const toolController = new AbortController();
    let timedOut = false;
    const onRunAbort = () => toolController.abort();
    state.signal.addEventListener("abort", onRunAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      toolController.abort();
    }, this.toolTimeoutMs);
    try {
      const output = await raceAbort(
        Promise.resolve(
          tool.execute(args, {
            runId: state.runId,
            sessionId: state.sessionId,
            callId: call.id,
            signal: toolController.signal,
          }),
        ),
        toolController.signal,
      );
      const serialized = redactSecrets(
        truncate(
          typeof output === "string" ? output : (JSON.stringify(output) ?? "null"),
          this.maxToolResultChars,
        ),
      );
      record.status = "succeeded";
      record.durationMs = Date.now() - startedMs;
      record.resultPreview = truncate(serialized, 300);
      this.snapshot(state, turn, record);
      this.pushToolResult(state, call, serialized);
      if (tool.risk !== "read") {
        // State changed: earlier identical read calls may now return different results.
        state.callCounts.clear();
      }
      this.markPlanDone(state, tool.name);
    } catch (error) {
      if (state.signal.aborted) {
        fail("cancelled", "The run was cancelled.", startedMs);
      } else if (timedOut) {
        fail("failed", `Tool timed out after ${this.toolTimeoutMs} ms.`, startedMs);
      } else {
        fail("failed", redactSecrets(errorMessage(error)), startedMs);
      }
    } finally {
      clearTimeout(timer);
      state.signal.removeEventListener("abort", onRunAbort);
    }
  }

  // -------------------------------------------------------------------------
  // Plan progress (best effort, driven by tool usage)
  // -------------------------------------------------------------------------

  private markPlanRunning(state: RunState, toolName: string): void {
    const plan = state.plan;
    if (!plan) return;
    const step =
      plan.steps.find((s) => s.status === "pending" && s.tool === toolName) ??
      plan.steps.find((s) => s.status === "pending");
    if (step && !plan.steps.some((s) => s.status === "running")) {
      step.status = "running";
      state.emit({ type: "plan.updated", runId: state.runId, plan: structuredClone(plan) });
    }
  }

  private markPlanDone(state: RunState, toolName: string): void {
    const plan = state.plan;
    if (!plan) return;
    const step =
      plan.steps.find((s) => s.status === "running" && (!s.tool || s.tool === toolName)) ??
      plan.steps.find((s) => s.status === "running");
    if (step) {
      step.status = "done";
      state.emit({ type: "plan.updated", runId: state.runId, plan: structuredClone(plan) });
    }
  }

  private settlePlan(state: RunState, status: RunStatus): void {
    const plan = state.plan;
    if (!plan || plan.source === "none") return;
    for (const step of plan.steps) {
      if (status === "completed") {
        if (step.status === "pending" || step.status === "running") step.status = "done";
      } else if (step.status === "running") {
        step.status = "failed";
      } else if (step.status === "pending") {
        step.status = "skipped";
      }
    }
    state.emit({ type: "plan.updated", runId: state.runId, plan: structuredClone(plan) });
  }
}
