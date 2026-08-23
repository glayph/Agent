import * as path from "path";
import * as fs from "fs";
import * as yaml from "js-yaml";
import {
  settings,
  ChatMessage,
  ToolDefinition,
  type VoiceMessageMetadata,
  LLMResponse,
  validateRuntimeConfig,
  createWorkspaceSecretVault,
} from "@miki/config";
import { ToolRegistry } from "./tools/index.js";
import { HeartbeatEngine, type IOrchestrator } from "./heartbeat.js";
import { SelfImprovementEngine } from "./self-improvement/engine.js";
import type { SelfImprovementConfig } from "./self-improvement/engine.js";
import type {
  LLMCallFn,
  Memory as SelfImprovementMemory,
} from "./self-improvement/engine.js";
import { SkillGovernanceEngine } from "./skill-governance/engine.js";
import {
  achatCompletion,
  LiteLLMMissingCredentialError,
  LiteLLMRateLimitError,
  LLMMissingCredentialError,
  LLMEntitlementError,
  LLMRateLimitError,
  LLMTimeoutError,
  LLMProviderError,
} from "./llm.js";
import Database from "better-sqlite3";
import { TaskQueue, AgentTask } from "./task-queue.js";
import { ConcurrentTaskManager } from "./concurrent-manager.js";
import { TaskScheduler, type ScheduledTask } from "./scheduler.js";
import { SqliteScheduledTaskStore } from "./scheduled-task-store.js";
import {
  createAutomationRuntime,
  parseAutomationMessage,
  type AutomationManager,
} from "./automation.js";
import { SqlitePlatformConnectionStore } from "./platform-connections.js";
import { buildAgentTokenBudget } from "./agent-token-budget.js";
import { initSkillLoader, SkillLoader } from "./skill-loader.js";
import { globalToolWarmer } from "./tools/tool-warmer.js";
import {
  formatAdaptiveCapabilitySelection,
  selectAdaptiveCapabilities,
  type AdaptiveCapabilitySelection,
} from "./adaptive-capability-selector.js";
import {
  analyzePlanCapabilities,
  formatPlanCapabilityReport,
  type PlanCapabilityReport,
} from "./plan-capability-analyzer.js";
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
  detectDeterministicIntent,
  type DeterministicFileRequest,
} from "./deterministic-intent.js";
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
  SqliteSessionHistoryStore,
  type SessionMetadata,
} from "./session-history-store.js";
import { initMemory, getMemory } from "./memory/memory-bridge.js";
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
import type { AgentControlService } from "./control/index.js";
import type { MikiProviderAudio } from "./llm/provider/sdk/index.js";

const MAX_AGENT_TURNS = 50;
const MAX_AGENT_TURNS_NO_OUTPUT = 12;
const DEFAULT_WEB_SEARCH_CALLS_PER_TURN = 2;
const DEFAULT_MESSAGE_HISTORY_LIMIT = 15;

// Bug #9 fix: Add approximate token/character cap to message history
const DEFAULT_MAX_TOTAL_CONTEXT_CHARS = 80000; // ~20K tokens
const LOCAL_LLM_CALL_TIMEOUT_MS = Math.max(
  90_000,
  Number.parseInt(process.env.MIKI_LOCAL_LLM_TIMEOUT_MS || "300000", 10) ||
    300_000,
);
const REMOTE_LLM_CALL_TIMEOUT_MS = 120_000;
const LOCAL_AGENT_RUN_TIMEOUT_MS = 300_000;
const REMOTE_AGENT_RUN_TIMEOUT_MS = 240_000;

function isLocalModelName(model: string): boolean {
  return (
    /^(llama\.cpp|llama-cpp|llamacpp|local-llama)\//i.test(model) ||
    /(?:^|[-_/])local(?:$|[-_/])/i.test(model)
  );
}

function buildToolOnlyFallbackResponse(messages: ChatMessage[]): string {
  const results: Array<{ title: string; url: string; snippet?: string }> = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.role !== "tool" || message.name !== "web_search") continue;
    if (typeof message.content !== "string") continue;
    try {
      const payload = JSON.parse(message.content) as {
        results?: unknown;
      };
      if (!Array.isArray(payload.results)) continue;
      for (const item of payload.results) {
        if (!item || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        const title =
          typeof record.title === "string" ? record.title.trim() : "";
        const url = typeof record.url === "string" ? record.url.trim() : "";
        if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
        seen.add(url);
        results.push({
          title,
          url,
          ...(typeof record.snippet === "string"
            ? { snippet: record.snippet.trim().slice(0, 500) }
            : {}),
        });
      }
    } catch {
      // Ignore non-JSON or failed tool output; another search result may exist.
    }
  }

  if (results.length === 0) return "";
  const sourceCount = results.length;
  return `আমি বিষয়টি খুঁজে দেখেছি, তবে এখনই নিশ্চিত synthesis দিতে পারছি না। ${sourceCount}টি source lead Inspector-এর Work/Thoughts-এ রাখা আছে—সেগুলো cross-check না করে কোনো leak বা rumor-কে confirmed তথ্য হিসেবে ধরবেন না।`;
}

function buildDeterministicSearchResponse(output: string): string {
  try {
    const parsed = JSON.parse(output) as {
      results?: unknown;
    };
    const results = Array.isArray(parsed.results)
      ? parsed.results.filter(
          (item): item is Record<string, unknown> =>
            Boolean(item) && typeof item === "object",
        )
      : [];
    const verified = results.filter(
      (item) =>
        typeof item.title === "string" &&
        /^https?:\/\//i.test(String(item.url || "")),
    );
    if (verified.length === 0) {
      return "ওয়েব সার্চ চালানো হয়েছে, কিন্তু কোনো verified result পাওয়া যায়নি।";
    }
    const lines = verified.slice(0, 3).map((item, index) => {
      const title = String(item.title).trim().slice(0, 180);
      const url = String(item.url).trim();
      return `${index + 1}. ${title} — ${url}`;
    });
    return `ওয়েবে খুঁজে পাওয়া source:\n${lines.join("\n")}`;
  } catch {
    return output.startsWith("Web search failed:")
      ? "ওয়েব সার্চ ব্যর্থ হয়েছে; কোনো verified ফলাফল পাওয়া যায়নি।"
      : "ওয়েব সার্চের ফলাফল যাচাই করা যায়নি।";
  }
}

function normalizeReadBack(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function readWorkspaceFile(
  workspaceDir: string,
  requestedPath: string,
): string | null {
  try {
    const workspaceRoot = path.resolve(workspaceDir);
    const targetPath = path.resolve(workspaceRoot, requestedPath);
    const relativeTarget = path.relative(workspaceRoot, targetPath);
    if (relativeTarget.startsWith("..") || path.isAbsolute(relativeTarget)) {
      return null;
    }
    const realWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
    const realTargetPath = fs.realpathSync.native(targetPath);
    const realRelativeTarget = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      realRelativeTarget.startsWith("..") ||
      path.isAbsolute(realRelativeTarget)
    ) {
      return null;
    }
    if (!fs.statSync(realTargetPath).isFile()) return null;
    return fs.readFileSync(realTargetPath, "utf8");
  } catch {
    return null;
  }
}

function buildDeterministicFileResponse(
  files: DeterministicFileRequest[],
  toolMessages: ChatMessage[],
  workspaceDir: string,
): string {
  const writes = toolMessages.filter(
    (message) => message.name === "file_write",
  );
  const reads = toolMessages.filter((message) => message.name === "file_read");
  const checks = files.map((request, index) => {
    const writeOutput = writes[index]?.content || "";
    const readOutput = reads[index]?.content || "";
    const workspaceContent = readWorkspaceFile(workspaceDir, request.path);
    const writeOk = !/^Error(?: executing tool)?/i.test(writeOutput.trim());
    const readOk =
      !/^Error(?: executing tool)?/i.test(readOutput.trim()) &&
      workspaceContent !== null &&
      normalizeReadBack(workspaceContent) ===
        normalizeReadBack(request.content);
    return { request, ok: writeOk && readOk };
  });
  if (checks.length > 0 && checks.every((item) => item.ok)) {
    return `ফাইল তৈরি ও যাচাই সফল: ${checks.map((item) => item.request.path).join(", ")}`;
  }
  const failed = checks
    .filter((item) => !item.ok)
    .map((item) => item.request.path);
  return `ফাইল workflow সম্পূর্ণভাবে যাচাই করা যায়নি: ${failed.join(", ") || "unknown file"}`;
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(resolve, reject).finally(() => timer && clearTimeout(timer));
  });
}

type AgentResourceMode = "eco" | "balanced" | "performance";

interface AgentResourceConfig {
  mode?: AgentResourceMode;
  message_history_limit?: number;
  web_search_max_calls_per_turn?: number;
  max_context_chars?: number;
  system_index_limit?: number;
  system_index_cache_ttl_ms?: number;
  tool_warmup_enabled?: boolean;
  quality_retry_limit?: number;
}

interface ResolvedAgentResourceConfig {
  mode: AgentResourceMode;
  messageHistoryLimit: number;
  webSearchMaxCallsPerTurn: number;
  maxContextChars: number;
  contextWindowTokens?: number;
  summarizeMessageThreshold: number;
  summarizeTokenPercent: number;
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
    webSearchMaxCallsPerTurn: 1,
    maxContextChars: 40000,
    summarizeMessageThreshold: 20,
    summarizeTokenPercent: 75,
    toolWarmupEnabled: false,
    qualityRetryLimit: 0,
  },
  balanced: {
    mode: "balanced",
    messageHistoryLimit: DEFAULT_MESSAGE_HISTORY_LIMIT,
    webSearchMaxCallsPerTurn: DEFAULT_WEB_SEARCH_CALLS_PER_TURN,
    maxContextChars: DEFAULT_MAX_TOTAL_CONTEXT_CHARS,
    summarizeMessageThreshold: 20,
    summarizeTokenPercent: 75,
    toolWarmupEnabled: true,
    qualityRetryLimit: 1,
  },
  performance: {
    mode: "performance",
    messageHistoryLimit: 25,
    webSearchMaxCallsPerTurn: 3,
    maxContextChars: 120000,
    summarizeMessageThreshold: 20,
    summarizeTokenPercent: 75,
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

interface AgentMemoryConfig {
  max_context_chars?: number;
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
      workspace?: string;
      max_tokens?: number;
      context_window?: number;
      max_tool_iterations?: number;
      summarize_message_threshold?: number;
      summarize_token_percent?: number;
      turn_profile?: {
        enabled?: boolean;
        history?: { mode?: string; allow?: string[] };
        system_prompt?: { mode?: string };
        skills?: { mode?: string; allow?: string[] };
        tools?: { mode?: string; allow?: string[] };
      };
    };
    specialists?: unknown;
  };
  memory?: AgentMemoryConfig;
  tools?: { cron?: { allow_command?: boolean; exec_timeout_minutes?: number } };
  self_improvement?: SelfImprovementConfig;
  skill_governance?: Record<string, unknown>;
}

type RawAgentToolCall = {
  id?: string;
  function?: { name?: string; arguments?: string };
  extra_content?: Record<string, unknown>;
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
  private static _compactMessagesIfNeeded(
    messages: ChatMessage[],
    resource: ResolvedAgentResourceConfig,
  ): ChatMessage[] {
    const totalChars = messages.reduce(
      (sum, message) => sum + (message.content?.length || 0),
      0,
    );
    const thresholdChars = Math.floor(
      resource.maxContextChars * (resource.summarizeTokenPercent / 100),
    );
    if (
      messages.length < resource.summarizeMessageThreshold ||
      totalChars <= thresholdChars
    ) {
      return messages;
    }

    const systemMessages = messages.filter(
      (message) => message.role === "system",
    );
    const conversational = messages.filter(
      (message) => message.role !== "system",
    );
    const keepCount = Math.max(
      4,
      Math.ceil(resource.summarizeMessageThreshold / 2),
    );
    if (conversational.length <= keepCount) return messages;

    const older = conversational.slice(0, -keepCount);
    const summaryLines = older
      .map((message) => {
        const content = String(message.content || "")
          .replace(/\s+/g, " ")
          .trim();
        if (!content) return "";
        return `${message.role}: ${content.slice(0, 320)}`;
      })
      .filter(Boolean)
      .slice(-40);
    if (summaryLines.length === 0) return messages;

    const summary: ChatMessage = {
      role: "system",
      content:
        "Earlier conversation context was compacted to stay within the configured context window. " +
        "Use these preserved facts when relevant:\n" +
        summaryLines.join("\n"),
    };
    return [...systemMessages, summary, ...conversational.slice(-keepCount)];
  }

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
  public platformConnectionStore: SqlitePlatformConnectionStore;
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
  /** Shared dashboard-backed management service, attached by the API bootstrap. */
  public control: AgentControlService | null = null;

  getControlService(): AgentControlService | null {
    return this.control;
  }

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
    history?: { mode?: string; allow?: string[] };
    system_prompt?: { mode?: string };
    skills?: { mode?: string; allow?: string[] };
    tools?: { mode?: string; allow?: string[] };
  } {
    return asAgentConfig(this.config).agents?.defaults?.turn_profile || {};
  }

  private _isTurnProfileEnabled(): boolean {
    return this.turnProfileConfig.enabled === true;
  }

  private _turnProfilePolicy(): {
    enabled: boolean;
    historyMode: "default" | "off";
    systemPromptMode: "default" | "off";
    skillsMode: "default" | "off" | "custom";
    skillsAllow: Set<string>;
    toolsMode: "default" | "off" | "custom";
    toolsAllow: Set<string>;
  } {
    const profile = this.turnProfileConfig;
    const normalizeMode = <T extends "default" | "off" | "custom">(
      value: unknown,
      fallback: T,
    ): T =>
      value === "off" || value === "custom" || value === "default"
        ? (value as T)
        : fallback;
    const normalizeAllow = (value: unknown): Set<string> =>
      new Set(
        Array.isArray(value)
          ? value
              .filter((item): item is string => typeof item === "string")
              .map((item) => item.trim())
              .filter(Boolean)
          : [],
      );
    return {
      enabled: profile.enabled === true,
      historyMode: normalizeMode(profile.history?.mode, "default") as
        "default" | "off",
      systemPromptMode: normalizeMode(
        profile.system_prompt?.mode,
        "default",
      ) as "default" | "off",
      skillsMode: normalizeMode(profile.skills?.mode, "default"),
      skillsAllow: normalizeAllow(profile.skills?.allow),
      toolsMode: normalizeMode(profile.tools?.mode, "default"),
      toolsAllow: normalizeAllow(profile.tools?.allow),
    };
  }

  private _isCronExecutionEnabled(): boolean {
    return asAgentConfig(this.config).tools?.cron?.allow_command === true;
  }

  private _configuredWorkspaceDir(): string {
    const configured = asAgentConfig(this.config).agents?.defaults?.workspace;
    if (typeof configured === "string" && configured.trim()) {
      return path.resolve(configured.trim());
    }
    return this.runtimePaths.sourceDir ?? this.configDir;
  }

  private _syncWorkspaceDir(): void {
    this.tools.setWorkspaceDir(this._configuredWorkspaceDir());
    this._legacyWorkspaceDir = this.tools.workspaceDir;
  }

  private _maxParallelToolCalls(): number {
    return resolveParallelToolCallLimit(
      this.concurrencyConfig.maxParallelToolCalls,
      this.concurrencyConfig.maxConcurrentTasks ?? 3,
    );
  }

  private _memoryContextMaxChars(): number {
    const configured = asAgentConfig(this.config).memory?.max_context_chars;
    return this._boundedInt(configured, 4_000, 1_000, 20_000);
  }

  private _resourceConfig(): ResolvedAgentResourceConfig {
    const raw: AgentResourceConfig =
      asAgentConfig(this.config).agent?.resource || {};
    const mode =
      raw.mode === "eco" || raw.mode === "performance" ? raw.mode : "balanced";
    const profile = RESOURCE_PROFILES[mode];
    const defaults = asAgentConfig(this.config).agents?.defaults || {};
    const configuredContextWindow = defaults.context_window;
    const contextWindow =
      typeof configuredContextWindow === "number" &&
      Number.isFinite(configuredContextWindow) &&
      configuredContextWindow > 0
        ? this._boundedInt(configuredContextWindow, 0, 1_024, 1_000_000)
        : undefined;
    const maxContextChars = contextWindow
      ? this._boundedInt(
          contextWindow * 4,
          profile.maxContextChars,
          8_000,
          200_000,
        )
      : this._boundedInt(
          raw.max_context_chars,
          profile.maxContextChars,
          8_000,
          200_000,
        );

    return {
      mode,
      messageHistoryLimit: this._boundedInt(
        raw.message_history_limit,
        profile.messageHistoryLimit,
        1,
        50,
      ),
      webSearchMaxCallsPerTurn: this._boundedInt(
        raw.web_search_max_calls_per_turn,
        profile.webSearchMaxCallsPerTurn,
        1,
        5,
      ),
      maxContextChars,
      contextWindowTokens: contextWindow,
      summarizeMessageThreshold: this._boundedInt(
        defaults.summarize_message_threshold,
        20,
        4,
        200,
      ),
      summarizeTokenPercent: this._boundedInt(
        defaults.summarize_token_percent,
        75,
        50,
        95,
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
    this._syncWorkspaceDir();
    fs.mkdirSync(runtimePaths.dataDir, { recursive: true });
    this.platformConnectionStore = new SqlitePlatformConnectionStore(
      path.join(runtimePaths.dataDir, "platform-connections.db"),
      createWorkspaceSecretVault(runtimePaths.dataDir),
    );
    this.tools.setPlatformConnectionStore(this.platformConnectionStore);

    const siConfig = asAgentConfig(this.config).self_improvement || {};
    const siDb = new Database(":memory:");
    // Keep scheduler state separate from self-improvement state and persist it
    // under the runtime data directory so Automation Center schedules survive
    // gateway/core restarts and can be recovered by TaskScheduler.start().
    fs.mkdirSync(runtimePaths.dataDir, { recursive: true });
    const schedulerDb = new Database(
      path.join(runtimePaths.dataDir, "scheduled-tasks.db"),
    );
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

    // Initialize the temporal memory system. The DB lives alongside other
    // agent runtime files. initMemory() is idempotent - safe across restarts.
    const dataDir = path.resolve(
      path.join(runtimePaths.configDir, "..", "data"),
    );
    try {
      initMemory(dataDir);
    } catch (memErr) {
      // Memory init failure must never prevent the agent from starting.
      console.error(
        "[Agent] Memory bridge init failed (continuing without memory):",
        (memErr as Error).message,
      );
    }

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
      new SqliteScheduledTaskStore(schedulerDb),
    );
    this.automationManager = createAutomationRuntime(
      path.join(runtimePaths.dataDir, "automations.db"),
      path.join(runtimePaths.dataDir, "agent-runs.db"),
      this,
    );

    this._bgStarted = false;
    this._messageHistory = new Map<string, ChatMessage[]>();
    this._sessionHistoryStore = new SqliteSessionHistoryStore(
      path.join(runtimePaths.dataDir, "session-history.db"),
    );
    for (const [sessionId, persisted] of this._sessionHistoryStore.load()) {
      this._messageHistory.set(sessionId, persisted.messages);
      this._sessionMetadata.set(sessionId, persisted.metadata);
    }
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
  private _sessionHistoryStore: SqliteSessionHistoryStore;
  private _sessionMetadata = new Map<
    string,
    { created: string; updated: string; title?: string; pinned?: boolean }
  >();
  private _taskDb: Database.Database;
  private skillLoader: SkillLoader;
  private automationManager: AutomationManager;

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

    // Start the background scheduler for all persisted scheduled work.
    // Automation Center schedules are explicit, authenticated application
    // tasks and must not depend on the command-cron permission gate, which is
    // reserved for the cron tool's command execution capability.
    this._startTaskScheduler();

    return Promise.all(tasks).then(() => {});
  }

  private async _loadSkillsAsync(): Promise<void> {
    try {
      const skills = await this.skillLoader.loadAll();
      for (const skill of skills) {
        if (!skill.index || skill.index.endsWith(".md")) {
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
    this._syncWorkspaceDir();
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
      // Keep persisted Automation Center schedules alive across config reloads.
      // The command-cron permission gate does not control these application
      // schedules.
      this.taskScheduler.start();
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
      if (!validation.ok) {
        console.warn(
          "[Agent] Invalid config rejected; using built-in safe defaults:",
          validation.errors
            .map((item) => `${item.path}: ${item.message}`)
            .join("; "),
        );
        return validateRuntimeConfig(defaultConfig).value ?? defaultConfig;
      }
      if (validation.warnings.length > 0) {
        console.warn(
          "[Agent] Config warnings:",
          validation.warnings
            .map((item) => `${item.path}: ${item.message}`)
            .join("; "),
        );
      }
      return validation.value ?? loaded;
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
      // ToolDefinition carries local-only metadata (for example `risk`) that
      // must not be sent to OpenAI-compatible providers. Google Gemini's
      // OpenAI-compatible endpoint rejects unknown fields on tool objects with
      // a generic 400, which previously surfaced as a misleading credential
      // error in the UI. Project only the provider-facing fields here while
      // retaining the original definitions for local tool execution.
      options.tools = toolsSchema.map((tool) => {
        const candidate = tool as unknown as {
          name?: string;
          description?: string;
          parameters?: Record<string, unknown>;
          function?: {
            name?: string;
            description?: string;
            parameters?: Record<string, unknown>;
          };
        };
        const fn = candidate.function ?? candidate;
        return {
          type: "function",
          function: {
            name: fn.name ?? "",
            description: fn.description,
            parameters: fn.parameters ?? { type: "object", properties: {} },
          },
        };
      });
      options.tool_choice = "auto";
    }
    if (
      typeof runtimeOptions.maxTokens === "number" &&
      Number.isFinite(runtimeOptions.maxTokens) &&
      runtimeOptions.maxTokens > 0
    ) {
      options.max_tokens = Math.floor(runtimeOptions.maxTokens);
    }
    const processedMessages = messages.map(
      ({ id: _id, created_at: _createdAt, ...message }) => message,
    );

    try {
      const response = await globalExecutionTracer.spanAsync(
        "agent.llm_call",
        () => achatCompletion(processedMessages as never, options),
        metricTags,
      );
      globalMetricsCollector.recordLatency(
        "llm_call",
        Date.now() - startedAt,
        metricTags,
      );

      return response;
    } catch (err) {
      globalMetricsCollector.recordError("llm_call", metricTags);
      throw err;
    }
  }

  /**
   * Return generated-token consumption for the current agent cycle.
   *
   * `max_tokens_per_cycle` limits output work across the tool loop. Prompt
   * tokens are intentionally excluded here: they are re-estimated on every
   * request by buildAgentTokenBudget() for context-window safety. Counting the
   * ever-growing prompt again as cycle spend caused a tool call to consume the
   * whole budget before the model received its final-report turn.
   */
  private _checkBudget(usage: LLMResponse | null): number {
    if (!usage?.usage) return 0;
    return Math.max(0, Math.floor(Number(usage.usage.completion_tokens || 0)));
  }

  public listSessionIds(): string[] {
    return [
      ...new Set([
        ...this._messageHistory.keys(),
        ...this._sessionMetadata.keys(),
      ]),
    ];
  }

  private _ensureSessionMessageIds(sessionId: string): ChatMessage[] | null {
    const history = this._messageHistory.get(sessionId);
    if (!history) return null;
    let changed = false;
    for (const message of history) {
      if (!message.id) {
        message.id = crypto.randomUUID();
        changed = true;
      }
      if (!message.created_at) {
        message.created_at = new Date().toISOString();
        changed = true;
      }
    }
    if (changed) this._messageHistory.set(sessionId, history);
    return history;
  }

  public getSessionMessages(sessionId: string): ChatMessage[] | null {
    const history = this._ensureSessionMessageIds(sessionId);
    return history ? history.map((message) => ({ ...message })) : null;
  }

  public updateSessionMessage(
    sessionId: string,
    messageId: string,
    patch: { content?: string; image_urls?: string[] },
  ): ChatMessage | null {
    const history = this._ensureSessionMessageIds(sessionId);
    const message = history?.find((item) => item.id === messageId);
    if (!message) return null;
    if (patch.content !== undefined) message.content = patch.content;
    if (patch.image_urls !== undefined)
      message.image_urls = [...patch.image_urls];
    this._touchSession(sessionId);
    return { ...message };
  }

  public deleteSessionMessage(sessionId: string, messageId: string): boolean {
    const history = this._ensureSessionMessageIds(sessionId);
    if (!history) return false;
    const index = history.findIndex((item) => item.id === messageId);
    if (index < 0) return false;
    history.splice(index, 1);
    this._messageHistory.set(sessionId, history);
    this._touchSession(sessionId);
    return true;
  }

  public forkSessionAtMessage(
    sessionId: string,
    messageId: string,
  ): { sessionId: string; messages: ChatMessage[] } | null {
    const history = this._ensureSessionMessageIds(sessionId);
    if (!history) return null;
    const index = history.findIndex((item) => item.id === messageId);
    if (index < 0) return null;
    const newSessionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const messages = history.slice(0, index + 1).map((message) => ({
      ...message,
      id: crypto.randomUUID(),
      created_at: message.created_at || now,
    }));
    this._messageHistory.set(newSessionId, messages);
    this._sessionMetadata.set(newSessionId, {
      created: now,
      updated: now,
      title: `Fork of ${sessionId}`,
    });
    this._persistSession(newSessionId);
    return {
      sessionId: newSessionId,
      messages: messages.map((message) => ({ ...message })),
    };
  }

  public retrySessionFromMessage(
    sessionId: string,
    messageId: string,
  ): { sessionId: string; message: ChatMessage } | null {
    const history = this._ensureSessionMessageIds(sessionId);
    if (!history) return null;
    const targetIndex = history.findIndex((item) => item.id === messageId);
    if (targetIndex < 0) return null;
    let userIndex = targetIndex;
    while (userIndex >= 0 && history[userIndex]?.role !== "user")
      userIndex -= 1;
    if (userIndex < 0) return null;
    const original = history[userIndex];
    if (!original) return null;
    const now = new Date().toISOString();
    const newSessionId = crypto.randomUUID();
    const prefix = history.slice(0, userIndex).map((message) => ({
      ...message,
      id: crypto.randomUUID(),
      created_at: message.created_at || now,
    }));
    this._messageHistory.set(newSessionId, prefix);
    this._sessionMetadata.set(newSessionId, {
      created: now,
      updated: now,
      title: `Retry of ${sessionId}`,
    });
    this._persistSession(newSessionId);
    return {
      sessionId: newSessionId,
      message: { ...original, id: crypto.randomUUID() },
    };
  }

  public getSessionMetadata(sessionId: string): {
    created: string;
    updated: string;
    title?: string;
    pinned?: boolean;
  } | null {
    const metadata = this._sessionMetadata.get(sessionId);
    return metadata ? { ...metadata } : null;
  }

  public updateSessionMetadata(
    sessionId: string,
    patch: { title?: string; pinned?: boolean },
  ): {
    created: string;
    updated: string;
    title?: string;
    pinned?: boolean;
  } | null {
    if (
      !this._messageHistory.has(sessionId) &&
      !this._sessionMetadata.has(sessionId)
    ) {
      return null;
    }
    const now = new Date().toISOString();
    const existing = this._sessionMetadata.get(sessionId) ?? {
      created: now,
      updated: now,
    };
    const next = {
      ...existing,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
      updated: now,
    };
    this._sessionMetadata.set(sessionId, next);
    this._persistSession(sessionId);
    return { ...next };
  }

  public deleteSession(sessionId: string): boolean {
    const hadSession =
      this._messageHistory.has(sessionId) ||
      this._sessionMetadata.has(sessionId);
    this._messageHistory.delete(sessionId);
    this._sessionMetadata.delete(sessionId);
    this._sessionHistoryStore.delete(sessionId);
    return hadSession;
  }

  private _persistSession(sessionId: string): void {
    const history = this._ensureSessionMessageIds(sessionId);
    if (!history) return;
    const now = new Date().toISOString();
    const existing = this._sessionMetadata.get(sessionId);
    const metadata: SessionMetadata = {
      created: existing?.created || history[0]?.created_at || now,
      updated: existing?.updated || now,
      ...(existing?.title ? { title: existing.title } : {}),
      ...(existing?.pinned === true ? { pinned: true } : {}),
    };
    this._sessionMetadata.set(sessionId, metadata);
    this._sessionHistoryStore.save(sessionId, history, metadata);
  }

  public close(): void {
    this._sessionHistoryStore.close();
  }

  private _touchSession(sessionId: string): void {
    const now = new Date().toISOString();
    const existing = this._sessionMetadata.get(sessionId);
    this._sessionMetadata.set(sessionId, {
      ...existing,
      created: existing?.created || now,
      updated: now,
    });
    this._persistSession(sessionId);
  }

  private _saveAssistantHistoryMessage(
    sessionId: string,
    content: string,
    messageId?: string,
  ): void {
    if (!content.trim()) return;
    const history = this._messageHistory.get(sessionId) || [];
    history.push({
      id: messageId || crypto.randomUUID(),
      created_at: new Date().toISOString(),
      role: "assistant",
      content,
    });
    this._messageHistory.set(sessionId, history);
    this._touchSession(sessionId);
  }

  /**
   * Write the completed turn (user message + final agent response) into
   * long-term memory (backend only, not shown in UI). Called once per
   * `runAgentLoop()` invocation, right before each exit point that produced
   * a real (non-empty) final response.
   *
   * This is intentionally defensive: memory may not be initialized yet
   * (`getMemory()` returns null before `initMemory()` has run), and a
   * failure here must never surface to or break the user-facing agent
   * turn — the turn has already completed by the time this runs.
   */
  private _logMemoryInteraction(
    sessionId: string,
    userMessage: string,
    agentResponse: string,
  ): void {
    if (!agentResponse.trim()) return;
    const memory = getMemory();
    if (!memory) return;
    try {
      memory.logInteraction(userMessage, agentResponse, { sessionId });
    } catch (memErr) {
      console.error("[Agent] Memory write failed:", (memErr as Error).message);
    }
  }

  /**
   * Write a resolved tool call into long-term memory (the `skill` category
   * — see _classifyMemoryCategory in the memory package, which files any
   * event with source: 'tool' there regardless of content). Called once
   * per tool invocation, from both the normal resolution path
   * (_executeToolInvocation) and the exceptional path where a tool never
   * got to run at all (lock acquisition failure, unexpected throw in
   * _executePlannedToolInvocation's catch block) — a tool that failed to
   * even start is still something the agent attempted and should still
   * leave a trace.
   *
   * Same defensive contract as _logMemoryInteraction: memory may not be
   * initialized, and a failure here must never surface to or break the
   * user-facing tool call, which has already resolved by the time this runs.
   */
  private _logMemoryCapabilityPlan(
    sessionId: string,
    report: PlanCapabilityReport,
  ): void {
    const memory = getMemory();
    if (!memory) return;
    try {
      const compactRecord = {
        type: "capability_plan",
        schemaVersion: report.schemaVersion,
        taskClass: report.taskClass,
        onlineResearchRecommended: report.onlineResearchRecommended,
        requirements: report.requirements.map((item) => ({
          id: item.id,
          kind: item.kind,
          status: item.status,
          matchedIds: item.matchedIds,
          approvalRequired: item.approvalRequired,
        })),
      };
      memory.tkg.writeEvent({
        content: JSON.stringify(compactRecord),
        source: "system",
        event_type: "capability_plan",
        importance: 0.25,
        metadata: { sessionId, capabilityPlan: true },
        skipNoiseFilter: true,
      });
    } catch (memErr) {
      console.error(
        "[Agent] Capability plan memory write failed:",
        (memErr as Error).message,
      );
    }
  }

  private _logMemoryToolCall(
    sessionId: string,
    toolName: string,
    toolArgs: unknown,
    result: unknown,
    ok: boolean,
  ): void {
    const memory = getMemory();
    if (!memory) return;
    try {
      memory.logToolCall(toolName, toolArgs, result, { sessionId, ok });
    } catch (memErr) {
      console.error(
        "[Agent] Memory tool-call write failed:",
        (memErr as Error).message,
      );
    }
  }

  async *runAgentLoop(
    sessionId: string,
    userMessage: string,
    screenshotImagePath?: string,
    options: {
      signal?: AbortSignal;
      feedbackProvider?: () => string[];
      /** Provider-accessible image URLs or data URLs attached to this turn. */
      imageUrls?: string[];
      /** Stable ID of the user message supplied by the WebSocket client. */
      messageId?: string;
      /** Safe voice transcription provenance; raw audio is never part of history. */
      voice?: VoiceMessageMetadata;
      /** Ephemeral audio for a cloud model that explicitly accepts audio input. */
      audio?: { data: Buffer; mimeType: string; filename?: string };
      /** Stable ID used for the completed assistant response. */
      responseMessageId?: string;
      completionGuard?: () => {
        ok: boolean;
        missing?: string[];
        invalid?: string[];
      };
      maxCompletionRepairs?: number;
    } = {},
  ): AsyncGenerator<string, void, unknown> {
    if (this.heartbeat) this.heartbeat.markUserInteraction();

    {
      const history = this._messageHistory.get(sessionId) || [];
      history.push({
        id: options.messageId || crypto.randomUUID(),
        created_at: new Date().toISOString(),
        role: "user",
        content: userMessage,
        ...(options.voice ? { voice: options.voice } : {}),
      });
      this._messageHistory.set(sessionId, history);
      this._touchSession(sessionId);
    }
    this._loopCounter = (this._loopCounter + 1) >>> 0;
    const loopId = this._loopCounter;

    // BUG FIX: Track spent budget tokens for this loop
    let spentBudgetTokens = 0;
    const configuredMaxTokensPerCycle =
      asAgentConfig(this.config).agent?.max_tokens_per_cycle ||
      settings.defaultMaxTokens;
    const resource = this._resourceConfig();
    const configuredMaxToolIterations = asAgentConfig(this.config).agents
      ?.defaults?.max_tool_iterations;
    const maxAgentTurns = this._boundedInt(
      configuredMaxToolIterations,
      MAX_AGENT_TURNS,
      1,
      200,
    );
    const localModel = isLocalModelName(this.modelName);
    const runDeadline =
      Date.now() +
      (localModel ? LOCAL_AGENT_RUN_TIMEOUT_MS : REMOTE_AGENT_RUN_TIMEOUT_MS);

    const history = this._messageHistory.get(sessionId) || [];
    const turnProfile = this._turnProfilePolicy();
    const pastMessages =
      turnProfile.historyMode === "off"
        ? []
        : history.slice(-resource.messageHistoryLimit);

    // Decide the specialist and per-turn capability budget before prompting.
    // The selected catalog is also used as an execution allowlist below.
    const taskProfile = classifyAgentTask(userMessage);
    const routeDecision = routeAgentTask(userMessage, this.config, taskProfile);
    const allTools = this.tools.getToolDefinitions();
    const adaptiveSelection = selectAdaptiveCapabilities(
      userMessage,
      allTools,
      routeDecision,
      taskProfile,
    );
    const systemContent = await this._buildSystemContent(
      userMessage,
      screenshotImagePath,
      resource,
      adaptiveSelection,
      sessionId,
      turnProfile,
    );

    // Warm up only the selected tools for faster and more accurate selection.
    const adaptiveTools = adaptiveSelection.selectedTools;
    const prunedTools =
      turnProfile.toolsMode === "off"
        ? []
        : turnProfile.toolsMode === "custom"
          ? adaptiveTools.filter((tool) =>
              turnProfile.toolsAllow.has(
                String(tool.function?.name || "").trim(),
              ),
            )
          : adaptiveTools;

    // Keep the per-turn tool surface bounded. The adaptive selector always
    // supplies a small read-only recovery set when heuristics are uncertain;
    // falling back to all registered tools here would add the full catalog to
    // every ordinary prompt and defeat adaptive pruning.
    const toolsSchema = prunedTools as unknown as ToolDefinition[];

    const deterministicIntent = detectDeterministicIntent(userMessage);
    if (deterministicIntent && turnProfile.toolsMode !== "off") {
      const requiredToolNames =
        deterministicIntent.kind === "web_search"
          ? ["web_search"]
          : (deterministicIntent.files || []).flatMap(() => [
              "file_write",
              "file_read",
            ]);
      const uniqueRequiredToolNames = [...new Set(requiredToolNames)];
      const allowedToolNames = new Set([
        ...toolsSchema.map((tool) => tool.function.name),
        ...uniqueRequiredToolNames,
      ]);
      const syntheticCalls: RawAgentToolCall[] =
        deterministicIntent.kind === "web_search"
          ? [
              {
                id: crypto.randomUUID(),
                function: {
                  name: "web_search",
                  arguments: JSON.stringify({
                    query: deterministicIntent.query || userMessage,
                    max_results: 5,
                    mode: /\b(cloud|api)\b/i.test(userMessage)
                      ? "cloud"
                      : /\bauto\b/i.test(userMessage)
                        ? "auto"
                        : "local",
                  }),
                },
              },
            ]
          : (deterministicIntent.files || []).flatMap((file) => [
              {
                id: crypto.randomUUID(),
                function: {
                  name: "file_write",
                  arguments: JSON.stringify({
                    path: file.path,
                    content: file.content,
                  }),
                },
              },
              {
                id: crypto.randomUUID(),
                function: {
                  name: "file_read",
                  arguments: JSON.stringify({ path: file.path }),
                },
              },
            ]);
      const deterministicMessages: ChatMessage[] = [];
      const toolMessagesBefore = deterministicMessages.length;
      for await (const event of this._executeToolCallsAndYield(
        sessionId,
        userMessage,
        syntheticCalls,
        deterministicMessages,
        0,
        options.signal,
        allowedToolNames,
      )) {
        yield event;
      }
      const deterministicToolMessages = deterministicMessages
        .slice(toolMessagesBefore)
        .filter((message) => message.role === "tool");
      const deterministicResponse =
        deterministicIntent.kind === "web_search"
          ? buildDeterministicSearchResponse(
              deterministicToolMessages[0]?.content || "",
            )
          : buildDeterministicFileResponse(
              deterministicIntent.files || [],
              deterministicToolMessages,
              this.tools.workspaceDir,
            );
      await this._saveAssistantHistoryMessage(
        sessionId,
        deterministicResponse,
        options.responseMessageId,
      );
      this._logMemoryInteraction(sessionId, userMessage, deterministicResponse);
      yield JSON.stringify({
        type: "stream_chunk",
        content: deterministicResponse,
        model_name: this.modelName,
      });
      yield JSON.stringify({
        type: "stream_done",
        usage: { tokens: 0 },
        agent_loop_id: loopId,
        model_name: this.modelName,
      });
      return;
    }

    // Pre-warm the most likely tools
    if (resource.toolWarmupEnabled) {
      globalToolWarmer.warmUp(
        prunedTools.map((t) => t.function.name),
        { query: userMessage },
      );
    }

    let llmMessages: ChatMessage[] =
      turnProfile.systemPromptMode === "off"
        ? []
        : [{ role: "system", content: systemContent }];

    for (const msg of pastMessages) {
      llmMessages.push({
        role: msg.role as "system" | "user" | "assistant" | "tool",
        content: msg.content,
        ...(msg.image_urls ? { image_urls: msg.image_urls } : {}),
      });
    }
    const imageUrls = (options.imageUrls ?? [])
      .filter(
        (url): url is string =>
          typeof url === "string" && url.trim().length > 0,
      )
      .slice(0, 4);
    const lastUserMessage = [...llmMessages]
      .reverse()
      .find((message) => message.role === "user");
    if (imageUrls.length > 0 && lastUserMessage) {
      lastUserMessage.image_urls = imageUrls;
    }
    if (options.audio && lastUserMessage) {
      const audio: MikiProviderAudio = {
        data: options.audio.data.toString("base64"),
        mimeType: options.audio.mimeType,
        ...(options.audio.filename ? { filename: options.audio.filename } : {}),
      };
      (lastUserMessage as ChatMessage & { audio: MikiProviderAudio }).audio =
        audio;
    }

    llmMessages = AgentOrchestrator._compactMessagesIfNeeded(
      llmMessages,
      resource,
    );
    llmMessages = AgentOrchestrator._truncateMessagesToFit(
      llmMessages,
      resource.maxContextChars,
    );

    let consecutiveToolOnly = 0;
    let turn = 0;
    let completionRepairAttempts = 0;
    let webSearchCallsUsed = 0;
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

    while (turn < maxAgentTurns) {
      if (options.signal?.aborted) {
        yield JSON.stringify({
          type: "error",
          content: "Task cancelled",
        });
        return;
      }

      turn++;
      if (Date.now() >= runDeadline) {
        const timeoutMessage =
          "\n\nThe run reached its safe time limit before it could finish.";
        await this._saveAssistantHistoryMessage(
          sessionId,
          timeoutMessage,
          options.responseMessageId,
        );
        yield JSON.stringify({
          type: "execution_timeout",
          model_name: this.modelName,
          turn,
        });
        yield JSON.stringify({
          type: "stream_chunk",
          content: timeoutMessage,
          model_name: this.modelName,
        });
        yield streamDoneEvent(spentBudgetTokens);
        return;
      }
      const liveFeedback = options.feedbackProvider?.() ?? [];
      if (liveFeedback.length > 0) {
        const feedbackText = liveFeedback
          .map((item) => item.trim())
          .filter(Boolean)
          .join("\n");
        if (feedbackText) {
          llmMessages.push({
            role: "user",
            content: `Live feedback from the user at a safe checkpoint:\n${feedbackText}\nApply it to the current task if it is relevant. Do not restart completed work.`,
          });
          yield JSON.stringify({
            type: "feedback_applied",
            content: "Live feedback was added at a safe checkpoint.",
            count: liveFeedback.length,
          });
        }
      }
      try {
        llmMessages = AgentOrchestrator._compactMessagesIfNeeded(
          llmMessages,
          resource,
        );
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
          contextWindowTokens: resource.contextWindowTokens,
          summarizeTokenPercent: resource.summarizeTokenPercent,
        });
        latestContextUsage = requestBudget.contextUsage;

        if (!requestBudget.shouldCall) {
          const exhaustedMessage =
            "\n\n[Token or context budget exhausted. Stopping.]";
          await this._saveAssistantHistoryMessage(
            sessionId,
            exhaustedMessage,
            options.responseMessageId,
          );
          this._logMemoryInteraction(sessionId, userMessage, exhaustedMessage);
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
        response = await withTimeout(
          globalRequestDeduplicator.execute(requestKey, () =>
            this._callLlmApi(llmMessages, toolsSchema, {
              maxTokens: requestBudget.maxTokens,
            }),
          ),
          localModel ? LOCAL_LLM_CALL_TIMEOUT_MS : REMOTE_LLM_CALL_TIMEOUT_MS,
          localModel ? "Local llama.cpp request" : "Remote provider request",
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
        const rawMessage = err instanceof Error ? err.message : String(err);
        const isCredentialOrRateLimitError =
          err instanceof LiteLLMMissingCredentialError ||
          err instanceof LiteLLMRateLimitError ||
          err instanceof LLMMissingCredentialError ||
          err instanceof LLMRateLimitError;
        const providerError = err instanceof LLMProviderError ? err : null;
        const providerLabel = providerError?.providerId || "selected AI";
        const errorMessage = providerError
          ? providerError.status === 429 ||
            providerError instanceof LLMRateLimitError ||
            providerError instanceof LiteLLMRateLimitError
            ? "\n\nThe service is temporarily busy or rate-limited. Please try again shortly."
            : providerError instanceof LLMEntitlementError
              ? `\n\nThe ${providerLabel} account is not entitled to use this model. Add the required payment method, credits, or subscription, then retry.`
              : providerError.status === 401 ||
                  providerError.status === 403 ||
                  providerError instanceof LLMMissingCredentialError ||
                  providerError instanceof LiteLLMMissingCredentialError
                ? `\n\nThe ${providerLabel} credential was missing or rejected. Add a valid API key in Models/Credentials, then retry.`
                : providerError instanceof LLMTimeoutError ||
                    providerError.message.toLowerCase().includes("timed out")
                  ? `\n\nThe ${providerLabel} request timed out. Check the provider connection and try again.`
                  : providerError.status && providerError.status >= 500
                    ? `\n\nThe ${providerLabel} service is temporarily unavailable. Please try again shortly.`
                    : `\n\n${providerError.message || "The selected AI service returned an error."} The run was stopped safely.`
          : `\n\n${isCredentialOrRateLimitError ? rawMessage : `Error calling LLM: ${rawMessage}`}`;
        await this._saveAssistantHistoryMessage(
          sessionId,
          errorMessage,
          options.responseMessageId,
        );
        if (providerError?.diagnostic) {
          yield JSON.stringify({
            type: "provider_error",
            provider: providerError.providerId,
            status: providerError.status,
            retryable: providerError.retryable,
            diagnostic: providerError.diagnostic,
          });
        }
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
          history.push({
            id: options.responseMessageId || crypto.randomUUID(),
            created_at: new Date().toISOString(),
            role: "assistant",
            content,
          });
          this._messageHistory.set(sessionId, history);
          this._touchSession(sessionId);
        }
        consecutiveToolOnly = 0;

        if (this._isTaskComplete(content)) {
          const completionGuard = options.completionGuard?.();
          const maxCompletionRepairs = Math.max(
            0,
            Math.floor(options.maxCompletionRepairs ?? 2),
          );
          if (
            completionGuard &&
            !completionGuard.ok &&
            completionRepairAttempts < maxCompletionRepairs
          ) {
            completionRepairAttempts += 1;
            const missing = [
              ...(completionGuard.missing ?? []),
              ...(completionGuard.invalid ?? []),
            ].filter(Boolean);
            const repairInstruction =
              `Completion verification found missing or empty required artifacts: ${missing.join(", ") || "the required files"}. ` +
              "Continue the same task now. Use the available file tools to create or repair every required artifact, then verify each one exists and is non-empty. Do not provide a final completion reply until the verification passes.";
            llmMessages.push({ role: "user", content: repairInstruction });
            yield JSON.stringify({
              type: "completion_guard_failed",
              content: repairInstruction,
              missing,
              attempt: completionRepairAttempts,
            });
            continue;
          }
          this._logMemoryInteraction(sessionId, userMessage, content);
          yield streamDoneEvent(AgentOrchestrator._extractUsage(response));
          return;
        }
      }

      const toolCalls = msg?.tool_calls as
        | Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
            extra_content?: Record<string, unknown>;
          }>
        | undefined;

      if (toolCalls && toolCalls.length > 0) {
        const requestedWebSearchCalls = toolCalls.filter(
          (toolCall) => toolCall.function?.name === "web_search",
        ).length;
        if (
          requestedWebSearchCalls > 0 &&
          webSearchCallsUsed >= resource.webSearchMaxCallsPerTurn
        ) {
          const fallbackContent =
            buildToolOnlyFallbackResponse(llmMessages) ||
            `I reached the web-search safety limit (${resource.webSearchMaxCallsPerTurn} call${resource.webSearchMaxCallsPerTurn === 1 ? "" : "s"}) for this turn before a final synthesis was returned. Please ask me to continue the research in a new turn.`;
          this._saveAssistantHistoryMessage(
            sessionId,
            fallbackContent,
            options.responseMessageId,
          );
          this._logMemoryInteraction(sessionId, userMessage, fallbackContent);
          yield JSON.stringify({
            type: "stream_chunk",
            content: fallbackContent,
            model_name: this.modelName,
            ...(latestContextUsage
              ? { context_usage: latestContextUsage }
              : {}),
          });
          yield streamDoneEvent(AgentOrchestrator._extractUsage(response));
          return;
        }
        webSearchCallsUsed += requestedWebSearchCalls;
        if (!content) consecutiveToolOnly++;

        if (consecutiveToolOnly >= MAX_AGENT_TURNS_NO_OUTPUT) {
          const warnMsg =
            "Agent exceeded max consecutive tool-call turns without a text response.";
          const warningMessage = `\n\n${warnMsg}`;
          await this._saveAssistantHistoryMessage(
            sessionId,
            warningMessage,
            options.responseMessageId,
          );
          this._logMemoryInteraction(sessionId, userMessage, warningMessage);
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

        const assistantExtraContent =
          msg && typeof msg === "object" && "extra_content" in msg
            ? (msg as unknown as { extra_content?: unknown }).extra_content
            : undefined;
        const assistantMsg = AgentOrchestrator._buildAssistantMessage(
          content || "",
          toolCalls,
          assistantExtraContent,
        );
        llmMessages.push(assistantMsg);

        for await (const event of this._executeToolCallsAndYield(
          sessionId,
          userMessage,
          toolCalls,
          llmMessages,
          turn,
          options.signal,
          new Set(toolsSchema.map((tool) => tool.function.name)),
        )) {
          yield event;
        }
        continue;
      }

      const completionGuard = options.completionGuard?.();
      const maxCompletionRepairs = Math.max(
        0,
        Math.floor(options.maxCompletionRepairs ?? 2),
      );
      if (
        completionGuard &&
        !completionGuard.ok &&
        completionRepairAttempts < maxCompletionRepairs
      ) {
        completionRepairAttempts += 1;
        const missing = [
          ...(completionGuard.missing ?? []),
          ...(completionGuard.invalid ?? []),
        ].filter(Boolean);
        const repairInstruction =
          `The task is not complete yet: required artifacts are missing or empty (${missing.join(", ") || "the required files"}). ` +
          "Continue the same task now. Use the available file tools to create or repair every required artifact, then verify each one exists and is non-empty. Do not stop with a status message; perform the repair before replying.";
        llmMessages.push({ role: "user", content: repairInstruction });
        yield JSON.stringify({
          type: "completion_guard_failed",
          content: repairInstruction,
          missing,
          attempt: completionRepairAttempts,
        });
        continue;
      }

      break;
    }

    let finalContent = response?.choices?.[0]?.message?.content || "";
    if (!finalContent.trim()) {
      const fallbackContent = buildToolOnlyFallbackResponse(llmMessages);
      if (fallbackContent) {
        finalContent = fallbackContent;
        this._saveAssistantHistoryMessage(
          sessionId,
          fallbackContent,
          options.responseMessageId,
        );
        yield JSON.stringify({
          type: "stream_chunk",
          content: fallbackContent,
          model_name: this.modelName,
          ...(latestContextUsage ? { context_usage: latestContextUsage } : {}),
        });
      }
    }
    this._logMemoryInteraction(sessionId, userMessage, finalContent);
    yield streamDoneEvent(AgentOrchestrator._extractUsage(response));
  }

  private async *_executeToolCallsAndYield(
    sessionId: string,
    userMessage: string,
    toolCalls: RawAgentToolCall[],
    llmMessages: ChatMessage[],
    turn: number,
    signal?: AbortSignal,
    allowedToolNames: Set<string> | null = null,
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

    const invocationLevel = new Map<number, number>();
    plan.levels.forEach((level, levelIndex) => {
      for (const item of level.items) {
        invocationLevel.set(item.index, levelIndex);
      }
    });

    for (let index = 0; index < invocations.length; index++) {
      const invocation = invocations[index];
      const level = invocationLevel.get(index) ?? 0;
      yield JSON.stringify({
        type: "tool_call",
        tool: invocation.toolName,
        input: invocation.toolArgs,
        invocation_index: index,
        level,
        parallel: (plan.levels[level]?.items.length ?? 1) > 1,
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
        return this._executePlannedToolInvocation(
          sessionId,
          planned,
          signal,
          allowedToolNames,
        );
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
    const automationMessage = parseAutomationMessage(userMessage);
    const automationExecutionId = automationMessage
      ? this.automationManager.prepareExecution(automationMessage.executionId)
      : undefined;
    const effectiveUserMessage = automationMessage?.prompt ?? userMessage;
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
    this._annotateTaskRoute(task, effectiveUserMessage);
    if (automationExecutionId) {
      this.automationManager.onExecutionStarted(automationExecutionId);
    }

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
          effectiveUserMessage,
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
      if (automationExecutionId) {
        this.automationManager.onExecutionCompleted(automationExecutionId);
      }

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
      console.error(
        `[Agent] Task ${task.id} failed:`,
        err instanceof Error ? err.stack || err.message : err,
      );
      this.taskQueue.fail(task.id, errorMessage);
      if (automationExecutionId) {
        this.automationManager.onExecutionFailed(
          automationExecutionId,
          errorMessage,
        );
      }

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

  getAutomationManager(): AutomationManager {
    return this.automationManager;
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
    adaptiveSelection?: AdaptiveCapabilitySelection,
    sessionId?: string,
    turnProfile = this._turnProfilePolicy(),
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
    const adaptiveBlock = adaptiveSelection
      ? `\n${formatAdaptiveCapabilitySelection(adaptiveSelection)}\n`
      : "";
    const capabilityReport = analyzePlanCapabilities(
      userMessage,
      {
        skills:
          turnProfile.skillsMode === "off"
            ? []
            : (await this.skillLoader.getAllSkillsMetadata()).filter(
                (skill) => {
                  if (turnProfile.skillsMode !== "custom") return true;
                  const id = String(skill.id || skill.name || "").trim();
                  return turnProfile.skillsAllow.has(id);
                },
              ),
        tools:
          turnProfile.toolsMode === "off"
            ? []
            : turnProfile.toolsMode === "custom"
              ? this.tools
                  .getToolDefinitions()
                  .filter((tool) =>
                    turnProfile.toolsAllow.has(
                      String(tool.function?.name || "").trim(),
                    ),
                  )
              : this.tools.getToolDefinitions(),
      },
      `${taskProfile.complexity}/${taskProfile.executionStyle}`,
    );
    const capabilityBlock = `\n${formatPlanCapabilityReport(capabilityReport)}\n`;
    if (sessionId) {
      this._logMemoryCapabilityPlan(sessionId, capabilityReport);
    }

    const systemIndexBlock = "";
    let screenshotBlock = "";
    let screenshotNote = "";
    if (screenshotImagePath && fs.existsSync(screenshotImagePath)) {
      screenshotBlock = "\n[SCREENSHOT ATTACHED]: ...\n";
      screenshotNote = "\n\nA screenshot image is attached for reference.";
    }

    const systemPersona: string = this.agentConfig.persona || "";
    const explicitTurnProfile = turnProfile.enabled;
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
    }

    // Active goals/plan must inject into every normal chat turn regardless
    // of turn_profile.enabled -- turn_profile only gates self-improvement
    // tuning notes above, it was never meant to gate goal awareness.
    // (Previously nested inside the turn_profile check, so an active plan
    // silently never reached the model unless Turn Profile was explicitly
    // turned on.)
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

    // --- Temporal Memory Context (backend only, not shown in UI) ---
    // Retrieve the agent's long-term memory context and prepend it to the
    // system prompt so the LLM has access to past events, active entities,
    // and recent conversation history across sessions. This runs on every
    // turn and is invisible to the user (it's in the system role message).
    let memoryContextBlock = "";
    const memory = getMemory();
    if (memory) {
      try {
        const memCtx = memory.getEnhancedSystemPrompt(
          typeof userMessage === "string" ? userMessage : "",
        );
        if (memCtx && memCtx.trim()) {
          const memoryText = memCtx.trim();
          const memoryLimit = this._memoryContextMaxChars();
          const boundedMemory =
            memoryText.length > memoryLimit
              ? `${memoryText.slice(0, memoryLimit)}\n[Memory context truncated for token efficiency.]`
              : memoryText;
          memoryContextBlock = `${boundedMemory}\n\n`;
        }
      } catch (memErr) {
        // Never let a memory read error break the agent turn.
        console.error(
          "[Agent] Memory context read failed:",
          (memErr as Error).message,
        );
      }
    }
    // --- End Temporal Memory Context ---

    return (
      `${memoryContextBlock}` +
      `${screenshotBlock}${turnProfile.systemPromptMode === "off" ? "" : systemPersona}` +
      `${taskProfileBlock}` +
      `${agentRouteBlock}` +
      `${accelerationBlock}` +
      `${decisionPatternBlock}` +
      `${adaptiveBlock}` +
      `${capabilityBlock}` +
      `${systemIndexBlock}` +
      `${dynamicStateBlock}` +
      `CONVERSATION STYLE:\n` +
      `The main chat is a live human conversation, not an execution log. Write like one person sending a normal message to another: natural, direct, warm when appropriate, and concise. Give the answer first in one or two short sentences; use at most one short paragraph unless the user explicitly asks for a detailed explanation, a report, code, or a step-by-step guide. Do not repeat the same status in multiple forms, restate the request, or narrate plans, routing, tools, files, checks, timestamps, token usage, or completion evidence in the visible reply. Do not put headings such as Plan, Status, Work, Verification, Report, or Summary in an ordinary reply. Put implementation details, reasoning summaries, tool activity, source-research notes, verification results, and long explanations into the Inspector-only runtime summaries emitted by the runtime. If the user asks for a detailed report, provide the requested report, but keep routine progress conversational. Never claim a task is complete without checking the result.\n\n` +
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
    allowedToolNames: Set<string> | null = null,
  ): Promise<BufferedToolExecution> {
    let release: (() => void) | null = null;
    let ok = false;

    try {
      const requestedTool = planned.invocation.toolName;
      if (allowedToolNames && !allowedToolNames.has(requestedTool)) {
        const failureOutput =
          `Tool '${requestedTool}' was not selected for this turn. ` +
          "Miki must re-route the request before using it.";
        this._logMemoryToolCall(
          sessionId,
          requestedTool,
          planned.invocation.toolArgs,
          failureOutput,
          false,
        );
        return this._buildToolFailureResult(
          planned.index,
          planned.invocation,
          failureOutput,
        );
      }

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
      const failureOutput = `Error executing tool ${planned.invocation.toolName}: ${errorMessage}`;
      this._logMemoryToolCall(
        sessionId,
        planned.invocation.toolName,
        planned.invocation.toolArgs,
        failureOutput,
        false,
      );
      return this._buildToolFailureResult(
        planned.index,
        planned.invocation,
        failureOutput,
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
          invocation_index: index,
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
        ok,
        duration_ms: Date.now() - startedAt,
        invocation_index: index,
      }),
    );

    this._logMemoryToolCall(sessionId, toolName, toolArgs, toolOutput, ok);

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
    extraContent?: unknown,
  ): ChatMessage {
    const msg: ChatMessage = { role: "assistant", content: content || "" };
    if (
      extraContent &&
      typeof extraContent === "object" &&
      !Array.isArray(extraContent)
    ) {
      msg.extra_content = extraContent as Record<string, unknown>;
    }
    msg.tool_calls = toolCalls.map((tc) => {
      const [id, name, args] = AgentOrchestrator._extractToolCall(tc);
      return {
        id,
        type: "function" as const,
        function: { name, arguments: args },
        ...(tc.extra_content && typeof tc.extra_content === "object"
          ? { extra_content: tc.extra_content }
          : {}),
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
