import { randomUUID } from "node:crypto";
import { getPermissionLedger } from "../permissions/permission-ledger.js";
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
import { verifyAnswer } from "./verifier.js";
import { assessProgress } from "./budget.js";
import { compactRunContext, pruneToolResults } from "./context-manager.js";
import { TokenBudgetManager } from "../token-budget-manager.js";
import { globalMetricsCollector, type MetricsCollector } from "../metrics-collector.js";
import {
  describeParameters,
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
  /** Optional: explains why `llm` resolved to nothing (missing key, disabled model...). Appended to the error. */
  describeNoModel?: (model?: string) => string | undefined;
  tools: ToolRegistry;
  /** Decides tool calls that need confirmation. Without a gate, such calls are denied. */
  approvals?: ApprovalGate;
  /**
   * Turbo mode: run approval-gated tool calls immediately instead of asking the user.
   * On by default; only an explicit `false` brings the approval gate back.
   */
  turboMode?: boolean;
  /** Base system prompt, or a resolver evaluated at the start of every run. */
  systemPrompt?: string | (() => string);
  /** Extra system-prompt context evaluated at the start of every run (skills catalog, ...). */
  /**
   * Extra context for the system prompt. It receives the user's request so the
   * provider can recall what is relevant to it (semantic memory) instead of
   * injecting the same block every time.
   */
  contextProvider?: (info: {
    runId: string;
    sessionId?: string;
    goal: string;
    /** False when this run has no tools, so the provider can skip tool-only context (skills catalog). */
    toolsEnabled: boolean;
  }) => string | undefined | Promise<string | undefined>;
  /** Maximum model round-trips per run. */
  maxTurns?: number | (() => number);
  /** Maximum tool calls per run across all turns. */
  maxToolCalls?: number | (() => number);
  /** Maximum model turns that actually produce tool calls. */
  maxToolIterations?: number | (() => number);
  /** Maximum wall-clock time for a run in ms. Zero or undefined disables the deadline. */
  maxWallTimeMs?: number | (() => number);
  /** Optional approximate context-window cap in tokens. */
  contextWindowTokens?: number | (() => number);
  /** Maximum completion tokens requested from the model. */
  maxCompletionTokens?: number | (() => number);
  /** Controls whether the configured base system prompt is included. */
  systemPromptEnabled?: boolean | (() => boolean);
  toolTimeoutMs?: number;
  /**
   * System notices to deliver to the model, drained at the start of every turn. Hosts use it to
   * tell the agent that something it started (a background command) has finished, so the agent
   * never has to poll to find out.
   */
  notifications?: (info: { runId: string; sessionId?: string }) => string[] | undefined | Promise<string[] | undefined>;
  maxToolResultChars?: number;
  /** An identical call may be made this many times before it is blocked as a loop. */
  duplicateCallLimit?: number;
  /** Diagnostic hook for non-fatal problems (planner fallback, listener errors). */
  logger?: (message: string, details?: Record<string, unknown>) => void;
  /** Metrics sink for terminal run latency and outcome counters. */
  metrics?: Pick<MetricsCollector, "recordLatency" | "incrementCounter">;
  /**
   * In-run context management. Old tool results are pruned from the prompt and,
   * when the context is still close to the window, the oldest agent steps are
   * summarised. `false` disables both. Requires `contextWindowTokens`.
   */
  compaction?:
    | false
    | {
        /** Fraction of the context window that triggers compaction (default 0.75). */
        triggerRatio?: number;
        /** Newest agent steps kept verbatim when compacting (default 4). */
        keepRecentUnits?: number;
        /** Newest tool results never pruned from the prompt (default 4). */
        keepRecentToolResults?: number;
      };
  /**
   * Called with the summary right before the compacted details leave the context
   * window. Hosts use it to write durable memory so nothing is forgotten.
   */
  onContextCompact?: (info: {
    runId: string;
    sessionId?: string;
    goal: string;
    summary: string;
    droppedMessages: number;
  }) => void | Promise<void>;
  /** Models tried in order when the current model's request fails. */
  fallbackModels?: string[] | (() => string[]);
  /**
   * Dynamic budget: when a run reaches its turn / tool-iteration / tool-call
   * limit while its latest tool calls are still succeeding and not repeating,
   * the limits are raised by a bounded step instead of cutting the run off.
   * Failing or looping runs still stop at the limit. Off by default; hosts
   * enable it. Ignored when the request carries its own `maxToolCalls` cap.
   */
  dynamicBudget?: DynamicBudgetConfig | (() => DynamicBudgetConfig);
  /**
   * Self-check: after a tool-using run drafts its final answer, the model checks
   * that draft against the request and the tool evidence and, when it finds a
   * concrete problem, revises once. Off by default (it costs one extra model
   * call); hosts enable it. Never inspects wording: the model judges.
   */
  selfCheck?: SelfCheckConfig | (() => SelfCheckConfig);
  /** Run independent read-only tool calls of one turn concurrently (default true). */
  parallelToolCalls?: boolean;
  /** Upper bound of concurrently running tool calls per turn (default 6). */
  maxParallelToolCalls?: number;
}

export type DynamicBudgetConfig =
  | false
  | {
      /** Turns and tool iterations added per extension (default 6). */
      extensionTurns?: number;
      /** Extensions allowed per run (default 2): the hard ceiling is base + extensions * step. */
      maxExtensions?: number;
      /** Newest tool calls judged for progress (default 4). */
      window?: number;
      minSuccessRate?: number;
    };

export type SelfCheckConfig =
  | false
  | {
      /** Only runs with at least this many tool calls are checked (default 1). */
      minToolCalls?: number;
      /** Revisions allowed per run (default 1). */
      maxRevisions?: number;
    };

function requestApprovalPolicy(
  request: RunRequest,
  tool: import("./types.js").EngineTool,
  input: Record<string, unknown>,
): import("./types.js").ToolApprovalDecision | undefined {
  return request.approvalPolicy?.decide(tool, input);
}

export class NoModelConfiguredError extends Error {
  constructor(model?: string, detail?: string) {
    super(
      (model
        ? `Model "${model}" is not configured or has no credentials.`
        : "No model is configured. Add a model in the Models page or set OPENAI_API_KEY and OPENAI_MODEL.")
        + (detail ? ` Reason: ${detail}` : ""),
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
function isPlanOnlyResponse(text: string, goal: string, availableToolNames: string[]): boolean {
  const draft = text.trim();
  if (!draft || draft.length > 2400) return false;
  const operational = /\b(show|create|write|read|list|run|check|inspect|test|search|open|make|execute|demonstrate|দেখাও|লিখ|পড়|তালিকা|চালাও|পরীক্ষা|খুঁজে)\b/i.test(goal);
  if (!operational) return false;
  const mentionsTool = availableToolNames.some((name) => draft.split(/[^A-Za-z0-9_]+/).some((part) => part.toLowerCase() === name.toLowerCase()));
  const futurePlan = /\b(i['’]?m|i am|i will|i['’]?ll|first|next|then|going to|plan to|let me|now i)\b/i.test(draft)
    || /\b(প্রথমে|এরপর|এখন|করব|করবো|লিখব|পড়ব|চালাব)\b/.test(draft);
  return mentionsTool || futurePlan;
}

export class AgentEngine {
  /**
   * Messages the user sent while a run was in flight. They are delivered to the
   * model on its next turn so the agent can answer them and adjust course
   * without being stopped (autonomous "steering").
   */
  private readonly steerInboxes = new Map<string, string[]>();

  /** Queue a user message for an active run. Returns false when the run is not active. */
  steer(runId: string, text: string): boolean {
    const inbox = this.steerInboxes.get(runId);
    const clean = text.trim();
    if (!inbox || !clean) return false;
    inbox.push(clean);
    return true;
  }

  private drainSteering(state: RunState, turn: number): number {
    const inbox = this.steerInboxes.get(state.runId);
    if (!inbox?.length) return 0;
    const items = inbox.splice(0);
    state.messages.push({
      role: "user",
      content:
        "[New message from the user, sent while you were working. Reply to it briefly and directly, " +
        "follow any instruction or feedback in it, then continue the task you were doing unless told otherwise.]\n" +
        items.join("\n---\n"),
    });
    state.emit({ type: "user.steer", runId: state.runId, turn, count: items.length });
    return items.length;
  }

  private readonly maxTurns: number | (() => number);
  private readonly maxToolCalls: number | (() => number);
  private readonly maxToolIterations: number | (() => number);
  private readonly maxWallTimeMs: number | (() => number);
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
    this.maxWallTimeMs = options.maxWallTimeMs ?? 0;
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
    const startedAtMs = Date.now();
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
    const configuredWallTimeMs = request.maxWallTimeMs ?? (typeof this.maxWallTimeMs === "function" ? this.maxWallTimeMs() : this.maxWallTimeMs);
    const wallTimeMs = Number.isFinite(configuredWallTimeMs) ? Math.max(0, Math.floor(configuredWallTimeMs)) : 0;
    let wallTimeExceeded = false;
    const wallTimer = wallTimeMs > 0
      ? setTimeout(() => {
          wallTimeExceeded = true;
          this.options.logger?.("run.wall_time_exceeded", { runId, wallTimeMs });
          controller.abort();
        }, wallTimeMs)
      : undefined;
    wallTimer?.unref?.();

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

    this.steerInboxes.set(runId, []);
    let llm = this.resolveLLM(request.model);
    let model = llm?.model ?? request.model ?? "";

    const finish = (
      status: RunStatus,
      finalText: string,
      error?: string,
    ): RunResult => {
      clearTimeout(wallTimer);
      this.steerInboxes.delete(runId);
      const finalStatus = wallTimeExceeded && status === "cancelled" ? "limit_reached" : status;
      const finalError = wallTimeExceeded
        ? `Run wall-time budget of ${wallTimeMs} ms reached.`
        : error;
      const elapsedMs = Date.now() - startedAtMs;
      const metrics = this.options.metrics ?? globalMetricsCollector;
      metrics.recordLatency("agent_run", elapsedMs, { outcome: finalStatus });
      metrics.incrementCounter("agent_runs_total", 1, { outcome: finalStatus });
      if (wallTimeExceeded) metrics.incrementCounter("agent_runs_wall_time_exceeded_total", 1);
      emit({
        type: "run.budget",
        runId,
        elapsedMs,
        wallTimeMs,
        outcome: finalStatus,
      });
      this.settlePlan(state, status);
      const finishedAt = new Date().toISOString();
      emit({
        type: "run.finished",
        runId,
        status: finalStatus,
        turns,
        toolCalls: state.records.length,
        usage,
        ...(finalError ? { error: finalError } : {}),
      });
      return {
        runId,
        sessionId: request.sessionId,
        status: finalStatus,
        model,
        goal,
        finalText,
        ...(finalError ? { error: finalError } : {}),
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

    if (!llm) return finish("failed", "", new NoModelConfiguredError(request.model, this.options.describeNoModel?.(request.model)).message);
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
    // Recall applies to every run, with or without tools: the one global memory
    // must never be skipped just because a turn profile disabled the tools.
    if (this.options.contextProvider) {
      try {
        extraContext = await this.options.contextProvider({
          runId,
          sessionId: request.sessionId,
          goal,
          toolsEnabled: runToolsEnabled,
        });
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
    let planOnlyNudged = false;
    let revisions = 0;
    let limitReason: string | undefined;
    let toolIterations = 0;

    // Limits may grow during the run (dynamic budget), so the loop works on mutable caps.
    let turnCap = maxTurns;
    let iterationCap = maxToolIterations;
    let callCap = maxToolCalls;
    let extensions = 0;
    const dynamic = typeof this.options.dynamicBudget === "function" ? this.options.dynamicBudget() : this.options.dynamicBudget;
    const tryExtend = (budgetHit?: string): boolean => {
      if (!dynamic || request.maxToolCalls !== undefined) return false;
      if (extensions >= Math.max(0, Math.floor(dynamic.maxExtensions ?? 2))) return false;
      const progress = assessProgress(state.records, {
        window: dynamic.window,
        minSuccessRate: dynamic.minSuccessRate,
        ignore: (record) => budgetHit !== undefined && record.status === "blocked" && record.error === budgetHit,
      });
      if (!progress.productive) return false;
      const step = Math.max(1, Math.floor(dynamic.extensionTurns ?? 6));
      extensions += 1;
      turnCap += step;
      iterationCap += step;
      // Calls that were only skipped because the call budget ended still used up budget slots.
      const skipped = budgetHit === undefined ? 0 : state.records.filter((record) => record.status === "blocked" && record.error === budgetHit).length;
      callCap += step * Math.max(1, Math.ceil(maxToolCalls / maxToolIterations)) + skipped;
      this.options.logger?.("budget.extended", { extensions, turnCap, iterationCap, callCap, ...progress });
      return true;
    };

    // In-run context management and model failover state.
    const compactionConfig = this.options.compaction === false ? undefined : (this.options.compaction ?? {});
    const compactionEnabled = Boolean(contextWindowTokens && compactionConfig);
    const triggerRatio = Math.min(0.95, Math.max(0.3, compactionConfig?.triggerRatio ?? 0.75));
    const keepRecentUnits = Math.max(1, Math.floor(compactionConfig?.keepRecentUnits ?? 4));
    const keepRecentToolResults = Math.max(0, Math.floor(compactionConfig?.keepRecentToolResults ?? 4));
    let compactions = 0;
    const triedModels = new Set<string>([llm.model]);

    for (let turn = 1; ; turn += 1) {
      if (turn > turnCap && !tryExtend()) break;
      if (toolIterations >= iterationCap && !tryExtend()) {
        limitReason = `Tool iteration budget of ${iterationCap} reached.`;
        break;
      }
      if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
      turns = turn;
      emit({ type: "turn.started", runId, turn });

      // Keep long tasks inside the window: prune old tool output from the prompt,
      // then summarise the oldest agent steps when that is still not enough.
      if (this.options.notifications) {
        try {
          const notices = (await this.options.notifications({ runId, sessionId: request.sessionId }))?.filter((text) => text.trim());
          if (notices?.length) {
            state.messages.push({ role: "user", content: `[system notice]\n${notices.join("\n")}` });
            emit({ type: "system.notice", runId, turn, count: notices.length });
          }
        } catch (error) {
          this.options.logger?.("notifications.failed", { error: errorMessage(error) });
        }
      }
      this.drainSteering(state, turn);
      // Pruned once per turn; recomputed only when compaction replaces the messages.
      let visibleMessages = compactionEnabled
        ? pruneToolResults(state.messages, { keepRecentToolResults })
        : state.messages;
      if (contextWindowTokens && compactionEnabled && compactions < 3) {
        if (estimateContext(visibleMessages, schemas) > Math.floor(contextWindowTokens * triggerRatio)) {
          const outcome = await compactRunContext({
            messages: state.messages,
            llm,
            signal,
            keepRecentUnits,
          });
          if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
          if (outcome) {
            compactions += 1;
            state.messages = outcome.messages;
            visibleMessages = pruneToolResults(state.messages, { keepRecentToolResults });
            emit({
              type: "context.compacted",
              runId,
              turn,
              droppedMessages: outcome.droppedMessages,
              summaryChars: outcome.summary.length,
            });
            try {
              await this.options.onContextCompact?.({
                runId,
                sessionId: request.sessionId,
                goal,
                summary: outcome.summary,
                droppedMessages: outcome.droppedMessages,
              });
            } catch (error) {
              this.options.logger?.("context_compact_hook.failed", { error: errorMessage(error) });
            }
          }
        }
      }

      let response;
      for (;;) {
        try {
          const promptMessages = contextWindowTokens
            ? fitContextWindow(visibleMessages, contextWindowTokens, schemas)
            : visibleMessages;
          response = await llm.complete(promptMessages, {
            ...(schemas.length ? { tools: schemas, toolChoice: "auto" as const } : {}),
            ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
            ...(maxCompletionTokens ? { maxCompletionTokens } : {}),
            // Stream text to listeners as it is generated; the assembled response
            // below is still what drives tool calls and the final answer.
            ...(request.onEvent
              ? { onTextDelta: (delta: string) => emit({ type: "message.delta", runId, turn, delta }) }
              : {}),
            signal,
          });
          break;
        } catch (error) {
          if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
          const fallback = this.nextFallbackClient(triedModels);
          if (!fallback) return finish("failed", "", errorMessage(error));
          emit({
            type: "model.fallback",
            runId,
            turn,
            from: llm.model,
            to: fallback.model,
            reason: errorMessage(error),
          });
          this.options.logger?.("llm.failover", { from: llm.model, to: fallback.model, error: errorMessage(error) });
          llm = fallback;
          model = fallback.model;
        }
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

      if (calls.length === 0 && !planOnlyNudged && runToolsEnabled && isPlanOnlyResponse(text, goal, tools.names())) {
        planOnlyNudged = true;
        state.messages.push({ role: "assistant", content: text });
        state.messages.push({
          role: "user",
          content: "Your previous response only described a plan. Execute the requested work now using the available tools. Do not narrate future actions; emit the structured tool calls, inspect their results, and continue until the request is actually done.",
        });
        continue;
      }

      if (calls.length === 0) {
        if (!text.trim()) {
          // Providers occasionally return an empty completion. Ask once, in the
          // same run, before reporting a failure.
          if (!nudged) {
            nudged = true;
            state.messages.push({
              role: "user",
              content:
                state.records.length > 0
                  ? "Give your final answer to the user now, based on the tool results above."
                  : "Your previous reply was empty. Answer the user's last message now.",
            });
            continue;
          }
          return finish("failed", "", "The model returned an empty response.");
        }
        const finalText = text.trim();

        // Self-check: judge the draft against the evidence before it becomes the answer.
        const selfCheck = typeof this.options.selfCheck === "function" ? this.options.selfCheck() : this.options.selfCheck;
        if (selfCheck && state.records.length >= Math.max(1, selfCheck.minToolCalls ?? 1) && revisions < Math.max(0, selfCheck.maxRevisions ?? 1)) {
          const verdict = await verifyAnswer({
            llm,
            goal,
            answer: finalText,
            messages: state.messages,
            signal,
            onError: (reason) => this.options.logger?.("self_check.unavailable", { reason }),
          });
          if (signal.aborted) return finish("cancelled", "", "Run cancelled.");
          if (verdict && !verdict.ok) {
            revisions += 1;
            this.options.logger?.("self_check.revise", { issues: verdict.issues });
            // The streamed draft is not the answer: retract it, as for a tool turn.
            emit({ type: "thought", runId, turn, content: finalText });
            state.messages.push({ role: "assistant", content: finalText });
            state.messages.push({
              role: "user",
              content:
                `A verification pass found problems with your draft answer:\n${verdict.issues.map((issue) => `- ${issue}`).join("\n")}\n` +
                "Fix them (use tools again if you need more evidence) and give the corrected final answer. State clearly if something could not be done.",
            });
            continue;
          }
        }

        // A message that arrived while this answer was being written must not be dropped.
        if (this.steerInboxes.get(runId)?.length) {
          state.messages.push({ role: "assistant", content: finalText });
          continue;
        }
        emit({ type: "message.final", runId, content: finalText });
        return finish("completed", finalText);
      }

      state.messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: calls,
      });
      if (text.trim()) emit({ type: "thought", runId, turn, content: text.trim() });

      const budgetHit = await this.executeToolCalls(state, calls, turn, tools, request, callCap);
      if (budgetHit) limitReason = !state.loopDetected && tryExtend(budgetHit) ? undefined : budgetHit;
      if (signal.aborted) return finish("cancelled", "", "Run cancelled.");

      if (state.loopDetected) {
        limitReason = "Repeated identical tool calls were blocked (loop detected).";
        break;
      }
      if (limitReason) break;
    }

    // 3. Budget exhausted: ask for a wrap-up without tools so the user still gets an answer.
    limitReason ??= `Step limit of ${turnCap} turns reached.`;
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

  /** Next configured fallback model that has not been tried in this run. */
  private nextFallbackClient(tried: Set<string>): EngineLLMClient | undefined {
    const configured = this.options.fallbackModels;
    const names = typeof configured === "function" ? configured() : (configured ?? []);
    for (const name of names) {
      let client: EngineLLMClient | undefined;
      try {
        client = this.resolveLLM(name);
      } catch {
        client = undefined;
      }
      if (!client || tried.has(client.model)) continue;
      tried.add(client.model);
      return client;
    }
    return undefined;
  }

  /** A call may run concurrently only when it is read-only, opted in and needs no approval. */
  private canRunInParallel(call: EngineToolCall, tools: ToolRegistry, request: RunRequest): boolean {
    const tool = tools.get(call.function.name);
    if (!tool || tool.risk !== "read" || tool.parallelSafe !== true) return false;
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments || "{}");
    } catch {
      return false;
    }
    if (!args || typeof args !== "object" || Array.isArray(args)) return false;
    const decision = requestApprovalPolicy(request, tool, args as Record<string, unknown>);
    if (decision) return decision.mode === "auto";
    return !ToolRegistry.needsApproval(tool);
  }

  /**
   * Runs the tool calls of one model turn. Consecutive independent read-only
   * calls execute concurrently; everything else keeps the model's order. Every
   * call is answered exactly once and results reach the model in call order.
   * Returns a budget message when the tool-call budget cut the turn short.
   */
  private async executeToolCalls(
    state: RunState,
    calls: EngineToolCall[],
    turn: number,
    tools: ToolRegistry,
    request: RunRequest,
    maxToolCalls: number,
  ): Promise<string | undefined> {
    const parallel = this.options.parallelToolCalls !== false;
    const maxParallel = Math.max(1, Math.floor(this.options.maxParallelToolCalls ?? 6));
    let budgetHit: string | undefined;
    let index = 0;
    while (index < calls.length) {
      if (state.signal.aborted) return budgetHit;
      if (state.records.length >= maxToolCalls) {
        budgetHit = `Tool call budget of ${maxToolCalls} reached.`;
        this.answerSkippedCall(state, calls[index], turn, budgetHit, tools);
        index += 1;
        continue;
      }
      if (parallel && this.canRunInParallel(calls[index], tools, request)) {
        const room = maxToolCalls - state.records.length;
        const group: EngineToolCall[] = [];
        while (
          index < calls.length &&
          group.length < maxParallel &&
          group.length < room &&
          this.canRunInParallel(calls[index], tools, request)
        ) {
          group.push(calls[index]);
          index += 1;
        }
        if (group.length > 1) {
          const startLength = state.messages.length;
          await Promise.all(group.map((call) => this.runToolCall(state, call, turn, tools, request)));
          // Tool results arrive in completion order; hand them to the model in call order.
          const order = new Map(group.map((call, position) => [call.id, position]));
          const added = state.messages.splice(startLength);
          added.sort((a, b) => (order.get(a.tool_call_id ?? "") ?? 0) - (order.get(b.tool_call_id ?? "") ?? 0));
          state.messages.push(...added);
          continue;
        }
        await this.runToolCall(state, group[0], turn, tools, request);
        continue;
      }
      await this.runToolCall(state, calls[index], turn, tools, request);
      index += 1;
    }
    return budgetHit;
  }

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
      fail("failed", `${invalid} Expected arguments for ${tool.name}: ${describeParameters(tool.parameters)}.`);
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

    // What the user has taught applies to every run. No other built-in gate is consulted first.
    const learned = getPermissionLedger().evaluate(tool.name, args);
    if (learned.mode === "block") {
      fail("blocked", learned.reason);
      return;
    }
    const policyDecision = requestApprovalPolicy(request, tool, args);
    if (policyDecision?.mode === "block") {
      fail("blocked", policyDecision.reason);
      return;
    }

    // Turbo mode is always on: approval prompts never interrupt a run.

    // Execute with a per-call timeout that also honours run cancellation.
    const startedMs = Date.now();
    record.status = "running";
    this.snapshot(state, turn, record);
    const toolController = new AbortController();
    let timedOut = false;
    const onRunAbort = () => toolController.abort();
    state.signal.addEventListener("abort", onRunAbort, { once: true });
    const effectiveTimeoutMs = tool.timeoutMs ?? this.toolTimeoutMs;
    const timer = effectiveTimeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          toolController.abort();
        }, effectiveTimeoutMs)
      : undefined;
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
        fail("failed", `Tool timed out after ${effectiveTimeoutMs} ms.`, startedMs);
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
