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
import { createPlan } from "./planner.js";
import { buildSystemPrompt } from "./prompt.js";
import { TokenBudgetManager } from "../token-budget-manager.js";
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
  /** Base system prompt, or a resolver evaluated at the start of every run. */
  systemPrompt?: string | (() => string);
  /** Extra system-prompt context evaluated at the start of every run (skills catalog, ...). */
  contextProvider?: () => string | undefined | Promise<string | undefined>;
  /** Maximum model round-trips per run. */
  maxTurns?: number | (() => number);
  /** Maximum tool calls per run across all turns. */
  maxToolCalls?: number | (() => number);
  /** Maximum model turns that actually produce tool calls. */
  maxToolIterations?: number | (() => number);
  /** Optional approximate context-window cap in tokens. */
  contextWindowTokens?: number | (() => number);
  /** Maximum completion tokens requested from the model. */
  maxCompletionTokens?: number | (() => number);
  /** Controls whether the configured base system prompt is included. */
  systemPromptEnabled?: boolean | (() => boolean);
  toolTimeoutMs?: number;
  maxToolResultChars?: number;
  /** An identical call may be made this many times before it is blocked as a loop. */
  duplicateCallLimit?: number;
  /** Diagnostic hook for non-fatal problems (planner fallback, listener errors). */
  logger?: (message: string, details?: Record<string, unknown>) => void;
}

function requestApprovalPolicy(
  request: RunRequest,
  tool: import("./types.js").EngineTool,
  input: Record<string, unknown>,
): import("./types.js").ToolApprovalDecision | undefined {
  return request.approvalPolicy?.decide(tool, input);
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

const contextEstimator = new TokenBudgetManager();

function estimateContext(messages: EngineMessage[], toolSchemas: unknown): number {
  return contextEstimator.estimateMessagesTokens(messages, toolSchemas);
}

function trimMessageContent(message: EngineMessage, tokenBudget: number): EngineMessage {
  if (typeof message.content !== "string") return message;
  const maxChars = Math.max(32, Math.floor(tokenBudget * 4));
  if (message.content.length <= maxChars) return message;
  const marker = "\n…[context trimmed]…\n";
  const room = Math.max(8, maxChars - marker.length);
  const head = Math.max(4, Math.floor(room * 0.75));
  const tail = Math.max(4, room - head);
  return { ...message, content: `${message.content.slice(0, head)}${marker}${message.content.slice(-tail)}` };
}

/** Keep the newest complete user-turn groups under the configured input budget. */
function fitContextWindow(
  messages: EngineMessage[],
  contextWindowTokens: number,
  toolSchemas: unknown,
): EngineMessage[] {
  if (estimateContext(messages, toolSchemas) <= contextWindowTokens && contextWindowTokens > 1024) return messages;

  const system = messages.find((message) => message.role === "system");
  const conversation = messages.filter((message) => message.role !== "system");
  const groups: EngineMessage[][] = [];
  let current: EngineMessage[] = [];
  for (const message of conversation) {
    if (message.role === "user" && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length) groups.push(current);

  const schemaTokens = contextEstimator.estimateMessagesTokens([], toolSchemas);
  const base = system
    ? [
        estimateContext([system], toolSchemas) <= contextWindowTokens
          ? system
          : trimMessageContent(system, Math.max(16, contextWindowTokens - schemaTokens)),
    ]
    : [];
  if (contextWindowTokens <= 1024 && groups.length > 1) {
    const newestGroup = groups[groups.length - 1];
    const user = newestGroup.find((message) => message.role === "user") ?? newestGroup[0];
    const newest = newestGroup[newestGroup.length - 1];
    const available = Math.max(64, contextWindowTokens - estimateContext(base, toolSchemas));
    const half = Math.max(32, Math.floor(available / 2));
    return newest === user
      ? [...base, trimMessageContent(user, available)]
      : [...base, trimMessageContent(user, half), trimMessageContent(newest, half)];
  }
  const kept: EngineMessage[][] = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const candidate = [...groups[index], ...kept.flat()];
    if (estimateContext([...base, ...candidate], toolSchemas) <= contextWindowTokens) {
      kept.unshift(groups[index]);
      continue;
    }

    // The newest user turn must remain visible even when its tool output is
    // larger than the configured input budget. Truncate textual payloads
    // rather than silently discarding the current task.
    if (!kept.length) {
      const user = groups[index].find((message) => message.role === "user") ?? groups[index][0];
      const newest = groups[index][groups[index].length - 1];
      const baseTokens = estimateContext(base, toolSchemas);
      const available = Math.max(64, contextWindowTokens - baseTokens);
      if (newest === user) return [...base, trimMessageContent(user, available)];

      const half = Math.max(32, Math.floor(available / 2));
      const safe = [trimMessageContent(user, half)];
      if (newest !== user) safe.push(trimMessageContent(newest, half));
      return [...base, ...safe];
    }
    break;
  }

  return [...base, ...kept.flat()];
}

function normalizeToolCalls(raw: unknown): EngineToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: EngineToolCall[] = [];
  for (const item of raw) {
    const call = item as {
      id?: unknown;
      function?: { name?: unknown; arguments?: unknown };
      extra_content?: unknown;
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
      ...(call.extra_content && typeof call.extra_content === "object" && !Array.isArray(call.extra_content)
        ? { extra_content: call.extra_content as Record<string, unknown> }
        : {}),
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
  private readonly maxTurns: number | (() => number);
  private readonly maxToolCalls: number | (() => number);
  private readonly maxToolIterations: number | (() => number);
  private readonly contextWindowTokens?: number | (() => number);
  private readonly maxCompletionTokens?: number | (() => number);
  private readonly systemPromptEnabled: boolean | (() => boolean);
  private readonly toolTimeoutMs: number;
  private readonly maxToolResultChars: number;
  private readonly duplicateCallLimit: number;

  constructor(private readonly options: AgentEngineOptions) {
    this.maxTurns = options.maxTurns ?? 12;
    this.maxToolCalls = options.maxToolCalls ?? 40;
    this.maxToolIterations = options.maxToolIterations ?? 12;
    this.contextWindowTokens = options.contextWindowTokens;
    this.maxCompletionTokens = options.maxCompletionTokens;
    this.systemPromptEnabled = options.systemPromptEnabled ?? true;
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
      toolNames: this.options.tools.names(),
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

    const tools = request.tools ?? this.tools;
    const toolsEnabled = request.allowTools !== false && tools.size > 0;
    const maxTurns = Math.max(1, Math.floor(typeof this.maxTurns === "function" ? this.maxTurns() : this.maxTurns));
    const configuredMaxToolCalls = typeof this.maxToolCalls === "function" ? this.maxToolCalls() : this.maxToolCalls;
    const maxToolCalls = Math.max(1, Math.floor(request.maxToolCalls ?? configuredMaxToolCalls));
    const maxToolIterations = Math.max(1, Math.floor(typeof this.maxToolIterations === "function" ? this.maxToolIterations() : this.maxToolIterations));
    const contextWindowTokens = this.contextWindowTokens === undefined ? undefined : Math.max(128, Math.floor(typeof this.contextWindowTokens === "function" ? this.contextWindowTokens() : this.contextWindowTokens));
    const configuredMaxCompletionTokens = this.maxCompletionTokens === undefined
      ? undefined
      : Math.max(1, Math.floor(typeof this.maxCompletionTokens === "function" ? this.maxCompletionTokens() : this.maxCompletionTokens));
    const maxCompletionTokens = request.maxCompletionTokens === undefined
      ? configuredMaxCompletionTokens
      : Math.max(1, Math.floor(request.maxCompletionTokens));

    // Tool schemas are part of the model's input context. If the schemas alone
    // exceed the configured window, disable tool advertisement/execution for
    // this run rather than violating the user's context limit.
    const configuredSchemas = toolsEnabled ? tools.schemas() : [];
    const toolSchemasFitContext = !contextWindowTokens || estimateContext([], configuredSchemas) <= contextWindowTokens;
    const runToolsEnabled = toolsEnabled && toolSchemasFitContext;
    const schemas = runToolsEnabled ? configuredSchemas : [];
    if (!toolSchemasFitContext && toolsEnabled) {
      this.options.logger?.("context_window.tool_schemas_exceed_budget", {
        contextWindowTokens,
        schemaTokens: estimateContext([], configuredSchemas),
        toolCount: configuredSchemas.length,
      });
    }

    // 1. Planning is explicit per run; no classifier or message router selects an execution path.
    // No wording-based gate decides this: the model's own tool loop handles the rest.
    if (request.plan === false) {
      // Planning explicitly disabled for this run.
    } else if (request.plan) {
      state.plan = request.plan;
    }
    if (state.plan && state.plan.source !== "none")
      emit({ type: "plan.created", runId, plan: structuredClone(state.plan) });

    let extraContext: string | undefined;
    if (runToolsEnabled && this.options.contextProvider) {
      try {
        extraContext = await this.options.contextProvider();
      } catch (error) {
        this.options.logger?.("context_provider.failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const configuredSystemPrompt = typeof this.systemPromptEnabled === "function" ? this.systemPromptEnabled() : this.systemPromptEnabled;
    const promptHistory = request.history;
    const systemMessage = configuredSystemPrompt
      ? {
          role: "system" as const,
          content: buildSystemPrompt({
            base: typeof this.options.systemPrompt === "function" ? this.options.systemPrompt() : this.options.systemPrompt,
            plan: state.plan,
            toolNames: runToolsEnabled ? tools.names() : [],
            extraContext,
          }),
        }
      : undefined;
    state.messages = [
      ...(systemMessage ? [systemMessage] : []),
      ...(configuredSystemPrompt ? promptHistory.filter((message) => message.role === "system") : []),
      ...promptHistory.filter((message) => message.role !== "system"),
    ];

    // 2. Agent loop.
    let nudged = false;
    let limitReason: string | undefined;
    let toolIterations = 0;

    for (let turn = 1; turn <= maxTurns; turn += 1) {
      if (toolIterations >= maxToolIterations) {
        limitReason = `Tool iteration budget of ${maxToolIterations} reached.`;
        break;
      }
      if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
      turns = turn;
      emit({ type: "turn.started", runId, turn });

      let response;
      try {
        const promptMessages = contextWindowTokens
          ? fitContextWindow(state.messages, contextWindowTokens, schemas)
          : state.messages;
        response = await llm.complete(promptMessages, {
          ...(schemas.length ? { tools: schemas, toolChoice: "auto" as const } : {}),
          ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
          ...(maxCompletionTokens ? { maxCompletionTokens } : {}),
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
      const calls = runToolsEnabled ? normalizeToolCalls(message.tool_calls) : [];
      if (calls.length > 0) toolIterations += 1;

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
        if (state.records.length >= maxToolCalls) {
          limitReason = `Tool call budget of ${maxToolCalls} reached.`;
          this.answerSkippedCall(state, call, turn, limitReason, tools);
          continue;
        }
        await this.runToolCall(state, call, turn, tools, request);
        if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
      }

      if (state.loopDetected) {
        limitReason = "Repeated identical tool calls were blocked (loop detected).";
        break;
      }
      if (limitReason) break;
    }

    // 3. Budget exhausted: ask for a wrap-up without tools so the user still gets an answer.
    limitReason ??= `Step limit of ${maxTurns} turns reached.`;
    if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
    let summary = "";
    try {
      state.messages.push({
        role: "user",
        content: `${limitReason} Without calling any tools, summarize what you accomplished, what remains, and any blockers.`,
      });
      const wrapMessages = contextWindowTokens
        ? fitContextWindow(state.messages, contextWindowTokens, undefined)
        : state.messages;
      const wrap = await llm.complete(wrapMessages, {
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
        signal,
      });
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
    tools: ToolRegistry,
  ): void {
    const record: ToolCallRecord = {
      id: call.id,
      name: call.function.name,
      arguments: call.function.arguments,
      risk: tools.get(call.function.name)?.risk ?? "read",
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
    tools: ToolRegistry,
    request: RunRequest,
  ): Promise<void> {
    const tool = tools.get(call.function.name);
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
        `Unknown tool "${call.function.name}". Available tools: ${tools.names().join(", ") || "none"}.`,
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

    const policyDecision = requestApprovalPolicy(request, tool, args);
    if (policyDecision?.mode === "block") {
      fail("blocked", policyDecision.reason);
      return;
    }

    const requiresApproval = policyDecision
      ? policyDecision.mode === "approval"
      : ToolRegistry.needsApproval(tool);
    if (requiresApproval) {
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
