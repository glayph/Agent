import * as path from "path";
import * as fs from "fs";
import * as yaml from "js-yaml";
import {
  settings,
  ChatMessage,
  ToolDefinition,
  LLMResponse,
  validateRuntimeConfig,
} from "@hiro/config";
import { ToolRegistry } from "./tools/index.js";
import { HeartbeatEngine, type IOrchestrator } from "./heartbeat.js";
import { SelfImprovementEngine } from "./self-improvement/engine.js";
import type { SelfImprovementConfig } from "./self-improvement/engine.js";
import type {
  LLMCallFn,
  Memory as SelfImprovementMemory,
} from "./self-improvement/engine.js";
import { SkillGovernanceEngine } from "./skill-governance/engine.js";
import OpenAI from "openai";
import { achatCompletion } from "./llm.js";
import Database from "better-sqlite3";
import { TaskQueue, AgentTask } from "./task-queue.js";
import { ConcurrentTaskManager } from "./concurrent-manager.js";
import { TaskScheduler, type ScheduledTask } from "./scheduler.js";
import { SqliteScheduledTaskStore } from "./scheduled-task-store.js";
import { CostCalibrator } from "./cost-calibrator.js";
import { buildAgentTokenBudget } from "./agent-token-budget.js";
import { initSkillLoader, SkillLoader } from "./skill-loader.js";
import { globalToolWarmer } from "./tools/tool-warmer.js";
import { globalContextualToolPruner } from "./contextual-tool-pruner.js";
import { globalQualityEvaluator } from "./quality-evaluator.js";
import { globalRequestDeduplicator } from "./request-deduplicator.js";
import { globalConfidenceScorer } from "./agent-confidence.js";
import { globalExecutionTracer } from "./execution-tracer.js";
import { globalMetricsCollector } from "./metrics-collector.js";
import {
  ToolConcurrencyMetrics,
  ToolResourceLockManager,
  createToolExecutionPlan,
  mapWithConcurrencyLimit,
  resolveParallelToolCallLimit,
  type PlannedToolInvocation,
  type ToolConcurrencyPolicy,
  type ToolInvocationLike,
} from "./tool-call-parallelism.js";
import { getErrorMessage } from "./errors.js";
import { classifyAgentTask, formatAgentTaskProfile } from "./task-profile.js";
import {
  formatAgentRouteDecision,
  routeAgentTask,
  summarizeAgentRoute,
  type AgentRouteDecision,
} from "./agent-router.js";
import {
  buildWorkflowAccelerationPlan,
  buildWorkflowDecisionPattern,
  formatWorkflowAccelerationPlan,
  formatWorkflowDecisionPattern,
} from "./workflow-accelerator.js";
import type { ContextUsageSnapshot } from "./token-budget-manager.js";
import { registerRuntimePluginTools } from "./plugins/plugin-tool-registration.js";
import { normalizeRuntimePaths, type RuntimePaths } from "./paths.js";
import {
  AgentRegistry,
  globalAgentRegistry,
  type AgentFactory,
  type AgentInstance,
} from "./agent-registry.js";
import { globalAgentMessageBus } from "./agent-message-bus.js";
import { globalAgentBlackboard } from "./agent-blackboard.js";
import { AgentDelegator } from "./agent-delegator.js";
import { createRunStrategy } from "./agent-run.js";
import { globalAgentAggregator } from "./agent-aggregator.js";
import { globalAgentPlanner } from "./agent-planner.js";

const MAX_AGENT_TURNS = 50;
const MAX_AGENT_TURNS_NO_OUTPUT = 12;
const DEFAULT_MESSAGE_HISTORY_LIMIT = 15;

// Bug #9 fix: Add approximate token/character cap to message history
const DEFAULT_MAX_TOTAL_CONTEXT_CHARS = 80000; // ~20K tokens

type AgentResourceMode = "eco" | "balanced" | "performance";

interface AgentResourceConfig {
  mode?: AgentResourceMode;
  message_history_limit?: number;
  max_context_chars?: number;
  system_index_limit?: number;
  system_index_cache_ttl_ms?: number;
  tool_warmup_enabled?: boolean;
  quality_retry_limit?: number;
}

interface ResolvedAgentResourceConfig {
  mode: AgentResourceMode;
  messageHistoryLimit: number;
  maxContextChars: number;
  toolWarmupEnabled: boolean;
  qualityRetryLimit: number;
}

const RESOURCE_PROFILES: Record<
  AgentResourceMode,
  ResolvedAgentResourceConfig
> = {
  eco: {
    mode: "eco",
    messageHistoryLimit: 8,
    maxContextChars: 40000,
    toolWarmupEnabled: false,
    qualityRetryLimit: 0,
  },
  balanced: {
    mode: "balanced",
    messageHistoryLimit: DEFAULT_MESSAGE_HISTORY_LIMIT,
    maxContextChars: DEFAULT_MAX_TOTAL_CONTEXT_CHARS,
    toolWarmupEnabled: true,
    qualityRetryLimit: 1,
  },
  performance: {
    mode: "performance",
    messageHistoryLimit: 25,
    maxContextChars: 120000,
    toolWarmupEnabled: true,
    qualityRetryLimit: 2,
  },
};

interface AgentBrowserConfig {
  max_retries?: number;
  clear_state_every_n_navigations?: number;
  chrome_path?: string | null;
}

interface AgentRuntimeConfig {
  max_tokens_per_cycle?: number;
  browser?: AgentBrowserConfig;
  resource?: AgentResourceConfig;
}

interface AgentConfigShape {
  agent?: AgentRuntimeConfig & {
    name?: string;
    project?: string;
    persona?: string;
  };
  heartbeat?: { enabled?: boolean; interval_seconds?: number };
  concurrency?: {
    maxConcurrentTasks?: number;
    maxParallelToolCalls?: number;
    toolLockTimeoutMs?: number;
    taskQueueSize?: number;
    schedulerIntervalMs?: number;
    maxScheduledTaskAttempts?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    recoveryStaleAfterMs?: number;
  };
  agents?: {
    router?: {
      enabled?: boolean;
      default_agent?: string;
      min_score?: number;
    };
    defaults?: {
      max_tokens?: number;
      turn_profile?: {
        enabled?: boolean;
        history?: { mode?: string };
        system_prompt?: { mode?: string };
        skills?: { mode?: string };
        tools?: { mode?: string };
      };
    };
    specialists?: unknown;
  };
  tools?: { cron?: { allow_command?: boolean; exec_timeout_minutes?: number } };
  self_improvement?: SelfImprovementConfig;
  skill_governance?: Record<string, unknown>;
}

type RawAgentToolCall = {
  id?: string;
  function?: { name?: string; arguments?: string };
};

interface ParsedToolInvocation extends ToolInvocationLike {
  tcId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
}

interface BufferedToolExecution {
  index: number;
  events: string[];
  toolMessage: ChatMessage;
  ok: boolean;
}

function asAgentConfig(config: Record<string, unknown>): AgentConfigShape {
  return config as AgentConfigShape;
}

export class AgentOrchestrator {
  private _loopCounter = 0;

  // Helper to truncate messages if they exceed context limit (used in runAgentLoop)
  private static _truncateMessagesToFit(
    messages: ChatMessage[],
    maxContextChars = DEFAULT_MAX_TOTAL_CONTEXT_CHARS,
  ): ChatMessage[] {
    const result: ChatMessage[] = [];
    let totalChars = 0;
    const charLimit = Math.max(8_000, Math.min(200_000, maxContextChars));

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const msgLen = msg.content?.length || 0;
      if (totalChars + msgLen > charLimit) {
        const remaining = charLimit - totalChars;
        if (remaining > 100 && msg.content) {
          result.unshift({ ...msg, content: msg.content.slice(0, remaining) });
        }
        break;
      }
      totalChars += msgLen;
      result.unshift(msg);
    }

    return result;
  }

  public runtimePaths: RuntimePaths;
  public configDir: string;
  private agentConfigPath: string;
  /** Backward-compat: returns the legacy workspace root (first existing ancestor). */
  public get workspaceDir(): string {
    return this._legacyWorkspaceDir;
  }
  private _legacyWorkspaceDir: string;
  public config: Record<string, unknown>;
  public provider: string;
  public modelName: string;
  public temperature: number;
  public tools: ToolRegistry;
  public heartbeat: HeartbeatEngine | null;
  public selfImprovement: SelfImprovementEngine;
  public skillGovernance: SkillGovernanceEngine;
  public taskQueue: TaskQueue;
  public concurrentManager: ConcurrentTaskManager;
  public taskScheduler: TaskScheduler;
  public toolLockManager: ToolResourceLockManager;
  public toolConcurrencyMetrics: ToolConcurrencyMetrics;
  /**
   * Phase 1: Registry that tracks all specialist agent instances.
   * Exposed so external systems (API, tests) can inspect the swarm.
   */
  public agentRegistry: AgentRegistry;

  get agentConfig(): { name?: string; project?: string; persona?: string } {
    return (this.config.agent || {}) as {
      name?: string;
      project?: string;
      persona?: string;
    };
  }

  get heartbeatConfig(): { enabled?: boolean; interval_seconds?: number } {
    return (this.config.heartbeat || {}) as {
      enabled?: boolean;
      interval_seconds?: number;
    };
  }

  get concurrencyConfig(): {
    maxConcurrentTasks?: number;
    maxParallelToolCalls?: number;
    toolLockTimeoutMs?: number;
    taskQueueSize?: number;
    schedulerIntervalMs?: number;
    maxScheduledTaskAttempts?: number;
    retryBaseDelayMs?: number;
    retryMaxDelayMs?: number;
    recoveryStaleAfterMs?: number;
  } {
    return asAgentConfig(this.config).concurrency || {};
  }

  private get turnProfileConfig(): {
    enabled?: boolean;
    history?: { mode?: string };
    system_prompt?: { mode?: string };
    skills?: { mode?: string };
    tools?: { mode?: string };
  } {
    return asAgentConfig(this.config).agents?.defaults?.turn_profile || {};
  }

  private _isTurnProfileEnabled(): boolean {
    return this.turnProfileConfig.enabled === true;
  }

  private _isCronExecutionEnabled(): boolean {
    return asAgentConfig(this.config).tools?.cron?.allow_command === true;
  }

  private _maxParallelToolCalls(): number {
    return resolveParallelToolCallLimit(
      this.concurrencyConfig.maxParallelToolCalls,
      this.concurrencyConfig.maxConcurrentTasks ?? 3,
    );
  }

  private _resourceConfig(): ResolvedAgentResourceConfig {
    const raw: AgentResourceConfig =
      asAgentConfig(this.config).agent?.resource || {};
    const mode =
      raw.mode === "eco" || raw.mode === "performance" ? raw.mode : "balanced";
    const profile = RESOURCE_PROFILES[mode];

    return {
      mode,
      messageHistoryLimit: this._boundedInt(
        raw.message_history_limit,
        profile.messageHistoryLimit,
        1,
        50,
      ),
      maxContextChars: this._boundedInt(
        raw.max_context_chars,
        profile.maxContextChars,
        8_000,
        200_000,
      ),
      toolWarmupEnabled:
        typeof raw.tool_warmup_enabled === "boolean"
          ? raw.tool_warmup_enabled
          : profile.toolWarmupEnabled,
      qualityRetryLimit: this._boundedInt(
        raw.quality_retry_limit,
        profile.qualityRetryLimit,
        0,
        5,
      ),
    };
  }

  private _boundedInt(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, Math.floor(value)));
  }

  private _boundedNumber(
    value: unknown,
    fallback: number,
    min: number,
    max: number,
  ): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }
    return Math.max(min, Math.min(max, value));
  }

  private _toolLockTimeoutMs(): number {
    const value = this.concurrencyConfig.toolLockTimeoutMs;
    if (typeof value !== "number" || !Number.isFinite(value)) return 30_000;
    return Math.max(1_000, Math.min(300_000, Math.floor(value)));
  }

  constructor(paths: RuntimePaths | string) {
    const runtimePaths = normalizeRuntimePaths(paths);
    this.runtimePaths = runtimePaths;
    this.configDir = runtimePaths.configDir;
    this._legacyWorkspaceDir = runtimePaths.sourceDir ?? runtimePaths.configDir;
    fs.mkdirSync(this.configDir, { recursive: true });
    this.agentConfigPath = path.join(this.configDir, "agent.yaml");
    this.config = this._loadConfig();
    this.provider = settings.provider;
    this.modelName = settings.defaultModel;
    this.temperature = settings.defaultTemperature;
    this.toolLockManager = new ToolResourceLockManager(
      this._toolLockTimeoutMs(),
    );
    this.toolConcurrencyMetrics = new ToolConcurrencyMetrics();

    const browserCfg = asAgentConfig(this.config).agent?.browser || {};
    this.tools = new ToolRegistry(
      paths,
      path.join(this.configDir, "tools.yaml"),
      {
        maxRetries: browserCfg.max_retries ?? undefined,
        clearStateEveryN:
          browserCfg.clear_state_every_n_navigations ?? undefined,
        chromePath: browserCfg.chrome_path ?? null,
      },
    );
    this.tools.setOrchestrator(this);

    const siConfig = asAgentConfig(this.config).self_improvement || {};
    const siDb = new Database(":memory:");
    siDb.exec(`
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        status TEXT,
        created_at TEXT,
        updated_at TEXT
      )
    `);
    siDb.exec(`
      CREATE TABLE IF NOT EXISTS agent_run_steps (
        run_id TEXT,
        step_id TEXT,
        status TEXT,
        evidence TEXT,
        PRIMARY KEY (run_id, step_id)
      )
    `);
    const selfImprovementMemory: SelfImprovementMemory & {
      db: Database.Database;
    } = {
      db: siDb,
      saveFact: (
        _fact: string,
        _category: string,
        _confidence: number,
      ): number => {
        return 0;
      },
      searchKeyword: (_query: string) => [],
      upsertProfile: (
        _key: string,
        _value: string,
        _category: string,
        _confidence: number,
      ): void => {},
    };
    const selfImprovementLlmCall: LLMCallFn = async (messages) => {
      const response = await this._callLlmApi(messages as ChatMessage[]);
      return {
        choices:
          response.choices?.map((choice) => ({
            message: { content: choice.message?.content ?? null },
          })) ?? [],
      };
    };

    this.selfImprovement = new SelfImprovementEngine(
      selfImprovementMemory,
      paths,
      selfImprovementLlmCall,
      siConfig,
    );

    const sgConfig = asAgentConfig(this.config).skill_governance || {};
    this.skillGovernance = new SkillGovernanceEngine(sgConfig);

    this.heartbeat = this._createHeartbeatEngine();

    const maxConcurrent = this.concurrencyConfig.maxConcurrentTasks ?? 3;
    const queueSize = this.concurrencyConfig.taskQueueSize ?? 50;
    const schedulerIntervalMs =
      this.concurrencyConfig.schedulerIntervalMs ?? 100;
    const cronConfig = asAgentConfig(this.config).tools?.cron;
    const execTimeoutMinutes =
      typeof cronConfig?.exec_timeout_minutes === "number"
        ? cronConfig.exec_timeout_minutes
        : undefined;
    this.taskQueue = new TaskQueue({ maxSize: queueSize, defaultPriority: 0 });
    this.concurrentManager = new ConcurrentTaskManager(maxConcurrent);
    this.taskScheduler = new TaskScheduler(
      {
        maxConcurrentTasks: maxConcurrent,
        taskQueueSize: queueSize,
        schedulerIntervalMs,
        maxScheduledTaskAttempts:
          this.concurrencyConfig.maxScheduledTaskAttempts ?? 3,
        retryBaseDelayMs: this.concurrencyConfig.retryBaseDelayMs ?? 60_000,
        retryMaxDelayMs: this.concurrencyConfig.retryMaxDelayMs ?? 15 * 60_000,
        recoveryStaleAfterMs:
          this.concurrencyConfig.recoveryStaleAfterMs ?? 5 * 60_000,
        execTimeoutMinutes,
      },
      this.taskQueue,
      this.concurrentManager,
      (sessionId, message, task) =>
        this.runAgentLoopWithTask(sessionId, message, task),
      new SqliteScheduledTaskStore(siDb),
    );

    this._bgStarted = false;
    this._messageHistory = new Map<string, ChatMessage[]>();
    this._taskDb = new Database(":memory:");
    this._taskDb.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        message TEXT,
        status TEXT,
        priority INTEGER,
        error TEXT,
        created_at INTEGER,
        started_at INTEGER,
        completed_at INTEGER
      )
    `);

    // Phase 1: Initialise agent registry (use global singleton so all
    // orchestrator instances share the same registry state)
    this.agentRegistry = globalAgentRegistry;

    this.skillLoader = initSkillLoader(paths);
  }

  private _bgStarted = false;
  private _messageHistory = new Map<string, ChatMessage[]>();
  private _taskDb: Database.Database;
  private skillLoader: SkillLoader;

  startBackgroundTasks(): Promise<void> {
    if (this._bgStarted) return Promise.resolve();
    this._bgStarted = true;

    const tasks: Promise<unknown>[] = [];
    if (this._isTurnProfileEnabled() || this.skillGovernance.enabled) {
      tasks.push(this.skillGovernance.initAsync());
    }
    if (this.heartbeat) {
      tasks.push(this.heartbeat.start());
    }

    // Load skills and register them with tool registry
    this._loadSkillsAsync().catch((err) => {
      console.error("Failed to load skills:", err);
    });

    // Start background task scheduler to process queued tasks
    if (this._isCronExecutionEnabled()) {
      this._startTaskScheduler();
    }

    return Promise.all(tasks).then(() => {});
  }

  private async _loadSkillsAsync(): Promise<void> {
    try {
      const skills = await this.skillLoader.loadAll();
      for (const skill of skills) {
        if (!skill.index) {
          continue;
        }
        // Dynamically import the skill module and register its tools
        try {
          const module = await import(skill.index.replace(/\.ts$/, ".js"));
          if (module && typeof module.registerSkills === "function") {
            module.registerSkills(
              this.tools.registerSkillTool.bind(this.tools),
            );
          }
        } catch (err) {
          console.warn(
            `Failed to load skill module ${skill.metadata.id}:`,
            err,
          );
        }
      }
      const pluginTools = await registerRuntimePluginTools(
        this.tools,
        this.runtimePaths,
      );
      if (pluginTools.registered.length > 0) {
        console.log(
          `Registered ${pluginTools.registered.length} runtime plugin tool(s).`,
        );
      }
      if (pluginTools.skipped.length > 0) {
        console.warn(
          `Skipped ${pluginTools.skipped.length} runtime plugin tool contract(s).`,
        );
      }
    } catch (err) {
      console.error("Skill loading error:", err);
    }
  }

  private _startTaskScheduler(): void {
    this.taskScheduler.start();
  }

  private _createHeartbeatEngine(): HeartbeatEngine | null {
    const hbEnabled = this.heartbeatConfig.enabled === true;
    const hbInterval = this.heartbeatConfig.interval_seconds || 300;
    return hbEnabled
      ? new HeartbeatEngine(
          this as unknown as IOrchestrator,
          hbInterval,
          this.heartbeatConfig,
        )
      : null;
  }

  async reloadConfig(): Promise<void> {
    const wasBackgroundStarted = this._bgStarted;
    const previousHeartbeat = this.heartbeat;

    this.config = this._loadConfig();
    this.provider = settings.provider;
    this.modelName = settings.defaultModel;
    this.temperature = settings.defaultTemperature;
    this.toolLockManager.setAcquireTimeoutMs(this._toolLockTimeoutMs());

    const governanceConfig = asAgentConfig(this.config).skill_governance;
    if (typeof governanceConfig?.enabled === "boolean") {
      this.skillGovernance.enabled = governanceConfig.enabled;
    }

    this.heartbeat = this._createHeartbeatEngine();

    if (wasBackgroundStarted) {
      if (previousHeartbeat) {
        await previousHeartbeat.stop();
      }
      if (this.heartbeat) {
        await this.heartbeat.start();
      }
      if (this._isCronExecutionEnabled()) {
        this.taskScheduler.start();
      } else {
        this.taskScheduler.stop();
      }
    }
  }

  stopBackgroundTasks(): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    if (this.heartbeat) tasks.push(this.heartbeat.stop());

    this.taskScheduler.stop();
    this._bgStarted = false;

    return Promise.allSettled(tasks).then(() => {});
  }

  private _loadConfig(): Record<string, unknown> {
    const defaultConfig: Record<string, unknown> = {
      agent: {
        name: "Miki",
        persona: "You are Miki...",
        language: "en",
        timezone: "Asia/Dhaka",
      },
    };
    if (!fs.existsSync(this.agentConfigPath)) return defaultConfig;
    try {
      const raw = fs.readFileSync(this.agentConfigPath, "utf-8");
      const data = yaml.load(raw) as Record<string, unknown> | null;
      const loaded = data || { ...defaultConfig };
      const loadedConfig = asAgentConfig(loaded);
      const agentBlock =
        loadedConfig.agent && typeof loadedConfig.agent === "object"
          ? loadedConfig.agent
          : {};
      for (const key of [
        "heartbeat",
        "self_improvement",
        "skill_governance",
        "concurrency",
      ]) {
        const agentValue = agentBlock[key as keyof typeof agentBlock];
        if (!loaded[key] && agentValue) {
          loaded[key] = agentValue;
        }
      }
      if (
        loadedConfig.heartbeat &&
        typeof loadedConfig.heartbeat === "object" &&
        loadedConfig.heartbeat.interval_seconds == null &&
        typeof (loadedConfig.heartbeat as { interval?: unknown }).interval ===
          "number"
      ) {
        loadedConfig.heartbeat.interval_seconds = (
          loadedConfig.heartbeat as { interval: number }
        ).interval;
      }
      const agentDefaults = loadedConfig.agents?.defaults;
      if (
        agentDefaults &&
        typeof agentDefaults === "object" &&
        typeof agentDefaults.max_tokens === "number"
      ) {
        loadedConfig.agent = {
          ...agentBlock,
          max_tokens_per_cycle:
            agentBlock.max_tokens_per_cycle ?? agentDefaults.max_tokens,
        };
      }
      const validation = validateRuntimeConfig(loaded);
      if (!validation.valid) {
        console.warn(
          "[Agent] Invalid config rejected; using built-in safe defaults:",
          validation.errors
            .map((item) => `${item.path}: ${item.message}`)
            .join("; "),
        );
        return validateRuntimeConfig(defaultConfig).config;
      }
      if (validation.warnings.length > 0) {
        console.warn(
          "[Agent] Config warnings:",
          validation.warnings
            .map((item) => `${item.path}: ${item.message}`)
            .join("; "),
        );
      }
      return validation.config;
    } catch (e: unknown) {
      console.warn(`Failed to load agent config: ${getErrorMessage(e)}`);
      return defaultConfig;
    }
  }

  private async _callLlmApi(
    messages: ChatMessage[],
    toolsSchema?: ToolDefinition[],
    runtimeOptions: { maxTokens?: number } = {},
  ): Promise<LLMResponse> {
    const startedAt = Date.now();
    const metricTags = {
      model: this.modelName,
      tools: String(Boolean(toolsSchema?.length)),
    };
    const options: Record<string, unknown> = {};
    if (toolsSchema && toolsSchema.length > 0) {
      options.tools = toolsSchema;
      options.tool_choice = "auto";
    }
    if (
      typeof runtimeOptions.maxTokens === "number" &&
      Number.isFinite(runtimeOptions.maxTokens) &&
      runtimeOptions.maxTokens > 0
    ) {
      options.max_tokens = Math.floor(runtimeOptions.maxTokens);
    }
    let processedMessages = [...messages];
    try {
      const lastUserMsg = processedMessages
        .filter((m) => m.role === "user")
        .pop();
      if (lastUserMsg && typeof lastUserMsg.content === "string") {
        let contextStr: string | null = null;

        // Try in-process NodeGraphRAG first (fast, avoids HTTP). Fallback to HTTP API if unavailable.
        try {
          const { NodeGraphRAG } = await import("../../memory");
          if (NodeGraphRAG) {
            // reuse a global singleton to avoid re-initializing repeatedly
            // @ts-ignore
            if (!global.__nodeGraphRAGInstance) {
              // @ts-ignore
              global.__nodeGraphRAGInstance = new NodeGraphRAG({
                dataDir: undefined,
                autoSaveIntervalMs: 0,
              });
              // @ts-ignore
              await global.__nodeGraphRAGInstance.initialize();
            }

            // race with timeout (3s)
            // @ts-ignore
            const ctxPromise = global.__nodeGraphRAGInstance.getContext(
              lastUserMsg.content,
            );
            let timeoutId: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<null>(
              (resolve) => (timeoutId = setTimeout(() => resolve(null), 3000)),
            );
            // @ts-ignore
            contextStr = await Promise.race([ctxPromise, timeout]);
            if (timeoutId !== undefined) clearTimeout(timeoutId);
          }
        } catch {
          // ignore -> fall back to HTTP below
          contextStr = null;
        }

        if (!contextStr) {
          try {
            const memRes = await fetch("http://localhost:3777/api/context", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ query: lastUserMsg.content }),
              signal: AbortSignal.timeout(3000),
            });
            if (memRes.ok) {
              contextStr = await memRes.text();
            }
          } catch {
            // failed to fetch remote context, keep contextStr null
          }
        }

        if (contextStr) {
          processedMessages.push({
            role: "system",
            content: "Memory Context:\n" + contextStr,
          } as ChatMessage);
        }
      }
    } catch (e) {
      console.warn(
        "[Agent] Memory context fetch failed (non-blocking):",
        e instanceof Error ? e.message : String(e),
      );
    }

    try {
      const response = await globalExecutionTracer.spanAsync(
        "agent.llm_call",
        () =>
          achatCompletion(
            processedMessages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
            options,
          ),
        metricTags,
      );
      globalMetricsCollector.recordLatency(
        "llm_call",
        Date.now() - startedAt,
        metricTags,
      );

      try {
        const assistantMsg = response.choices?.[0]?.message?.content;
        if (assistantMsg) {
          const lastUserMsg = messages.filter((m) => m.role === "user").pop();
          const interactionLog = `User: ${lastUserMsg?.content || ""}\nAgent: ${assistantMsg}`;
          await fetch("http://localhost:3777/api/memory", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: interactionLog }),
            signal: AbortSignal.timeout(3000),
          });
        }
      } catch (e) {
        console.warn(
          "[Agent] Memory store failed (non-blocking):",
          e instanceof Error ? e.message : String(e),
        );
      }

      return response;
    } catch (err) {
      globalMetricsCollector.recordError("llm_call", metricTags);
      throw err;
    }
  }

  /**
   * Check if we have budget remaining before LLM call
   */
  private _checkBudget(usage: LLMResponse | null): number {
    if (!usage?.usage) return 0;
    const model = this.modelName;
    const budgetTokens = CostCalibrator.costInBudgetTokens(
      model,
      usage.usage.prompt_tokens || 0,
      usage.usage.completion_tokens || 0,
    );
    return budgetTokens;
  }

  private _saveAssistantHistoryMessage(
    sessionId: string,
    content: string,
  ): void {
    if (!content.trim()) return;
    const history = this._messageHistory.get(sessionId) || [];
    history.push({ role: "assistant", content });
    this._messageHistory.set(sessionId, history);
  }

  async *runAgentLoop(
    sessionId: string,
    userMessage: string,
    screenshotImagePath?: string,
    options: { signal?: AbortSignal } = {},
  ): AsyncGenerator<string, void, unknown> {
    if (this.heartbeat) this.heartbeat.markUserInteraction();

    {
      const history = this._messageHistory.get(sessionId) || [];
      history.push({ role: "user", content: userMessage });
      this._messageHistory.set(sessionId, history);
    }
    this._loopCounter = (this._loopCounter + 1) >>> 0;
    const loopId = this._loopCounter;

    // BUG FIX: Track spent budget tokens for this loop
    let spentBudgetTokens = 0;
    const configuredMaxTokensPerCycle =
      asAgentConfig(this.config).agent?.max_tokens_per_cycle ||
      settings.defaultMaxTokens;
    const resource = this._resourceConfig();

    const history = this._messageHistory.get(sessionId) || [];
    const pastMessages = history.slice(-resource.messageHistoryLimit);

    const systemContent = await this._buildSystemContent(
      userMessage,
      screenshotImagePath,
      resource,
    );

    // Warm up tools and prune toolset for faster/more accurate selection
    const allTools = this.tools.getToolDefinitions();
    const prunedTools = globalContextualToolPruner.getPrunedToolset(
      userMessage,
      allTools,
    );

    // Ensure we only use ToolDefinition[] for toolsSchema
    const toolsSchema = (
      prunedTools.length > 0 ? prunedTools : allTools
    ) as ToolDefinition[];

    // Pre-warm the most likely tools
    if (resource.toolWarmupEnabled) {
      globalToolWarmer.warmUp(
        prunedTools.map((t) => t.function.name),
        { query: userMessage },
      );
    }

    let llmMessages: ChatMessage[] = [
      { role: "system", content: systemContent },
    ];

    for (const msg of pastMessages) {
      llmMessages.push({
        role: msg.role as "system" | "user" | "assistant" | "tool",
        content: msg.content,
      });
    }

    llmMessages = AgentOrchestrator._truncateMessagesToFit(
      llmMessages,
      resource.maxContextChars,
    );

    let consecutiveToolOnly = 0;
    let turn = 0;
    let response: LLMResponse | null = null;
    let latestContextUsage: ContextUsageSnapshot | undefined;
    const streamDoneEvent = (tokens: number) =>
      JSON.stringify({
        type: "stream_done",
        usage: { tokens },
        agent_loop_id: loopId,
        model_name: this.modelName,
        ...(latestContextUsage ? { context_usage: latestContextUsage } : {}),
      });

    while (turn < MAX_AGENT_TURNS) {
      if (options.signal?.aborted) {
        yield JSON.stringify({
          type: "error",
          content: "Task cancelled",
        });
        return;
      }

      turn++;
      try {
        llmMessages = AgentOrchestrator._truncateMessagesToFit(
          llmMessages,
          resource.maxContextChars,
        );

        const requestBudget = buildAgentTokenBudget({
          modelName: this.modelName,
          userMessage,
          messages: llmMessages,
          toolsSchema,
          configuredCycleBudget: configuredMaxTokensPerCycle,
          spentBudgetTokens,
          defaultMaxTokens: settings.defaultMaxTokens,
        });
        latestContextUsage = requestBudget.contextUsage;

        if (!requestBudget.shouldCall) {
          const exhaustedMessage =
            "\n\n[Token or context budget exhausted. Stopping.]";
          await this._saveAssistantHistoryMessage(sessionId, exhaustedMessage);
          yield JSON.stringify({
            type: "stream_chunk",
            content: exhaustedMessage,
            model_name: this.modelName,
            context_usage: latestContextUsage,
          });
          yield streamDoneEvent(spentBudgetTokens);
          return;
        }

        // Deduplicate LLM calls for efficiency
        const requestKey = {
          messages: llmMessages,
          tools: toolsSchema,
          maxTokens: requestBudget.maxTokens,
        };
        response = await globalRequestDeduplicator.execute(requestKey, () =>
          this._callLlmApi(llmMessages, toolsSchema, {
            maxTokens: requestBudget.maxTokens,
          }),
        );

        // BUG FIX: Track budget after each call
        spentBudgetTokens += this._checkBudget(response);

        // Evaluate quality of the response
        const choice = response.choices?.[0];
        if (choice?.message?.content) {
          const quality = await globalQualityEvaluator.evaluate(
            choice.message.content,
            userMessage,
          );
          if (
            !globalQualityEvaluator.isAcceptable(quality) &&
            turn <= resource.qualityRetryLimit
          ) {
            console.warn(
              `[Agent] Low quality response detected: ${quality.issues.join(", ")}. Retrying...`,
            );
            const backoffMs = Math.min(1_000 * 2 ** turn, 15_000);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue; // Retry if quality is low
          }
        }
      } catch (err: unknown) {
        const errMsg = `Error calling LLM: ${err instanceof Error ? err.message : String(err)}. Please check credentials.`;
        const errorMessage = `\n\n${errMsg}`;
        await this._saveAssistantHistoryMessage(sessionId, errorMessage);
        yield JSON.stringify({
          type: "stream_chunk",
          content: errorMessage,
          model_name: this.modelName,
          ...(latestContextUsage ? { context_usage: latestContextUsage } : {}),
        });
        yield streamDoneEvent(0);
        return;
      }

      const choice = response.choices?.[0];
      if (!choice) {
        yield streamDoneEvent(0);
        return;
      }

      const msg = choice.message;
      const content: string | null = msg?.content || null;

      if (content) {
        yield JSON.stringify({
          type: "stream_chunk",
          content,
          model_name: this.modelName,
          ...(latestContextUsage ? { context_usage: latestContextUsage } : {}),
        });
        {
          const history = this._messageHistory.get(sessionId) || [];
          history.push({ role: "assistant", content });
          this._messageHistory.set(sessionId, history);
        }
        consecutiveToolOnly = 0;

        if (this._isTaskComplete(content)) {
          yield streamDoneEvent(AgentOrchestrator._extractUsage(response));
          return;
        }
      }

      const toolCalls = msg?.tool_calls as
        | Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>
        | undefined;

      if (toolCalls && toolCalls.length > 0) {
        if (!content) consecutiveToolOnly++;

        if (consecutiveToolOnly >= MAX_AGENT_TURNS_NO_OUTPUT) {
          const warnMsg =
            "Agent exceeded max consecutive tool-call turns without a text response.";
          const warningMessage = `\n\n${warnMsg}`;
          await this._saveAssistantHistoryMessage(sessionId, warningMessage);
          yield JSON.stringify({
            type: "stream_chunk",
            content: warningMessage,
            model_name: this.modelName,
            ...(latestContextUsage
              ? { context_usage: latestContextUsage }
              : {}),
          });
          yield streamDoneEvent(AgentOrchestrator._extractUsage(response));
          return;
        }

        const assistantMsg = AgentOrchestrator._buildAssistantMessage(
          content || "",
          toolCalls,
        );
        llmMessages.push(assistantMsg);

        for await (const event of this._executeToolCallsAndYield(
          sessionId,
          userMessage,
          toolCalls,
          llmMessages,
          turn,
          options.signal,
        )) {
          yield event;
        }
        continue;
      }

      break;
    }

    yield streamDoneEvent(AgentOrchestrator._extractUsage(response));
  }

  private async *_executeToolCallsAndYield(
    sessionId: string,
    userMessage: string,
    toolCalls: RawAgentToolCall[],
    llmMessages: ChatMessage[],
    turn: number,
    signal?: AbortSignal,
  ): AsyncGenerator<string, void, unknown> {
    const invocations = toolCalls.map((tc) => this._parseToolInvocation(tc));
    const plan = createToolExecutionPlan(invocations);
    const taskProfile = classifyAgentTask(userMessage);
    const routeDecision = routeAgentTask(userMessage, this.config, taskProfile);
    const accelerationPlan = buildWorkflowAccelerationPlan(
      taskProfile,
      routeDecision,
      { maxParallelToolCalls: this._maxParallelToolCalls() },
    );
    const decisionPattern = buildWorkflowDecisionPattern(
      taskProfile,
      routeDecision,
      accelerationPlan,
    );
    this.toolConcurrencyMetrics.recordPlan(plan);

    yield JSON.stringify({
      type: "tool_execution_plan",
      total: plan.totalInvocations,
      levels: plan.levels.length,
      parallelizable: plan.parallelizable,
      acceleration_mode: accelerationPlan.mode,
      max_parallel_tool_calls: accelerationPlan.maxParallelToolCalls,
      decision_pattern: decisionPattern.id,
      speed_class: accelerationPlan.speedClass,
      expected_latency: accelerationPlan.expectedLatency,
      verification_depth: accelerationPlan.verificationDepth,
    });

    for (const invocation of invocations) {
      yield JSON.stringify({
        type: "tool_call",
        tool: invocation.toolName,
        input: invocation.toolArgs,
      });
    }

    const results = new Map<number, BufferedToolExecution>();

    for (const level of plan.levels) {
      const executeOne = async (
        planned: PlannedToolInvocation<ParsedToolInvocation>,
      ) => {
        await this._scoreToolConfidence(
          planned.invocation.toolName,
          userMessage,
          turn,
        );
        return this._executePlannedToolInvocation(sessionId, planned, signal);
      };

      const levelResults =
        level.parallel && level.items.length > 1
          ? await mapWithConcurrencyLimit(
              level.items,
              accelerationPlan.maxParallelToolCalls,
              executeOne,
            )
          : await this._executeSequentialToolInvocations(
              level.items,
              executeOne,
            );

      for (const result of levelResults) {
        results.set(result.index, result);
        for (const event of result.events) {
          yield event;
        }
      }
    }

    for (let index = 0; index < invocations.length; index++) {
      const result = results.get(index);
      if (result) llmMessages.push(result.toolMessage);
    }

    yield JSON.stringify({
      type: "tool_concurrency_metrics",
      stats: this.toolConcurrencyMetrics.snapshot(),
      locks: this.toolLockManager.getStats(),
    });
  }

  private async _executeSequentialToolInvocations(
    invocations: Array<PlannedToolInvocation<ParsedToolInvocation>>,
    executeOne: (
      invocation: PlannedToolInvocation<ParsedToolInvocation>,
    ) => Promise<BufferedToolExecution>,
  ): Promise<BufferedToolExecution[]> {
    const results: BufferedToolExecution[] = [];
    for (const invocation of invocations) {
      results.push(await executeOne(invocation));
    }
    return results;
  }

  private async _scoreToolConfidence(
    toolName: string,
    userMessage: string,
    turn: number,
  ): Promise<void> {
    const assessment = await globalConfidenceScorer.scoreDecision(
      toolName,
      userMessage,
    );
    if (assessment.confidence < 0.4 && turn < 3) {
      console.warn(
        `[Agent] Low confidence in tool ${toolName} (${assessment.confidence.toFixed(2)}). Seeking clarification...`,
      );
    }
  }

  async *runAgentLoopWithTask(
    sessionId: string,
    userMessage: string,
    taskOrPriority?: AgentTask | number,
  ): AsyncGenerator<string, void, unknown> {
    const priority =
      typeof taskOrPriority === "number"
        ? taskOrPriority
        : (taskOrPriority?.priority ?? 0);
    let task = typeof taskOrPriority === "object" ? taskOrPriority : null;

    // Only enqueue if task wasn't provided
    if (!task) {
      task = this.taskQueue.enqueue(sessionId, userMessage, priority);
      if (!task) {
        yield JSON.stringify({ type: "error", content: "Task queue is full" });
        return;
      }
    }
    this._annotateTaskRoute(task, userMessage);

    // Bug #4 fix: Mark task as running (move from pending to running)
    this.taskQueue.markRunning(task.id);
    task = this.taskQueue.getTask(task.id)!;

    task.abortController = new AbortController();

    // Acquire concurrency slot
    const release = await this.concurrentManager.acquire();

    try {
      if (task.abortController?.signal.aborted || task.status === "cancelled") {
        try {
          const db = this._taskDb;
          db.prepare(
            `INSERT OR REPLACE INTO agent_tasks 
            (id, session_id, message, status, completed_at) 
            VALUES (?, ?, ?, ?, ?)`,
          ).run(task.id, task.sessionId, task.message, "cancelled", Date.now());
        } catch (e2) {
          console.warn(
            `[Agent] DB cancel update failed: ${e2 instanceof Error ? e2.message : e2}`,
          );
        }

        yield JSON.stringify({
          type: "task_status",
          task_id: task.id,
          status: "cancelled",
        });
        return;
      }

      // Update task status in database
      try {
        const db = this._taskDb;
        db.prepare(
          `INSERT OR REPLACE INTO agent_tasks 
          (id, session_id, message, status, priority, started_at) 
          VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          task.id,
          task.sessionId,
          task.message,
          "running",
          task.priority,
          Date.now(),
        );
      } catch (e) {
        console.warn(
          `[Agent] DB task status update failed: ${e instanceof Error ? e.message : e}`,
        );
      }

      yield JSON.stringify({
        type: "task_status",
        task_id: task.id,
        status: "running",
      });

      // Phase 4: Run strategy selection
      if (task.route?.mode === "multi_agent") {
        const delegator = new AgentDelegator(
          this.agentRegistry,
          globalAgentMessageBus,
          createAgentFactory(this.runtimePaths),
          globalAgentBlackboard,
        );
        const strategy = createRunStrategy(
          task.route as unknown as AgentRouteDecision,
          delegator,
          globalAgentAggregator,
          globalAgentPlanner,
        );

        if (strategy) {
          const startStr = JSON.stringify({
            type: "multi_agent_start",
            handles: [],
          });
          yield startStr + "\n";

          const result = await strategy.run({
            ...task,
            prompt: task.message, // AgentTask requires prompt, but here we have message
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);

          yield result.response;

          if (result.aggregationSummary) {
            yield "\n\n" + result.aggregationSummary;
          }
        }
      } else {
        for await (const chunk of this.runAgentLoop(
          sessionId,
          userMessage,
          undefined,
          { signal: task.abortController.signal },
        )) {
          const latestTask = this.taskQueue.getTask(task.id);
          if (
            task.abortController?.signal.aborted ||
            latestTask?.status === "cancelled"
          ) {
            this.taskQueue.cancel(task.id);

            // Update database
            try {
              const db = this._taskDb;
              db.prepare(
                `INSERT OR REPLACE INTO agent_tasks 
              (id, session_id, message, status, completed_at) 
              VALUES (?, ?, ?, ?, ?)`,
              ).run(
                task.id,
                task.sessionId,
                task.message,
                "cancelled",
                Date.now(),
              );
            } catch (e2) {
              console.warn(
                `[Agent] DB cancel update failed: ${e2 instanceof Error ? e2.message : e2}`,
              );
            }

            yield JSON.stringify({
              type: "task_status",
              task_id: task.id,
              status: "cancelled",
            });
            return;
          }

          yield chunk;
        }
      } // End else block

      this.taskQueue.complete(task.id);

      // Update database
      try {
        const db = this._taskDb;
        db.prepare(
          `INSERT OR REPLACE INTO agent_tasks 
          (id, session_id, message, status, completed_at) 
          VALUES (?, ?, ?, ?, ?)`,
        ).run(task.id, task.sessionId, task.message, "completed", Date.now());
      } catch (e2) {
        console.warn(
          `[Agent] DB complete update failed: ${e2 instanceof Error ? e2.message : e2}`,
        );
      }
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      this.taskQueue.fail(task.id, errorMessage);

      // Update database
      try {
        const db = this._taskDb;
        db.prepare(
          `INSERT OR REPLACE INTO agent_tasks 
          (id, session_id, message, status, error, completed_at) 
          VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          task.id,
          task.sessionId,
          task.message,
          "failed",
          errorMessage,
          Date.now(),
        );
      } catch (e2) {
        console.warn(
          `[Agent] DB failure update failed: ${e2 instanceof Error ? e2.message : e2}`,
        );
      }
    } finally {
      // Always release, even if error occurred
      release();
    }
  }

  cancelTask(taskId: string): boolean {
    const task = this.taskQueue.getTask(taskId);
    if (!task) return false;

    this.taskQueue.cancel(taskId);
    return true;
  }

  getTask(taskId: string): AgentTask | undefined {
    return this.taskQueue.getTask(taskId);
  }

  getTasksBySession(sessionId: string): AgentTask[] {
    return this.taskQueue.getTasksBySession(sessionId);
  }

  enqueueTask(
    sessionId: string,
    message: string,
    priority?: number,
  ): AgentTask | null {
    const task = this.taskQueue.enqueue(sessionId, message, priority);
    if (task) this._annotateTaskRoute(task, message);
    return task;
  }

  scheduleTask(
    sessionId: string,
    message: string,
    cronExpression?: string,
    runAt?: number,
    options: { maxAttempts?: number } = {},
  ): ScheduledTask {
    return this.taskScheduler.schedule(
      sessionId,
      message,
      cronExpression,
      runAt,
      options,
    );
  }

  cancelScheduledTask(taskId: string): boolean {
    return this.taskScheduler.cancelScheduled(taskId);
  }

  getScheduledTasks(): ScheduledTask[] {
    return this.taskScheduler.getScheduledTasks();
  }

  getScheduledTaskHistory(limit?: number): ScheduledTask[] {
    return this.taskScheduler.getScheduledTaskHistory(limit);
  }

  getTaskSchedulerStats() {
    return this.taskScheduler.getStats();
  }

  getTaskQueueStats() {
    const schedulerStats = this.taskScheduler.getStats();
    return {
      ...this.taskQueue.getStats(),
      active: this.concurrentManager.activeCount,
      maxConcurrent: this.concurrentManager.maxConcurrent,
      waiting: this.concurrentManager.waitingCount,
      scheduler: {
        running: this.taskScheduler.isRunning(),
        processed: schedulerStats.processed,
        failed: schedulerStats.failed,
        dequeued: schedulerStats.dequeued,
        recovered: schedulerStats.recovered,
        retried: schedulerStats.retried,
        deadLettered: schedulerStats.deadLettered,
        scheduledTasks: schedulerStats.scheduledTasks,
        scheduledHistory: schedulerStats.scheduledHistory,
      },
      toolConcurrency: this.toolConcurrencyMetrics.snapshot(),
      toolLocks: this.toolLockManager.getStats(),
    };
  }

  routeAgentTask(userMessage: string): AgentRouteDecision {
    return routeAgentTask(userMessage, this.config);
  }

  private _annotateTaskRoute(task: AgentTask, userMessage: string): void {
    task.route = summarizeAgentRoute(this.routeAgentTask(userMessage));
  }

  private async _buildSystemContent(
    userMessage: string,
    screenshotImagePath?: string,
    _resource: ResolvedAgentResourceConfig = this._resourceConfig(),
  ): Promise<string> {
    const taskProfile = classifyAgentTask(userMessage);
    const routeDecision = routeAgentTask(userMessage, this.config, taskProfile);
    const accelerationPlan = buildWorkflowAccelerationPlan(
      taskProfile,
      routeDecision,
      { maxParallelToolCalls: this._maxParallelToolCalls() },
    );
    const decisionPattern = buildWorkflowDecisionPattern(
      taskProfile,
      routeDecision,
      accelerationPlan,
    );
    const taskProfileBlock = `\n${formatAgentTaskProfile(taskProfile)}\n`;
    const agentRouteBlock = `\n${formatAgentRouteDecision(routeDecision)}\n`;
    const accelerationBlock = `\n${formatWorkflowAccelerationPlan(accelerationPlan)}\n`;
    const decisionPatternBlock = `\n${formatWorkflowDecisionPattern(decisionPattern)}\n`;

    const systemIndexBlock = "";
    let screenshotBlock = "";
    let screenshotNote = "";
    if (screenshotImagePath && fs.existsSync(screenshotImagePath)) {
      screenshotBlock = "\n[SCREENSHOT ATTACHED]: ...\n";
      screenshotNote = "\n\nA screenshot image is attached for reference.";
    }

    const systemPersona: string = this.agentConfig.persona || "";
    const explicitTurnProfile = this._isTurnProfileEnabled();
    let dynamicStateBlock = "";
    if (explicitTurnProfile) {
      const siTunings: string[] = this.selfImprovement.getAccumulatedTunings();
      if (siTunings && siTunings.length > 0) {
        const last3 = siTunings.slice(-3);
        dynamicStateBlock +=
          "\n[SELF-IMPROVEMENT NOTES]\n" +
          last3.map((t) => `- ${t}`).join("\n") +
          "\n";
      }

      const plan = this.skillGovernance.selfPlanner.getActivePlan();
      if (plan) {
        const summary = this.skillGovernance.selfPlanner.planSummary();
        if (summary) {
          interface PlanStep {
            status?: string;
            description?: string;
          }
          const steps: PlanStep[] = plan.steps || [];
          const pending = steps.filter((s) => s.status === "pending");
          const inProgress = steps.filter((s) => s.status === "in_progress");
          dynamicStateBlock += "\n[ACTIVE PLAN]\nPlan: ...\n";
          for (const s of inProgress) {
            dynamicStateBlock += `  IN PROGRESS: ${s.description}\n`;
          }
          for (const s of pending.slice(0, 3)) {
            dynamicStateBlock += `  PENDING: ${s.description}\n`;
          }
        }
      }
    }

    return (
      `${screenshotBlock}${systemPersona}` +
      `${taskProfileBlock}` +
      `${agentRouteBlock}` +
      `${accelerationBlock}` +
      `${decisionPatternBlock}` +
      `${systemIndexBlock}` +
      `${dynamicStateBlock}` +
      `You operate as a computer-based agent with full system access. Use absolute paths for any file operation outside the project workspace. You can launch applications, control windows, send keyboard shortcuts, read/write the clipboard, and execute shell commands anywhere on the system. Keep tool use purposeful, auditable, and verification-driven.\n\n` +
      `${screenshotNote}`
    );
  }

  private _parseToolInvocation(tc: RawAgentToolCall): ParsedToolInvocation {
    const [tcId, toolName, toolArgsStr] =
      AgentOrchestrator._extractToolCall(tc);

    let toolArgs: Record<string, unknown>;
    try {
      const parsed =
        typeof toolArgsStr === "string" && toolArgsStr.trim()
          ? (JSON.parse(toolArgsStr) as unknown)
          : {};
      toolArgs =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : { value: parsed };
    } catch (err) {
      console.warn(`[Agent] Failed to parse tool args for ${toolName}:`, err);
      toolArgs = { raw: toolArgsStr };
    }

    return { tcId, toolName, toolArgs };
  }

  private async _executePlannedToolInvocation(
    sessionId: string,
    planned: PlannedToolInvocation<ParsedToolInvocation>,
    signal?: AbortSignal,
  ): Promise<BufferedToolExecution> {
    let release: (() => void) | null = null;
    let ok = false;

    try {
      const acquired = await this.toolLockManager.acquireMany(
        planned.policy.locks,
        signal,
      );
      release = acquired.release;
      this.toolConcurrencyMetrics.recordLockWait(acquired.waitMs);
      this.toolConcurrencyMetrics.beginInvocation();
      const result = await this._executeToolInvocation(
        sessionId,
        planned.index,
        planned.invocation,
        planned.policy,
        signal,
      );
      ok = result.ok;
      return result;
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      if (errorMessage.toLowerCase().includes("lock timeout")) {
        this.toolConcurrencyMetrics.recordLockTimeout();
      }
      return this._buildToolFailureResult(
        planned.index,
        planned.invocation,
        `Error executing tool ${planned.invocation.toolName}: ${errorMessage}`,
      );
    } finally {
      this.toolConcurrencyMetrics.endInvocation(ok);
      release?.();
    }
  }

  private async _executeToolInvocation(
    sessionId: string,
    index: number,
    invocation: ParsedToolInvocation,
    policy: ToolConcurrencyPolicy,
    signal?: AbortSignal,
  ): Promise<BufferedToolExecution> {
    const { tcId, toolName, toolArgs } = invocation;
    const events: string[] = [];
    const startedAt = Date.now();

    let toolOutput: string;
    let toolAttempts = 0;
    let ok = false;

    while (true) {
      if (signal?.aborted) {
        toolOutput = `Error executing tool ${toolName}: Task cancelled`;
        break;
      }

      const result = await this.tools.executeToolStructured(
        toolName,
        toolArgs,
        { timeoutMs: policy.timeoutMs, signal },
      );
      if (result.success) {
        toolOutput = result.output;
        ok = true;
        break;
      }

      toolAttempts++;
      const errMsg = result.error || result.output || "Unknown tool failure";

      if (toolAttempts >= policy.retry.maxAttempts) {
        toolOutput = `Error executing tool ${toolName} after ${toolAttempts} attempts: ${errMsg}`;
        break;
      }

      const isRetryable =
        errMsg.toLowerCase().includes("timeout") ||
        errMsg.toLowerCase().includes("network") ||
        errMsg.toLowerCase().includes("econn");

      if (!isRetryable) {
        toolOutput = `Error executing tool ${toolName}: ${errMsg}`;
        break;
      }

      const delayMs = Math.min(
        policy.retry.baseDelayMs * Math.pow(2, toolAttempts - 1),
        policy.retry.maxDelayMs,
      );
      this.toolConcurrencyMetrics.recordRetry();
      events.push(
        JSON.stringify({
          type: "tool_retry",
          tool: toolName,
          attempt: toolAttempts,
          delay_ms: delayMs,
        }),
      );
      await this._sleep(delayMs, signal);
    }

    globalMetricsCollector.recordLatency(
      "tool_execution",
      Date.now() - startedAt,
      { success: String(ok), tool: toolName },
    );
    if (!ok) {
      globalMetricsCollector.recordError("tool_execution", { tool: toolName });
    }

    events.push(
      JSON.stringify({
        type: "tool_result",
        tool: toolName,
        output: toolOutput,
      }),
    );

    return {
      index,
      events,
      ok,
      toolMessage: {
        role: "tool",
        tool_call_id: tcId,
        name: toolName,
        content: toolOutput,
      },
    };
  }

  private _buildToolFailureResult(
    index: number,
    invocation: ParsedToolInvocation,
    output: string,
  ): BufferedToolExecution {
    return {
      index,
      ok: false,
      events: [
        JSON.stringify({
          type: "tool_result",
          tool: invocation.toolName,
          output,
        }),
      ],
      toolMessage: {
        role: "tool",
        tool_call_id: invocation.tcId,
        name: invocation.toolName,
        content: output,
      },
    };
  }

  private _sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    if (signal?.aborted) {
      return Promise.reject(new Error("Task cancelled"));
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error("Task cancelled"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private static _extractToolCall(
    tc: RawAgentToolCall,
  ): [string, string, string] {
    const tcId: string = tc?.id || "";
    const tcFn = tc?.function;
    if (tcFn && typeof tcFn.name === "string") {
      return [tcId, tcFn.name, tcFn.arguments || ""];
    }
    return [tcId, "", ""];
  }

  private static _buildAssistantMessage(
    content: string,
    toolCalls: RawAgentToolCall[],
  ): ChatMessage {
    const msg: ChatMessage = { role: "assistant", content: content || "" };
    msg.tool_calls = toolCalls.map((tc) => {
      const [id, name, args] = AgentOrchestrator._extractToolCall(tc);
      return {
        id,
        type: "function" as const,
        function: { name, arguments: args },
      };
    });
    return msg;
  }

  private static _extractUsage(response: LLMResponse | null): number {
    if (!response) return 0;
    const usage = response?.usage;
    if (!usage) return 0;
    if (typeof usage.total_tokens === "number") return usage.total_tokens;
    return 0;
  }

  private _isTaskComplete(content: string): boolean {
    // Bug #8 fix: Stricter completion detection - require phrases at end of message
    // and avoid common false positives like "successfully" in tool outputs
    const trimmedContent = content.trim();
    const lowerContent = trimmedContent.toLowerCase();

    // Check for completion phrases only at the end (last 100 chars)
    const endPortion = lowerContent.slice(-100);

    // Only match specific phrases that indicate actual completion
    const completionPhrases = [
      "task completed",
      "finished successfully",
      "done. no further action needed",
    ];

    // Check if any completion phrase appears at the end
    const hasCompletionPhrase = completionPhrases.some((phrase) =>
      endPortion.includes(phrase),
    );

    // Check for "done." only as a short conclusive response, not mid-sentence
    const shortDone = /^(it\s+is\s+)?done\.?\s*$/i.test(trimmedContent);

    if (hasCompletionPhrase || shortDone) {
      this._logMemoryUsage("early-termination");
      return true;
    }

    return false;
  }

  private _logMemoryUsage(context: string): void {
    const used = process.memoryUsage();
    console.log(
      `[MEMORY] ${context}: RSS=${(used.rss / 1024 / 1024).toFixed(1)}MB, Heap=${(used.heapUsed / 1024 / 1024).toFixed(1)}MB`,
    );
  }
}

// =============================================================================
// Phase 1 & 3: AgentFactory export
// =============================================================================

/**
 * Concrete AgentFactory implementation that AgentDelegator uses to boot and
 * shut down specialist instances.
 *
 * "Booting" in this context means:
 *  1. Subscribing the new instance to the message bus so it can receive tasks
 *  2. Registering a handler that runs the agent loop and publishes the result
 *
 * In a full implementation this would spawn a worker thread / process. Here
 * the specialist shares the same process but has an isolated message-bus
 * subscription so the delegation protocol is real end-to-end.
 */
export function createAgentFactory(paths: RuntimePaths | string): AgentFactory {
  return {
    async boot(instance: AgentInstance): Promise<void> {
      // Subscribe this instance to the message bus.
      // When it receives a task_delegate message it processes it and sends
      // back a task_result reply.
      const unsubscribe = globalAgentMessageBus.subscribe(
        instance.id,
        async (msg) => {
          if (msg.type !== "task_delegate") return;

          try {
            const payload = msg.payload as {
              taskId?: string;
              prompt?: string;
            };
            const prompt = payload?.prompt ?? String(payload);

            // Minimal in-process execution: re-uses a lightweight orchestrator
            // instance. In production this would be a full agent run.
            const orchestrator = new AgentOrchestrator(paths);
            const response = await orchestrator.runAgentLoop(
              instance.sessionId,
              prompt,
            );

            globalAgentMessageBus.send({
              id: crypto.randomUUID(),
              type: "task_result",
              from: instance.id,
              to: msg.from,
              payload: response ?? `[${instance.specialistId}] completed`,
              timestamp: new Date(),
              correlationId: msg.id,
            });
          } catch (err) {
            globalAgentMessageBus.send({
              id: crypto.randomUUID(),
              type: "error",
              from: instance.id,
              to: msg.from,
              payload: err instanceof Error ? err.message : String(err),
              timestamp: new Date(),
              correlationId: msg.id,
            });
          }
        },
      );

      // Store unsubscribe on the instance for shutdown
      (instance as AgentInstance & { _unsubscribe?: () => void })._unsubscribe =
        unsubscribe;
    },

    async shutdown(instance: AgentInstance): Promise<void> {
      const typed = instance as AgentInstance & { _unsubscribe?: () => void };
      if (typeof typed._unsubscribe === "function") {
        typed._unsubscribe();
      }
      globalAgentRegistry.terminate(instance.id);
    },
  };
}

import * as crypto from "crypto";
