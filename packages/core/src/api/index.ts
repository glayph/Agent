import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import cors from "cors";
import * as http from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
import * as path from "path";
import * as fs from "fs";

import { AgentOrchestrator } from "../agent.js";
import type { AgentTask } from "../task-queue.js";
import {
  createWorkspaceSecretVault,
  settings,
  readMikiEnv,
  type VoiceMessageMetadata,
} from "@miki/config";
import {
  allowedCorsOriginsFromEnv,
  hasExplicitAllowedOrigins,
  isAllowedCorsOrigin,
  normalizeCorsOrigin,
  isLoopbackAddress,
} from "@miki/config/security";
import {
  runWithCallContext,
  runWithCallOrigin,
  type CallOrigin,
} from "../tools/executor/call-context.js";
import { TelegramBot } from "../channels/telegram.js";
import { DiscordBot } from "../channels/discord.js";
import { SlackBot } from "../channels/slack.js";
import { createLineWebhookRouter } from "../channels/line.js";
import { MatrixBot } from "../channels/matrix.js";
import { IrcBot } from "../channels/irc.js";
import { OneBotBot } from "../channels/onebot.js";
import { MqttBot } from "../channels/mqtt.js";
import { createWhatsAppBridgeRouter } from "../channels/whatsapp.js";
import { createFeishuWebhookRouter } from "../channels/feishu.js";
import { createDingTalkWebhookRouter } from "../channels/dingtalk.js";
import { createQqWebhookRouter } from "../channels/qq.js";
import { initSkillLoader } from "../skill-loader.js";
import { createSkillsRouter } from "../skill-api.js";
import { PluginChannelRuntimeManager } from "../plugins/plugin-channel-runtime.js";
import { summarizeAgentRoute } from "../agent-router.js";
import {
  buildWorkflowAccelerationPlan,
  buildWorkflowDecisionPattern,
} from "../workflow-accelerator.js";
import { analyzePlanCapabilities } from "../plan-capability-analyzer.js";
import { createSessionRouter } from "./session-router.js";
import { createRuntimeApprovalRouter } from "./runtime-approval-router.js";
import { getSystemStats } from "./system-monitoring.js";
import { createEnhancementRouter } from "./enhancement-router.js";
import { closeHttpServer, closeWebSocketServer } from "./shutdown-utils.js";
import { globalStartupTimer } from "../performance-budgets.js";
import { globalMetricsCollector } from "../metrics-collector.js";
import { initializeSafetyAtStartup } from "../safety/startup.js";
import { getErrorMessage } from "../errors.js";
import {
  detectArtifactContract as _detectArtifactContract,
  reconcileArtifactOutcome as _reconcileArtifactOutcome,
  verifyArtifactContract as _verifyArtifactContract,
  type ArtifactContract,
} from "./artifact-contract.js";
import { SqliteAuditLog } from "../audit-log.js";
import { ApprovalInbox } from "../security/approval-inbox.js";
import { createApprovalRouter } from "./approval-router.js";
import { PersistentJobQueue } from "../persistent-job-queue.js";
import { PersistentJobRunner } from "../persistent-job-runner.js";
import { resolveRuntimePaths } from "../paths.js";
import crypto from "crypto";
import {
  getRequiredApiKeySecret,
  apiKeyFromHeaders,
  validateRequiredApiKey,
  isApiKeyRequestAuthenticated,
  validateApiKeyConfiguration,
  validateApiKey,
  isToolEnabledForSession,
  getToolPermissionDecision,
  recordToolPermissionDenial,
} from "./auth-middleware.js";
import { mountMcpSessionManager } from "../mcp/index.js";
import {
  createLauncherCompatRouter,
  type LauncherRuntimeAuthBridge,
} from "./launcher-compat.js";
import { AgentControlService, createControlRouter } from "../control/index.js";
import type { ControlApprovalRequest } from "../control/index.js";
import {
  createLlamaCppAdapter,
  createVoiceRuntimeAdapter,
} from "../control/model-adapters.js";
import {
  getPlatformDescriptor,
  isSupportedPlatformProvider,
  listPlatformDescriptors,
  type CompleteConnectionInput,
  type BeginConnectionInput,
} from "../platform-connections.js";
import {
  createDefaultSearchRouter,
  type SearchFilters,
  type SearchMode,
} from "../search/local-first-search.js";
import { createMemoryRouter } from "./memory-router.js";
import { createVoiceRouter } from "./voice-router.js";
import { normalizeChatSessionId } from "./chat-session.js";
import { supportsAudioModel } from "../llm.js";
import {
  subscribeDeliveryOutcome,
  type DeliveryOutcomeEvent,
} from "../approval-delivery.js";

globalStartupTimer.start("core.process_start");

const runtimePaths = resolveRuntimePaths();
// The dashboard stores provider credentials in the runtime config vault. Make
// that location explicit before AgentOrchestrator constructs its LLM path so
// live requests do not fall back to the legacy source workspace.
process.env.MIKI_CONFIG_DIR = runtimePaths.configDir;

/**
 * Load workspace runtime values before constructing AgentOrchestrator.
 * The launcher compatibility router loads the same file later, but that is
 * too late for the orchestrator constructor: a supervisor started without a
 * sourced shell .env would otherwise boot with the legacy gpt/openrouter
 * defaults while the dashboard correctly reports the persisted Gemini model.
 */
function bootstrapWorkspaceEnv(configDir: string): void {
  const envPath = path.join(configDir, ".env");
  try {
    const contents = fs.readFileSync(envPath, "utf8");
    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined && process.env[key] !== "") continue;
      let value = rawValue.trim();
      if (
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch {
    // A missing workspace .env is valid for installations using process env.
  }
}

bootstrapWorkspaceEnv(runtimePaths.configDir);
if (process.env.MIKI_MODEL || process.env.DEFAULT_MODEL) {
  const bootModel = process.env.MIKI_MODEL || process.env.DEFAULT_MODEL!;
  settings.setModel(bootModel);
  settings.provider =
    process.env.MIKI_PROVIDER ||
    (bootModel.startsWith("gemini/") ||
    bootModel.startsWith("google/") ||
    bootModel.startsWith("gemini-")
      ? "google"
      : bootModel.startsWith("anthropic/")
        ? "anthropic"
        : bootModel.startsWith("openai/") || bootModel.startsWith("gpt-")
          ? "openai"
          : "openrouter");
}

const chatRunQueues = new Map<string, Promise<void>>();
const activeRunIds = new Map<string, string>();
const pendingFeedback = new Map<string, string[]>();

// Helper function for model switching
function getProviderForModel(model: string): string {
  if (model.startsWith("openrouter/")) return "OpenRouter";
  if (model.startsWith("gemini/") || model.startsWith("google/"))
    return "Google Gemini";
  if (model.startsWith("anthropic/")) return "Anthropic";
  if (model.startsWith("openai/")) return "OpenAI";
  return "OpenRouter";
}

type AuthenticatedRequest = Request & { requestId?: string };
type AliveWebSocket = WebSocket & { __alive?: boolean };

// Typed WebSocket protocol interfaces
export interface WSMessage {
  type: string;
  session_id?: string;
  message?: string;
  task_id?: string;
  checkpoint_id?: string;
  last_sequence?: number;
  [key: string]: unknown;
}

export interface WSResumedMessage extends WSMessage {
  type: "resume";
  session_id: string;
  checkpoint_id: string;
  last_sequence?: number;
}

export interface WSChatMessage extends WSMessage {
  type: string; // Will be 'stream_chunk', 'stream_done', 'error', or 'tool_*'
  content?: string;
  tool?: string;
  input?: unknown;
  output?: unknown;
  blocked?: boolean;
  usage?: { tokens: number };
  agent_loop_id?: number;
}

// Stream chunk storage for resume/replay (in-memory)
interface StoredChunk {
  seq: number;
  chunk: string;
}
const streamChunks = new Map<string, StoredChunk[]>();
const streamChunkTimers = new Map<string, NodeJS.Timeout>();

const MAX_CHUNKS_PER_SESSION = 1000;
const MAX_STREAM_ENTRIES = 500;

function _enforceMaxStreamEntries(): void {
  while (streamChunks.size > MAX_STREAM_ENTRIES) {
    const oldestKey = streamChunks.keys().next().value!;
    streamChunks.delete(oldestKey);
    const timer = streamChunkTimers.get(oldestKey);
    if (timer) {
      clearTimeout(timer);
      streamChunkTimers.delete(oldestKey);
    }
  }
}

function _saveStreamChunk(
  sessionId: string,
  checkpointId: string,
  seq: number,
  chunk: string,
): void {
  const key = `${sessionId}:${checkpointId}`;
  let chunks = streamChunks.get(key);
  if (!chunks) {
    chunks = [];
    streamChunks.set(key, chunks);
  }
  // Reset auto-cleanup timer on each chunk
  const existing = streamChunkTimers.get(key);
  if (existing) clearTimeout(existing);
  streamChunkTimers.set(
    key,
    setTimeout(() => {
      streamChunks.delete(key);
      streamChunkTimers.delete(key);
    }, 300_000),
  );
  streamChunkTimers.get(key)?.unref?.();
  if (chunks.length >= MAX_CHUNKS_PER_SESSION) {
    chunks.shift();
  }
  chunks.push({ seq, chunk });
  _enforceMaxStreamEntries();
}

function _getStreamChunks(
  sessionId: string,
  checkpointId: string,
  afterSeq: number,
): StoredChunk[] {
  const key = `${sessionId}:${checkpointId}`;
  const chunks = streamChunks.get(key);
  if (!chunks) return [];
  return chunks.filter((c) => c.seq > afterSeq).sort((a, b) => a.seq - b.seq);
}

// Performance monitoring middleware with response time headers
const performanceMiddleware = (
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
) => {
  const startHrTime = process.hrtime.bigint();
  const requestIdHeader = req.headers["x-request-id"];
  const requestId = Array.isArray(requestIdHeader)
    ? requestIdHeader[0]
    : requestIdHeader || crypto.randomUUID();

  res.setHeader("X-Request-ID", requestId);
  (req as AuthenticatedRequest).requestId = requestId;

  res.on("finish", () => {
    const elapsedHrTime = process.hrtime.bigint() - startHrTime;
    const elapsedMs = Number(elapsedHrTime) / 1_000_000;
    if (elapsedMs > 1000) {
      console.warn(
        `[PERF] ${req.method} ${req.path} - ${elapsedMs.toFixed(2)}ms [Request-ID: ${requestId}]`,
      );
    }
  });

  next();
};

const workspaceDir = runtimePaths.sourceDir ?? process.cwd();
initializeSafetyAtStartup(runtimePaths);
const permissionAuditLog = new SqliteAuditLog(
  path.join(runtimePaths.dataDir, "audit.db"),
);
const approvalInbox = new ApprovalInbox(
  path.join(runtimePaths.dataDir, "approvals.json"),
  { audit: permissionAuditLog },
);
const orchestrator = new AgentOrchestrator(runtimePaths);
// Agent-callable side effects use the same persisted approval inbox as the dashboard.
orchestrator.tools.setApprovalInbox(approvalInbox);
const persistentJobQueue = new PersistentJobQueue(
  path.join(runtimePaths.dataDir, "runtime-jobs.json"),
);
const persistentJobRunner = new PersistentJobRunner(persistentJobQueue, {
  pollIntervalMs: Number(process.env.MIKI_JOB_POLL_MS) || 500,
  maxConcurrent: Number(process.env.MIKI_JOB_CONCURRENCY) || 1,
});
persistentJobRunner.register("agent.message", async (job) => {
  const payload = job.payload;
  const sessionId =
    typeof payload.sessionId === "string"
      ? payload.sessionId
      : "miki-main-chat";
  const message = typeof payload.message === "string" ? payload.message : "";
  if (!message.trim())
    throw new Error("agent.message requires payload.message");
  let response = "";
  for await (const chunk of orchestrator.runAgentLoop(sessionId, message)) {
    try {
      const event = JSON.parse(chunk) as Record<string, unknown>;
      if (event.type === "stream_chunk" && typeof event.content === "string") {
        response += event.content;
      }
    } catch {
      // Non-JSON chunks are intentionally ignored; the agent protocol is JSONL.
    }
  }
  const event = payload.event;
  return {
    sessionId,
    response,
    eventId:
      event &&
      typeof event === "object" &&
      typeof (event as Record<string, unknown>).eventId === "string"
        ? (event as Record<string, unknown>).eventId
        : undefined,
    correlationId:
      event &&
      typeof event === "object" &&
      typeof (event as Record<string, unknown>).correlationId === "string"
        ? (event as Record<string, unknown>).correlationId
        : undefined,
    replyRoute:
      event &&
      typeof event === "object" &&
      (event as Record<string, unknown>).replyRoute
        ? (event as Record<string, unknown>).replyRoute
        : undefined,
  };
});

const telegramBot = new TelegramBot(orchestrator);
const discordBot = new DiscordBot(orchestrator);
const slackBot = new SlackBot(orchestrator);
const matrixBot = new MatrixBot(orchestrator);
const ircBot = new IrcBot(orchestrator);
const oneBotBot = new OneBotBot(orchestrator);
const mqttBot = new MqttBot(orchestrator);

interface ManagedChannelRuntime {
  start(): void;
  stop(): void;
}

class ChannelRuntimeManager {
  private runtimes: Map<string, ManagedChannelRuntime>;
  private pluginRuntime: PluginChannelRuntimeManager;

  constructor(
    entries: Array<[string, ManagedChannelRuntime]>,
    pluginRuntime: PluginChannelRuntimeManager,
  ) {
    this.runtimes = new Map(entries);
    this.pluginRuntime = pluginRuntime;
  }

  startAll(): void {
    for (const name of this.runtimes.keys()) {
      this.start(name);
    }
    void this.pluginRuntime.startAll();
  }

  reload(names: string[]): void {
    const selected = Array.from(
      new Set(names.filter((name) => this.runtimes.has(name))),
    );
    for (const name of selected) {
      this.stop(name);
    }
    for (const name of selected) {
      this.start(name);
    }
    void this.pluginRuntime.reload(names);
  }

  stopAll(): void {
    for (const name of this.runtimes.keys()) {
      this.stop(name);
    }
    this.pluginRuntime.stopAll();
  }

  private start(name: string): void {
    try {
      this.runtimes.get(name)?.start();
    } catch (e: unknown) {
      console.warn(`${name} channel startup: ${getErrorMessage(e)}`);
    }
  }

  private stop(name: string): void {
    try {
      this.runtimes.get(name)?.stop();
    } catch (e: unknown) {
      console.warn(`${name} channel shutdown: ${getErrorMessage(e)}`);
    }
  }
}

const pluginChannelRuntimeManager = new PluginChannelRuntimeManager(
  orchestrator,
  runtimePaths,
);
const channelRuntimeManager = new ChannelRuntimeManager(
  [
    ["telegram", telegramBot],
    ["discord", discordBot],
    ["slack", slackBot],
    ["matrix", matrixBot],
    ["irc", ircBot],
    ["onebot", oneBotBot],
    ["mqtt", mqttBot],
  ],
  pluginChannelRuntimeManager,
);

// Initialize skill system
const skillLoader = initSkillLoader(runtimePaths);
const skillsRouter = createSkillsRouter(skillLoader, runtimePaths, {
  toolRegistry: orchestrator.tools,
});
let launcherRuntimeAuth: LauncherRuntimeAuthBridge | null = null;
let agentControlService: AgentControlService | undefined;
const controlRouter = createControlRouter(() => agentControlService);
const launcherCompatRouter = createLauncherCompatRouter({
  orchestrator,
  skillLoader,
  runtimePaths,
  workspaceDir,
  registerRuntimeAuth: (runtimeAuth) => {
    launcherRuntimeAuth = runtimeAuth;
  },
  getAgentControlService: () => agentControlService,
  registerAdminController: (controller) => {
    orchestrator.tools.setAdminController(controller);
    agentControlService = new AgentControlService({
      controller,
      runtimePaths,
      modelAdapters: [
        createLlamaCppAdapter(),
        createVoiceRuntimeAdapter(runtimePaths),
      ],
      approvals: {
        requestApproval: async (request: ControlApprovalRequest) => {
          const previewHash = JSON.stringify({
            capability: request.capability,
            action: request.action,
            input: request.sanitizedInput,
          });
          const challenge = approvalInbox.request({
            runId: request.operationId,
            actor: request.context.actor || "agent-control",
            action:
              request.risk === "destructive" ? "delete" : "external_write",
            resource: `control:${request.capability}.${request.action}`,
            risk:
              request.risk === "destructive"
                ? "critical"
                : request.risk === "service" || request.risk === "install"
                  ? "high"
                  : "medium",
            reason: request.reason,
            context: {
              stepId: `${request.capability}:${request.action}`,
              deliveryId: request.operationId,
              previewHash,
            },
          });
          return { requestId: challenge.request.id };
        },
        isApproved: (request: ControlApprovalRequest, token?: string) => {
          if (!request.context || !request.operationId) return false;
          const requestId = request.approvalRequestId;
          if (!requestId) return false;
          if (token) return approvalInbox.isApproved(requestId, token);
          try {
            const previewHash = JSON.stringify({
              capability: request.capability,
              action: request.action,
              input: request.sanitizedInput,
            });
            approvalInbox.assertApprovedByContext(
              requestId,
              {
                runId: request.operationId,
                stepId: `${request.capability}:${request.action}`,
                deliveryId: request.operationId,
                previewHash,
              },
              request.context.actor || "agent-control",
            );
            return true;
          } catch {
            return false;
          }
        },
        consumeApproval: (
          request: ControlApprovalRequest,
          requestId: string,
        ) => {
          try {
            const previewHash = JSON.stringify({
              capability: request.capability,
              action: request.action,
              input: request.sanitizedInput,
            });
            approvalInbox.consumeByContext(
              requestId,
              {
                runId: request.operationId,
                stepId: `${request.capability}:${request.action}`,
                deliveryId: request.operationId,
                previewHash,
              },
              request.context.actor || "agent-control",
            );
            return true;
          } catch {
            return false;
          }
        },
      },
      hooks: {
        reload: async (_reason) => {
          await orchestrator.reloadConfig();
          return { pendingRestart: false };
        },
        readToolState: () => {
          const config = controller.getConfig();
          const tools = config.tools;
          const state =
            tools && typeof tools === "object" && !Array.isArray(tools)
              ? (tools as Record<string, unknown>).tool_state
              : undefined;
          return state && typeof state === "object" && !Array.isArray(state)
            ? (state as Record<string, boolean>)
            : {};
        },
        readExtraState: () => ({
          gateway_restart_required: false,
          reload_available: true,
          operation_control: "shared_launcher_controller",
          active_model: orchestrator.modelName,
          provider: orchestrator.provider,
        }),
      },
    });
    orchestrator.control = agentControlService;
  },
  reloadRuntime: async ({ channelsChanged = [] } = {}) => {
    await orchestrator.reloadConfig();
    if (channelsChanged.length > 0) {
      channelRuntimeManager.reload(channelsChanged);
    }
  },
});
const enhancementRouter = createEnhancementRouter({
  workspaceDir,
  runtimePaths,
  jobQueue: persistentJobQueue,
  jobRunner: persistentJobRunner,
  approvalInbox,
  executeAgentRun: async (run, hooks) => {
    for (const step of run.steps) {
      hooks.startStep(step.id);
      try {
        let response = "";
        for await (const chunk of orchestrator.runAgentLoop(
          `agent-run:${run.id}`,
          `${run.objective}\n\nCurrent run step: ${step.title}`,
        )) {
          try {
            const event = JSON.parse(chunk) as Record<string, unknown>;
            if (
              event.type === "stream_chunk" &&
              typeof event.content === "string"
            ) {
              response += event.content;
            }
          } catch {
            // Agent protocol is JSONL; non-JSON chunks are not persisted as evidence.
          }
        }
        hooks.completeStep(step.id, {
          kind: "manual",
          summary: response.trim()
            ? `Completed: ${step.title}`
            : `Completed step: ${step.title}`,
          ok: true,
          source: "executor",
          phase: "executor",
          data: response.trim()
            ? { response: response.trim().slice(0, 2000) }
            : undefined,
        });
      } catch (error) {
        hooks.failStep(step.id, error);
        throw error;
      }
    }
  },
});
const searchRouter = createDefaultSearchRouter();
const memoryRouter = createMemoryRouter();

function persistAgentTask(_task: AgentTask): void {
  // Task persistence is handled in-memory by TaskQueue
}

// Remove the circuit breaker instance — routes use direct error handling
const app = express();
// Core always runs proxied behind the gateway, which connects to it over
// 127.0.0.1 (see coreHost default in packages/config/src/config.ts) and
// forwards the real client address via X-Forwarded-For (xfwd, gateway's
// apiProxy). "loopback" tells Express to derive req.ip from that header
// only when the immediate socket peer is itself a loopback address — i.e.
// only the gateway hop is trusted to report a client IP. A client that
// somehow reaches core directly on a non-loopback CORE_HOST cannot spoof
// this: its own socket address is not loopback, so any X-Forwarded-For it
// sends is ignored and req.ip falls back to its real remote address. This
// keeps per-client throttling (e.g. dashboard login lockout) keyed by the
// real client instead of collapsing every client behind the gateway into
// one shared bucket.
app.set("trust proxy", "loopback");
const currentAllowedCorsOrigins = () =>
  allowedCorsOriginsFromEnv({ workspaceDir });
const rejectDisallowedOrigin = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const origin = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;
  if (
    !isAllowedCorsOrigin(
      origin,
      currentAllowedCorsOrigins(),
      hasExplicitAllowedOrigins(),
    )
  ) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  return next();
};

function firstHeaderValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

/**
 * Web UI chat is Miki's primary chat interface (Live Agent work page),
 * re-enabled per updated project spec 2026-08-12 - supersedes the prior
 * standing directive that gated it behind connected platforms only.
 * Connected platforms (Telegram, Discord, WhatsApp, Slack, Feishu,
 * DingTalk, Line, QQ, Matrix, IRC, MQTT, OneBot) remain fully supported
 * and share the same universal session/history as the Web UI - this flag
 * only controls whether the dashboard's own chat surface (POST
 * /api/chat, POST /chat, WS /ws/chat, WS /miki/ws) is reachable.
 *
 * To disable Web UI chat again (e.g. to restrict to connected platforms
 * only), flip this back to `true`; handleChatRequest and the
 * mikiWss/wss WebSocketServer instances are unaffected by the flag's
 * value either way.
 */
const WEB_UI_CHAT_DISABLED = false;

function rejectUpgrade(
  socket: Duplex,
  statusCode: 401 | 403,
  reason: string,
): void {
  const body = JSON.stringify({ error: reason });
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: application/json\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "\r\n" +
      body,
  );
  socket.destroy();
}

function ismikiBearerAuthenticated(request: http.IncomingMessage): boolean {
  const configuredToken = launcherRuntimeAuth?.getmikiToken();
  if (!configuredToken) return false;
  const authorization = firstHeaderValue(request.headers.authorization);
  const incomingToken = authorization.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  if (!incomingToken) return false;
  const left = Buffer.from(incomingToken);
  const right = Buffer.from(configuredToken);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function isWebSocketUpgradeAuthorized(
  request: http.IncomingMessage,
  pathname: string,
): boolean {
  if (isApiKeyRequestAuthenticated(request.headers)) return true;
  if (launcherRuntimeAuth?.isDashboardAuthenticated(request.headers)) {
    return true;
  }
  return pathname === "/miki/ws" && ismikiBearerAuthenticated(request);
}

validateApiKeyConfiguration();
app.use(rejectDisallowedOrigin);
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      const normalized = normalizeCorsOrigin(origin);
      return callback(null, normalized || false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-API-Key",
      "MCP-Session-ID",
      "X-Session-ID",
      "X-Line-Signature",
      "X-Miki-WhatsApp-Token",
      "X-WhatsApp-Bridge-Token",
      "X-DingTalk-Timestamp",
      "X-DingTalk-Signature",
      "X-Lark-Signature",
      "X-Lark-Request-Timestamp",
      "X-Lark-Request-Nonce",
    ],
  }),
);
app.use(
  express.json({
    limit: "30mb",
    verify(req, _res, buf) {
      (req as Request & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
    },
  }),
);
app.use(performanceMiddleware);

// Request timeout middleware (120s for normal routes, longer for chat)
const REQUEST_TIMEOUT_MS = 120000;
app.use((req, res, next) => {
  if (req.path === "/chat") return next();
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(503).json({
        detail: "Request timed out",
        requestId: (req as AuthenticatedRequest).requestId,
      });
    }
  });
  next();
});

// Request ID middleware (additional tracking)
app.use((req, _res, next) => {
  if (!req.headers["x-request-id"]) {
    req.headers["x-request-id"] = crypto.randomUUID() as string;
  }
  next();
});

// Channel webhook runtimes authenticate with provider signatures, not dashboard API keys.
app.use("/webhooks/line", createLineWebhookRouter(orchestrator));
app.use("/webhooks/whatsapp", createWhatsAppBridgeRouter(orchestrator));
app.use("/webhooks/feishu", createFeishuWebhookRouter(orchestrator));
app.use("/webhooks/dingtalk", createDingTalkWebhookRouter(orchestrator));
app.use("/webhooks/qq", createQqWebhookRouter(orchestrator));

// API Key validation middleware (optional, configurable)
app.use(validateApiKey);

app.use((_req, _res, next) => {
  next();
});

// Mount skills API before the compat router so /api/skills/* routes are not
// shadowed by the compat router's /skills/:name catch-all.
app.use("/api/skills", skillsRouter);

// Mount the authenticated enhancement runtime before the compatibility router.
// The compatibility router owns `/api` and installs a dashboard-session guard;
// mounting enhancements after it would shadow these routes and reject valid
// API-key requests before `requireHttpAuth` can run.
app.use("/api/enhancements", requireHttpAuth, enhancementRouter);

function parseSearchFilters(value: unknown): SearchFilters | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Record<string, unknown>;
  const domains = Array.isArray(input.domains)
    ? input.domains
        .filter((item): item is string => typeof item === "string")
        .slice(0, 20)
    : undefined;
  const freshness =
    input.freshness === "day" ||
    input.freshness === "week" ||
    input.freshness === "month" ||
    input.freshness === "year" ||
    input.freshness === "any"
      ? input.freshness
      : undefined;
  const locale =
    typeof input.locale === "string" ? input.locale.slice(0, 20) : undefined;
  const maxResults =
    typeof input.maxResults === "number" ? input.maxResults : undefined;
  return { domains, freshness, locale, maxResults };
}

function parseSearchMode(value: unknown): SearchMode | undefined {
  return value === "local" || value === "cloud" || value === "auto"
    ? value
    : undefined;
}

async function handleSearchRequest(req: Request, res: Response): Promise<void> {
  const input = (req.method === "GET" ? req.query : req.body) as Record<
    string,
    unknown
  >;
  const query =
    typeof input.query === "string" ? input.query.trim().slice(0, 2_000) : "";
  if (!query) {
    res.status(400).json({ error: "query is required" });
    return;
  }
  try {
    const result = await searchRouter.search({
      query,
      mode: parseSearchMode(input.mode),
      filters: parseSearchFilters(input.filters),
      allowSensitiveCloud: input.allowSensitiveCloud === true,
    });
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /blocked|not configured|cannot be empty|sensitive/i.test(
      message,
    )
      ? 400
      : 502;
    res.status(status).json({ error: message });
  }
}

app.get("/api/search", requireHttpAuth, handleSearchRequest);
app.post("/api/search", requireHttpAuth, handleSearchRequest);
app.use("/api/memory", requireHttpAuth, memoryRouter);
app.use(
  "/api/voice",
  requireHttpAuth,
  createVoiceRouter({ configDir: runtimePaths.configDir }),
);

app.post("/api/search/fetch", requireHttpAuth, async (req, res) => {
  const url = typeof req.body?.url === "string" ? req.body.url : "";
  const mode = parseSearchMode(req.body?.mode);
  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }
  try {
    res.json(await searchRouter.fetch(url, mode));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(502).json({ error: message });
  }
});

// Mount the shared management API before the compatibility router. It uses
// the same authenticated HTTP boundary and the same controller instance that
// powers the dashboard.
app.use("/api/control", requireHttpAuth, controlRouter);
app.use(
  "/api/control/approvals",
  requireHttpAuth,
  createApprovalRouter(approvalInbox),
);

// Mount /api/chat before the compat router so it is not shadowed by the
// compat router's unconditional `router.use(requireDashboardAuth)`. The
// gateway rewrites incoming "/chat" requests to "/api/chat" before proxying
// to Core, so without this the chat endpoint always returns 401 Unauthorized
// unless a dashboard session is already established, even with a valid
// per-request API key.
//
// requireHttpAuth (not requireDashboardAuth) is intentional here: it
// accepts a valid API key *or* a dashboard session, matching the direct
// /chat route below (line ~1449) and the rest of the direct control
// surface. Mounting this route with no auth middleware at all would let
// any client that can reach core run the full agent loop -- including
// whatever tools are configured, e.g. shell_execute under TRUSTED_FULL_ACCESS --
// with zero authentication (#17).
app.post("/api/chat", requireHttpAuth, handleChatRequest);

// UI compatibility API used by the bundled dashboard.
app.use("/api", launcherCompatRouter);

const automationManager = orchestrator.getAutomationManager();
const platformConnectionStore = orchestrator.platformConnectionStore;
const automationTargets = new Set([
  "internal",
  "research",
  "facebook",
  "youtube",
]);
const automationApprovalModes = new Set(["none", "review", "publish"]);

function parseAutomationRunAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function parseAutomationBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

app.get("/api/automations", requireHttpAuth, (req, res) => {
  const rawLimit = Number(req.query["limit"]);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(500, rawLimit))
    : 100;
  res.json({
    automations: automationManager.list(limit),
    requestId: (req as AuthenticatedRequest).requestId,
  });
});

app.post("/api/automations", requireHttpAuth, (req, res) => {
  try {
    const body = parseAutomationBody(req.body);
    const objective = typeof body.objective === "string" ? body.objective : "";
    const steps = Array.isArray(body.steps)
      ? body.steps.filter((value): value is string => typeof value === "string")
      : undefined;
    const runAt = parseAutomationRunAt(body.runAt ?? body.run_at);
    const cronExpression =
      typeof body.cronExpression === "string"
        ? body.cronExpression
        : typeof body.cron_expression === "string"
          ? body.cron_expression
          : undefined;
    const target =
      typeof body.target === "string" && automationTargets.has(body.target)
        ? (body.target as "internal" | "research" | "facebook" | "youtube")
        : undefined;
    const approvalMode =
      typeof body.approvalMode === "string" &&
      automationApprovalModes.has(body.approvalMode)
        ? (body.approvalMode as "none" | "review" | "publish")
        : undefined;
    const automation = automationManager.create({
      name: typeof body.name === "string" ? body.name : undefined,
      objective,
      sessionId:
        typeof body.sessionId === "string" ? body.sessionId : undefined,
      steps,
      target,
      approvalMode,
      cronExpression,
      runAt,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      maxAttempts:
        typeof body.maxAttempts === "number" ? body.maxAttempts : undefined,
    });
    res
      .status(201)
      .json({ automation, requestId: (req as AuthenticatedRequest).requestId });
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.get("/api/automations/:automationId", requireHttpAuth, (req, res) => {
  const automation = automationManager.get(req.params.automationId);
  if (!automation) {
    res.status(404).json({ error: "Automation not found" });
    return;
  }
  res.json({ automation, requestId: (req as AuthenticatedRequest).requestId });
});

app.get(
  "/api/automations/:automationId/executions",
  requireHttpAuth,
  (req, res) => {
    const automation = automationManager.get(req.params.automationId);
    if (!automation) {
      res.status(404).json({ error: "Automation not found" });
      return;
    }
    const rawLimit = Number(req.query["limit"]);
    const limit = Number.isFinite(rawLimit)
      ? Math.max(1, Math.min(500, rawLimit))
      : 100;
    res.json({
      executions: automationManager.executions(automation.id, limit),
      requestId: (req as AuthenticatedRequest).requestId,
    });
  },
);

app.patch("/api/automations/:automationId", requireHttpAuth, (req, res) => {
  try {
    const body = parseAutomationBody(req.body);
    const steps = Array.isArray(body.steps)
      ? body.steps.filter((value): value is string => typeof value === "string")
      : undefined;
    const runAt =
      body.runAt === null || body.run_at === null
        ? null
        : parseAutomationRunAt(body.runAt ?? body.run_at);
    const cronExpression =
      body.cronExpression === null || body.cron_expression === null
        ? null
        : typeof (body.cronExpression ?? body.cron_expression) === "string"
          ? String(body.cronExpression ?? body.cron_expression)
          : undefined;
    const target =
      typeof body.target === "string" && automationTargets.has(body.target)
        ? (body.target as "internal" | "research" | "facebook" | "youtube")
        : undefined;
    const approvalMode =
      typeof body.approvalMode === "string" &&
      automationApprovalModes.has(body.approvalMode)
        ? (body.approvalMode as "none" | "review" | "publish")
        : undefined;
    const automation = automationManager.update(req.params.automationId, {
      name: typeof body.name === "string" ? body.name : undefined,
      objective:
        typeof body.objective === "string" ? body.objective : undefined,
      steps,
      target,
      approvalMode,
      cronExpression,
      runAt,
      timezone: typeof body.timezone === "string" ? body.timezone : undefined,
      maxAttempts:
        typeof body.maxAttempts === "number" ? body.maxAttempts : undefined,
    });
    res.json({
      automation,
      requestId: (req as AuthenticatedRequest).requestId,
    });
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

for (const [action, handler] of [
  ["pause", (id: string) => automationManager.pause(id)],
  ["resume", (id: string) => automationManager.resume(id)],
  ["cancel", (id: string) => automationManager.cancel(id)],
] as const) {
  app.post(
    `/api/automations/:automationId/${action}`,
    requireHttpAuth,
    (req, res) => {
      try {
        const automation = handler(req.params.automationId);
        res.json({
          automation,
          requestId: (req as AuthenticatedRequest).requestId,
        });
      } catch (error: unknown) {
        res.status(404).json({ error: getErrorMessage(error) });
      }
    },
  );
}

app.post(
  "/api/automations/:automationId/run-now",
  requireHttpAuth,
  (req, res) => {
    try {
      const execution = automationManager.runNow(req.params.automationId);
      res.status(202).json({
        execution,
        requestId: (req as AuthenticatedRequest).requestId,
      });
    } catch (error: unknown) {
      res.status(404).json({ error: getErrorMessage(error) });
    }
  },
);

// Browser-first provider connection surface. These endpoints persist only
// opaque credential references and connection metadata; raw passwords, OTPs,
// access tokens, and API keys are never accepted in the connection session API.
app.get("/api/platforms", requireHttpAuth, (req, res) => {
  res.json({
    platforms: listPlatformDescriptors(),
    requestId: (req as AuthenticatedRequest).requestId,
  });
});

app.get("/api/connections", requireHttpAuth, (req, res) => {
  const rawLimit = Number(req.query["limit"]);
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(500, rawLimit))
    : 100;
  res.json({
    connections: platformConnectionStore.listConnections(limit),
    requestId: (req as AuthenticatedRequest).requestId,
  });
});

app.post("/api/connections/browser/start", requireHttpAuth, (req, res) => {
  try {
    const body = parseAutomationBody(req.body);
    const provider = body.provider;
    if (!isSupportedPlatformProvider(provider)) {
      res
        .status(400)
        .json({ error: "A supported platform provider is required" });
      return;
    }
    const info = getPlatformDescriptor(provider);
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter(
          (value): value is string => typeof value === "string",
        )
      : info.requiredScopes;
    const session = platformConnectionStore.begin({
      provider,
      scopes,
    } satisfies BeginConnectionInput);
    res.status(201).json({
      session,
      browser: {
        action: "open_official_url",
        url: session.officialUrl,
        expectedDomain: session.expectedDomain,
        requiresUserHandoff: true,
        message: session.userActionRequired,
      },
      requestId: (req as AuthenticatedRequest).requestId,
    });
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post("/api/connections/token", requireHttpAuth, (req, res) => {
  try {
    const body = parseAutomationBody(req.body);
    const provider = body.provider;
    if (!isSupportedPlatformProvider(provider)) {
      res
        .status(400)
        .json({ error: "A supported platform provider is required" });
      return;
    }
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const accountLabel =
      typeof body.accountLabel === "string" ? body.accountLabel.trim() : "";
    if (!token) {
      res.status(400).json({ error: "A provider token is required" });
      return;
    }
    if (!accountLabel) {
      res.status(400).json({ error: "An account label is required" });
      return;
    }
    if (token.length > 16_384) {
      res.status(413).json({ error: "Provider token is too large" });
      return;
    }
    const info = getPlatformDescriptor(provider);
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter(
          (value): value is string => typeof value === "string",
        )
      : info.requiredScopes;
    const session = platformConnectionStore.begin({ provider, scopes });
    const credentialRef = `platform/${provider}/${crypto.randomUUID()}`;
    const vault = createWorkspaceSecretVault(runtimePaths.dataDir);
    // The raw token is accepted only on this authenticated transport boundary;
    // it is immediately written to the encrypted vault and never forwarded to
    // the model, WebSocket chat history, logs, or the connection metadata DB.
    vault.set(credentialRef, token);
    const result = platformConnectionStore.complete(session.id, {
      accountLabel,
      externalAccountId:
        typeof body.externalAccountId === "string"
          ? body.externalAccountId
          : undefined,
      scopes,
      credentialRef,
      expiresAt:
        typeof body.expiresAt === "string" ? body.expiresAt : undefined,
    });
    res.status(201).json({
      ...result,
      credentialStored: true,
      requestId: (req as AuthenticatedRequest).requestId,
    });
  } catch (error: unknown) {
    res.status(400).json({ error: getErrorMessage(error) });
  }
});

app.post(
  "/api/connections/browser/:sessionId/opened",
  requireHttpAuth,
  (req, res) => {
    try {
      const session = platformConnectionStore.markBrowserOpened(
        req.params.sessionId,
      );
      res.json({ session, requestId: (req as AuthenticatedRequest).requestId });
    } catch (error: unknown) {
      res.status(400).json({ error: getErrorMessage(error) });
    }
  },
);

app.get("/api/connections/browser/:sessionId", requireHttpAuth, (req, res) => {
  const session = platformConnectionStore.getSession(req.params.sessionId);
  if (!session) {
    res.status(404).json({ error: "Browser connection session not found" });
    return;
  }
  res.json({ session, requestId: (req as AuthenticatedRequest).requestId });
});

app.post(
  "/api/connections/browser/:sessionId/complete",
  requireHttpAuth,
  (req, res) => {
    try {
      const body = parseAutomationBody(req.body);
      // The callback accepts an opaque vault reference only. Raw secrets must be
      // entered on the official provider page or through the managed vault flow.
      for (const field of [
        "token",
        "apiKey",
        "api_key",
        "secret",
        "password",
        "accessToken",
        "refreshToken",
      ]) {
        if (typeof body[field] === "string" && body[field].trim()) {
          res.status(400).json({
            error:
              "Raw credentials are not accepted here. Complete provider login in the browser and return an opaque credential reference.",
          });
          return;
        }
      }
      const input: CompleteConnectionInput = {
        accountLabel:
          typeof body.accountLabel === "string" ? body.accountLabel : "",
        externalAccountId:
          typeof body.externalAccountId === "string"
            ? body.externalAccountId
            : undefined,
        scopes: Array.isArray(body.scopes)
          ? body.scopes.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined,
        credentialRef:
          typeof body.credentialRef === "string"
            ? body.credentialRef
            : undefined,
        expiresAt:
          typeof body.expiresAt === "string" ? body.expiresAt : undefined,
      };
      const result = platformConnectionStore.complete(
        req.params.sessionId,
        input,
      );
      res.status(201).json({
        ...result,
        requestId: (req as AuthenticatedRequest).requestId,
      });
    } catch (error: unknown) {
      res.status(400).json({ error: getErrorMessage(error) });
    }
  },
);

app.post(
  "/api/connections/:connectionId/validate",
  requireHttpAuth,
  (req, res) => {
    try {
      const connection = platformConnectionStore.validate(
        req.params.connectionId,
      );
      res.json({
        connection,
        requestId: (req as AuthenticatedRequest).requestId,
      });
    } catch (error: unknown) {
      res.status(400).json({ error: getErrorMessage(error) });
    }
  },
);

app.post(
  "/api/connections/:connectionId/revoke",
  requireHttpAuth,
  (req, res) => {
    try {
      const connection = platformConnectionStore.revoke(
        req.params.connectionId,
      );
      res.json({
        connection,
        requestId: (req as AuthenticatedRequest).requestId,
      });
    } catch (error: unknown) {
      res.status(400).json({ error: getErrorMessage(error) });
    }
  },
);

app.use("/enhancements", (_req, res) => {
  res.status(404).json({
    error: "Use /api/enhancements with dashboard authentication.",
  });
});

// Mount session router for permissions management — always require auth
app.use(
  "/sessions",
  validateRequiredApiKey,
  createSessionRouter({ audit: permissionAuditLog }),
);
app.use(
  "/approvals",
  validateRequiredApiKey,
  createApprovalRouter(approvalInbox),
);

// Mount runtime-installer approval router — lets the CLI TUI / web dashboard
// list and approve/deny pending external-runtime install requests created by
// the runtime_ensure tool (see packages/core/src/runtime-fetch/).
app.use(
  "/runtime-installer",
  validateRequiredApiKey,
  createRuntimeApprovalRouter({
    getRuntimeFetcher: () => orchestrator.tools.runtimeFetcher,
  }),
);

const server = http.createServer(app);
server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${settings.corePort} is already in use. Kill the stale process and restart.`,
    );
  } else {
    console.error("Server error:", err);
  }
  process.exit(1);
});
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 5 * 1024 * 1024, // 5MB
});
const mikiWss = new WebSocketServer({
  noServer: true,
  maxPayload: 5 * 1024 * 1024,
});

const unsubscribeDeliveryOutcome = subscribeDeliveryOutcome(
  (event: DeliveryOutcomeEvent) => {
    const serialized = JSON.stringify(event);
    mikiWss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(serialized);
    });
  },
);

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  const origin = firstHeaderValue(request.headers.origin);
  if (
    !isAllowedCorsOrigin(
      origin,
      currentAllowedCorsOrigins(),
      hasExplicitAllowedOrigins(),
    )
  ) {
    rejectUpgrade(socket, 403, "Forbidden");
    return;
  }
  if (pathname === "/ws/chat") {
    if (WEB_UI_CHAT_DISABLED) {
      rejectUpgrade(
        socket,
        403,
        "Web UI chat is disabled - use a connected platform (Telegram, Discord, etc.)",
      );
      return;
    }
    if (!isWebSocketUpgradeAuthorized(request, pathname)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
    return;
  }
  if (pathname === "/miki/ws") {
    if (WEB_UI_CHAT_DISABLED) {
      rejectUpgrade(
        socket,
        403,
        "Web UI chat is disabled - use a connected platform (Telegram, Discord, etc.)",
      );
      return;
    }
    if (!isWebSocketUpgradeAuthorized(request, pathname)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    mikiWss.handleUpgrade(request, socket, head, (ws) => {
      mikiWss.emit("connection", ws, request);
    });
    return;
  }
  socket.destroy();
});

// Periodic WebSocket ping to detect dead connections
const WS_PING_INTERVAL = 30000;
let wsPingTimer: NodeJS.Timeout | null = null;

function _setupWSPing(): void {
  wsPingTimer = setInterval(() => {
    for (const server of [wss, mikiWss]) {
      server.clients.forEach((ws) => {
        const aliveWs = ws as AliveWebSocket;
        if (aliveWs.__alive === false) {
          ws.terminate();
          return;
        }
        aliveWs.__alive = false;
        ws.ping();
      });
    }
  }, WS_PING_INTERVAL);
  wsPingTimer.unref?.();
}

function _sendmiki(ws: WebSocket, message: Record<string, unknown>): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function _parseJsonMessage(raw: Buffer): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw.toString());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function _asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function _decodeEphemeralAudio(
  value: unknown,
): { data: Buffer; mimeType: string; filename?: string } | undefined {
  const audio = _asRecord(value);
  const encoded = typeof audio.data === "string" ? audio.data.trim() : "";
  const mimeType =
    typeof audio.mimeType === "string"
      ? audio.mimeType.split(";", 1)[0].trim().toLowerCase()
      : "";
  if (!encoded) return undefined;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length > 36_000_000) {
    throw new Error("Voice audio payload is invalid or too large.");
  }
  const data = Buffer.from(encoded, "base64");
  if (data.length === 0 || data.length > 25 * 1024 * 1024) {
    throw new Error("Voice audio payload exceeds the 25 MB limit.");
  }
  if (
    !/^audio\/(wav|x-wav|wave|mpeg|mp3|mp4|x-m4a|ogg|webm|flac|x-flac)$/.test(
      mimeType,
    )
  ) {
    throw new Error("Voice audio format is not supported.");
  }
  const filename =
    typeof audio.filename === "string"
      ? path.basename(audio.filename).slice(0, 120)
      : undefined;
  return { data, mimeType, ...(filename ? { filename } : {}) };
}

interface ToolFeedbackConfig {
  enabled: boolean;
  maxArgsLength: number;
  separateMessages: boolean;
}

interface MikiStreamingConfig {
  enabled: boolean;
  throttleMs: number;
  minGrowthChars: number;
}

/**
 * Reads agents.defaults.tool_feedback from live config (see the
 * tool_feedback block in launcher-compat.ts defaultAppConfig for the
 * matching default shape). Falls back to those same defaults when a field
 * is absent so behavior stays identical to a fresh install.
 */
function _getToolFeedbackConfig(): ToolFeedbackConfig {
  const agents = _asRecord(orchestrator.config.agents);
  const defaults = _asRecord(agents.defaults);
  const toolFeedback = _asRecord(defaults.tool_feedback);

  const enabled =
    typeof toolFeedback.enabled === "boolean" ? toolFeedback.enabled : true;
  const maxArgsLength = Number(toolFeedback.max_args_length);
  const separateMessages =
    typeof toolFeedback.separate_messages === "boolean"
      ? toolFeedback.separate_messages
      : false;

  return {
    enabled,
    maxArgsLength:
      Number.isFinite(maxArgsLength) && maxArgsLength > 0
        ? Math.floor(maxArgsLength)
        : 300,
    separateMessages,
  };
}

/** Truncates a JSON-stringified tool-argument preview to maxArgsLength. */
function _getmikiStreamingConfig(): MikiStreamingConfig {
  const channels = _asRecord(orchestrator.config.channels);
  const miki = _asRecord(channels.miki);
  const settings = _asRecord(miki.settings);
  const streaming = _asRecord(settings.streaming ?? miki.streaming);
  const enabled =
    typeof streaming.enabled === "boolean" ? streaming.enabled : true;
  const throttleSeconds = Number(streaming.throttle_seconds);
  const minGrowthChars = Number(streaming.min_growth_chars);
  return {
    enabled,
    throttleMs:
      Number.isFinite(throttleSeconds) && throttleSeconds > 0
        ? Math.min(10_000, Math.floor(throttleSeconds * 1000))
        : 350,
    minGrowthChars:
      Number.isFinite(minGrowthChars) && minGrowthChars > 0
        ? Math.min(10_000, Math.floor(minGrowthChars))
        : 1,
  };
}

function _previewToolArgs(input: unknown, maxArgsLength: number): string {
  const full = JSON.stringify(input || {});
  if (full.length <= maxArgsLength) return full;
  return full.slice(0, maxArgsLength) + "…";
}

function _previewToolOutput(output: unknown, maxLength: number): string {
  const full =
    typeof output === "string" ? output : JSON.stringify(output ?? "");
  if (full.length <= maxLength) return full;
  return full.slice(0, maxLength) + "…";
}

function _toolPath(input: unknown): string {
  const record = _asRecord(input);
  const value = typeof record.path === "string" ? record.path.trim() : "";
  return value || "the requested path";
}

function _toolActionDescription(tool: unknown, input: unknown): string {
  const name = typeof tool === "string" ? tool : "tool";
  const target = _toolPath(input);
  if (name === "file_read") return `Reading file: ${target}`;
  if (name === "file_write") return `Editing file: ${target}`;
  if (name === "file_delete") {
    return _asRecord(input).dryRun === true
      ? `Checking deletion without changing the file: ${target}`
      : `Deleting file: ${target}`;
  }
  return `Running tool: ${name}`;
}

function _toolResultDescription(
  tool: unknown,
  input: unknown,
  ok: boolean,
  output: unknown,
  durationMs: unknown,
  maxLength: number,
): string {
  const action = _toolActionDescription(tool, input);
  const elapsed = Number(durationMs);
  const timing = Number.isFinite(elapsed)
    ? ` (${Math.max(0, Math.round(elapsed))} ms)`
    : "";
  if (ok) {
    return `${action
      .replace(
        /^Checking deletion without changing the file:/,
        "Deletion check completed:",
      )
      .replace(/^Reading file:/, "File read completed:")
      .replace(/^Editing file:/, "File edit completed:")
      .replace(/^Deleting file:/, "File deletion completed:")}${timing}`;
  }
  const detail = _previewToolOutput(output, maxLength).trim();
  return `${action} failed${detail ? `: ${detail}` : ""}${timing}`;
}

/**
 * Sends a compact, non-sensitive execution summary to the Inspector only.
 * These messages use kind="thought", which the main transcript intentionally
 * hides while the Inspector renders them as expandable categorized cards.
 */
function _sendInspectorThought(
  ws: WebSocket,
  sessionId: string,
  runId: string,
  content: string,
  category: "Plan" | "Action" | "Verification" | "Progress" | "Decision",
): void {
  const trimmed = content.trim();
  if (!trimmed) return;
  _sendmiki(ws, {
    type: "message.create",
    id: crypto.randomUUID(),
    session_id: sessionId,
    timestamp: Date.now(),
    payload: {
      message_id: `${runId}-thought-${crypto.randomUUID()}`,
      run_id: runId,
      content: trimmed,
      kind: "thought",
      thought_category: category,
      inspector_only: true,
      model_name: orchestrator.modelName,
    },
  });
}

interface mikiContextUsage {
  used_tokens: number;
  total_tokens: number;
  compress_at_tokens: number;
  used_percent: number;
}

function _normalizemikiContextUsage(value: unknown): mikiContextUsage | null {
  const raw = _asRecord(value);
  const used = Number(raw.used_tokens);
  const total = Number(raw.total_tokens);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  const usedTokens = Math.max(0, Math.ceil(used));
  const totalTokens = Math.max(1, Math.ceil(total));
  const compressAt = Number(raw.compress_at_tokens);
  const usedPercent = Number(raw.used_percent);
  return {
    used_tokens: usedTokens,
    total_tokens: totalTokens,
    compress_at_tokens: Number.isFinite(compressAt)
      ? Math.max(0, Math.ceil(compressAt))
      : Math.floor(totalTokens * 0.85),
    used_percent: Number.isFinite(usedPercent)
      ? Math.max(0, Math.min(100, Math.round(usedPercent)))
      : Math.min(100, Math.round((usedTokens / totalTokens) * 100)),
  };
}

function _mikiContextUsage(
  content: string,
  explicitUsage?: unknown,
): mikiContextUsage {
  const normalized = _normalizemikiContextUsage(explicitUsage);
  if (normalized) return normalized;

  const used = Math.max(1, Math.ceil(content.length / 4));
  const total = 80000;
  return {
    used_tokens: used,
    total_tokens: total,
    compress_at_tokens: Math.floor(total * 0.85),
    used_percent: Math.min(100, Math.round((used / total) * 100)),
  };
}

mikiWss.on("connection", (ws, req) => {
  const aliveWs = ws as AliveWebSocket;
  aliveWs.__alive = true;
  ws.on("pong", () => {
    aliveWs.__alive = true;
  });

  const requestUrl = new URL(req.url || "/", "http://127.0.0.1");
  const sessionId = normalizeChatSessionId(
    requestUrl.searchParams.get("session_id"),
  );

  ws.on("message", async (raw) => {
    const data = _parseJsonMessage(
      Buffer.isBuffer(raw) ? raw : Buffer.from(raw.toString()),
    );
    if (!data) {
      _sendmiki(ws, {
        type: "error",
        session_id: sessionId,
        payload: { message: "Invalid JSON payload" },
      });
      return;
    }

    if (data.type === "ping") {
      _sendmiki(ws, { type: "pong", session_id: sessionId });
      return;
    }

    if (data.type !== "message.send") {
      _sendmiki(ws, {
        type: "error",
        session_id: sessionId,
        payload: {
          message: `Unsupported miki message type: ${String(data.type)}`,
        },
      });
      return;
    }

    const payload = _asRecord(data.payload);
    const requestId =
      typeof data.id === "string" && data.id.trim()
        ? data.id
        : crypto.randomUUID();
    const content =
      typeof payload.content === "string" ? payload.content.trim() : "";
    const media = Array.isArray(payload.media)
      ? payload.media.filter((item): item is string => typeof item === "string")
      : [];
    let ephemeralAudio:
      { data: Buffer; mimeType: string; filename?: string } | undefined;
    try {
      ephemeralAudio = _decodeEphemeralAudio(payload.audio);
    } catch (error) {
      _sendmiki(ws, {
        type: "error",
        session_id: sessionId,
        payload: {
          request_id: requestId,
          message: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }
    const rawVoice = _asRecord(payload.voice);
    const voiceProvider =
      rawVoice.provider === "whisper.cpp" || rawVoice.provider === "cloud"
        ? rawVoice.provider
        : undefined;
    const voiceLanguage =
      typeof rawVoice.language === "string"
        ? rawVoice.language.trim().slice(0, 20)
        : undefined;
    const voiceTransport =
      rawVoice.transport === "endpoint" ||
      rawVoice.transport === "cli" ||
      rawVoice.transport === "cloud"
        ? rawVoice.transport
        : undefined;
    const voiceDurationMs = Number(rawVoice.durationMs);
    const voiceLatencyMs = Number(rawVoice.latencyMs);
    const voiceModel =
      typeof rawVoice.model === "string"
        ? rawVoice.model.trim().slice(0, 160)
        : undefined;
    const voiceMetadata: VoiceMessageMetadata | undefined =
      voiceProvider &&
      (rawVoice.source === "microphone" ||
        rawVoice.source === "upload" ||
        rawVoice.source === "channel")
        ? {
            source: rawVoice.source,
            provider: voiceProvider,
            language: voiceLanguage || "auto",
            transcript: content,
            ...(voiceModel ? { model: voiceModel } : {}),
            ...(Number.isFinite(voiceDurationMs) && voiceDurationMs >= 0
              ? { duration_ms: Math.round(voiceDurationMs) }
              : {}),
            ...(Number.isFinite(voiceLatencyMs) && voiceLatencyMs >= 0
              ? { latency_ms: Math.round(voiceLatencyMs) }
              : {}),
            ...(voiceTransport ? { transport: voiceTransport } : {}),
          }
        : undefined;

    if (!content && media.length === 0 && !ephemeralAudio) {
      _sendmiki(ws, {
        type: "error",
        session_id: sessionId,
        payload: {
          request_id: requestId,
          message: "Message content is required",
        },
      });
      return;
    }

    if (ephemeralAudio && rawVoice.provider === "cloud") {
      const audioSupport = await supportsAudioModel(orchestrator.modelName);
      if (audioSupport === false) {
        _sendmiki(ws, {
          type: "error",
          session_id: sessionId,
          payload: {
            request_id: requestId,
            code: "cloud_audio_unsupported",
            message: `The selected cloud model "${orchestrator.modelName}" does not support voice input. Install a local voice model or select an audio-capable cloud model.`,
          },
        });
        return;
      }
    }

    const activeRunId = activeRunIds.get(sessionId);
    if (activeRunId) {
      const queue = pendingFeedback.get(sessionId) ?? [];
      queue.push(content || "Please continue the current task.");
      pendingFeedback.set(sessionId, queue);
      _sendInspectorThought(
        ws,
        sessionId,
        activeRunId,
        "Live feedback received and stored for the next safe checkpoint.",
        "Progress",
      );
      const feedbackReplyId = `feedback-ack-${requestId}`;
      _sendmiki(ws, {
        type: "message.update",
        id: crypto.randomUUID(),
        session_id: sessionId,
        timestamp: Date.now(),
        payload: {
          message_id: feedbackReplyId,
          content: content?.trim()
            ? "I’ve noted your feedback and queued it for this task. I’ll apply it at the next safe checkpoint."
            : "I’m continuing the current task and will share the next update at a safe checkpoint.",
          kind: "normal",
          model_name: orchestrator.modelName,
        },
      });
      return;
    }

    const previousRun = chatRunQueues.get(sessionId) ?? Promise.resolve();
    const queuedBehindActiveRun = activeRunIds.get(sessionId);
    if (queuedBehindActiveRun) {
      _sendInspectorThought(
        ws,
        sessionId,
        queuedBehindActiveRun,
        "Feedback received and queued for the next safe checkpoint; the active step will not be interrupted.",
        "Progress",
      );
    }
    const currentRun = previousRun
      .catch(() => undefined)
      .then(async () => {
        const assistantMessageId = `assistant-${requestId}`;
        activeRunIds.set(sessionId, assistantMessageId);
        let fullResponse = "";
        let artifactContract: ArtifactContract | null = null;
        let lastContextUsage: mikiContextUsage | null = null;
        let providerFailureDetected = false;
        const toolFeedback = _getToolFeedbackConfig();
        const streaming = _getmikiStreamingConfig();
        let lastStreamSentAt = 0;
        let lastStreamSentLength = 0;
        let toolFeedbackCounter = 0;
        const toolInputs = new Map<number, unknown>();
        const toolFeedbackMessageIds = new Map<number, string>();

        if (streaming.enabled) {
          _sendmiki(ws, { type: "typing.start", session_id: sessionId });
          _sendmiki(ws, {
            type: "message.create",
            id: crypto.randomUUID(),
            session_id: sessionId,
            timestamp: Date.now(),
            payload: {
              message_id: assistantMessageId,
              run_id: assistantMessageId,
              content: "",
              placeholder: true,
              model_name: orchestrator.modelName,
            },
          });
        }
        _sendmiki(ws, {
          type: "node.run_start",
          id: crypto.randomUUID(),
          session_id: sessionId,
          timestamp: Date.now(),
          payload: { run_id: assistantMessageId, objective: content },
        });
        if (voiceProvider) {
          const duration = Number.isFinite(voiceDurationMs)
            ? `, ${Math.round(Math.max(0, voiceDurationMs))} ms audio`
            : "";
          const latency = Number.isFinite(voiceLatencyMs)
            ? `, ${Math.round(Math.max(0, voiceLatencyMs))} ms transcription`
            : "";
          _sendInspectorThought(
            ws,
            sessionId,
            assistantMessageId,
            `Voice transcription received from whisper.cpp (${voiceTransport || "configured runtime"}${voiceLanguage ? `, language ${voiceLanguage}` : ""}${duration}${latency}). The transcript is being sent through the standard model route.`,
            "Progress",
          );
        }

        const effectiveContent =
          content || "Please process the attached voice message.";
        const messageForAgent =
          media.length > 0
            ? `${effectiveContent}\n\nAttached media:\n${media.join("\n")}`.trim()
            : effectiveContent;
        artifactContract = _detectArtifactContract(
          messageForAgent,
          workspaceDir,
        );

        try {
          for await (const chunk of orchestrator.runAgentLoop(
            sessionId,
            messageForAgent,
            undefined,
            {
              feedbackProvider: () => {
                const queued = pendingFeedback.get(sessionId) ?? [];
                pendingFeedback.delete(sessionId);
                return queued;
              },
              imageUrls: media,
              messageId: requestId,
              ...(voiceMetadata ? { voice: voiceMetadata } : {}),
              ...(ephemeralAudio && rawVoice.provider === "cloud"
                ? { audio: ephemeralAudio }
                : {}),
              responseMessageId: assistantMessageId,
              completionGuard: () =>
                artifactContract
                  ? _verifyArtifactContract(artifactContract)
                  : { ok: true },
              maxCompletionRepairs: 2,
            },
          )) {
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(chunk) as Record<string, unknown>;
            } catch {
              event = { type: "stream_chunk", content: chunk };
            }

            const eventContextUsage = _normalizemikiContextUsage(
              event.context_usage,
            );
            if (eventContextUsage) {
              lastContextUsage = eventContextUsage;
            }

            if (event.type === "stream_chunk") {
              fullResponse +=
                typeof event.content === "string" ? event.content : "";
              const now = Date.now();
              const grewEnough =
                fullResponse.length - lastStreamSentLength >=
                streaming.minGrowthChars;
              const throttleElapsed =
                now - lastStreamSentAt >= streaming.throttleMs;
              if (
                streaming.enabled &&
                fullResponse.length > 0 &&
                (grewEnough || throttleElapsed)
              ) {
                lastStreamSentAt = now;
                lastStreamSentLength = fullResponse.length;
                _sendmiki(ws, {
                  type: "message.update",
                  id: crypto.randomUUID(),
                  session_id: sessionId,
                  timestamp: now,
                  payload: {
                    message_id: assistantMessageId,
                    run_id: assistantMessageId,
                    content: fullResponse,
                    kind: "normal",
                    model_name: orchestrator.modelName,
                    context_usage: _mikiContextUsage(
                      fullResponse,
                      lastContextUsage,
                    ),
                  },
                });
              }
              continue;
            }

            if (event.type === "completion_guard_failed") {
              // The previous model turn may have streamed a provisional
              // "incomplete" status before the repair turn created the files.
              // Clear it so a successful repair cannot inherit stale failure
              // text in the final user-facing reply.
              fullResponse = "";
              lastStreamSentLength = 0;
              const missing = Array.isArray(event.missing)
                ? event.missing.filter(
                    (item): item is string => typeof item === "string",
                  )
                : [];
              _sendInspectorThought(
                ws,
                sessionId,
                assistantMessageId,
                `Completion verification found missing artifacts (${missing.join(", ") || "required files"}). Starting repair attempt ${String(event.attempt || "1")} before allowing completion.`,
                "Verification",
              );
              continue;
            }

            if (event.type === "provider_error") {
              providerFailureDetected = true;
              const diagnostic = _asRecord(event.diagnostic);
              _sendInspectorThought(
                ws,
                sessionId,
                assistantMessageId,
                `The ${String(event.provider || "selected")} provider rejected a request (HTTP ${String(event.status || "unknown")}). Correlation ${String(diagnostic.correlationId || "unavailable")}; the visible reply was kept concise.`,
                "Verification",
              );
              continue;
            }

            if (event.type === "tool_execution_plan") {
              _sendmiki(ws, {
                type: "node.plan",
                id: crypto.randomUUID(),
                session_id: sessionId,
                timestamp: Date.now(),
                payload: {
                  run_id: assistantMessageId,
                  total: event.total,
                  levels: event.levels,
                  parallelizable: event.parallelizable,
                  acceleration_mode: event.acceleration_mode,
                  max_parallel_tool_calls: event.max_parallel_tool_calls,
                  decision_pattern: event.decision_pattern,
                  speed_class: event.speed_class,
                  expected_latency: event.expected_latency,
                  verification_depth: event.verification_depth,
                },
              });
              _sendInspectorThought(
                ws,
                sessionId,
                assistantMessageId,
                `Prepared ${Number(event.total) || 1} execution step${Number(event.total) === 1 ? "" : "s"} before replying.`,
                "Plan",
              );
              continue;
            }

            if (event.type === "tool_call") {
              const invocationIndex = Number(event.invocation_index ?? 0);
              const toolInput = event.input;
              toolInputs.set(invocationIndex, toolInput);
              const nodeId = `${assistantMessageId}-node-${invocationIndex}`;
              _sendmiki(ws, {
                type: "node.spawn",
                id: crypto.randomUUID(),
                session_id: sessionId,
                timestamp: Date.now(),
                payload: {
                  run_id: assistantMessageId,
                  node_id: nodeId,
                  node_type: "tool",
                  label: event.tool,
                  status: "running",
                  invocation_index: invocationIndex,
                  level: event.level,
                  parallel: event.parallel,
                  input: toolInput,
                  action: _toolActionDescription(event.tool, toolInput),
                },
              });
              _sendInspectorThought(
                ws,
                sessionId,
                assistantMessageId,
                _toolActionDescription(event.tool, toolInput),
                "Action",
              );

              if (!toolFeedback.enabled) {
                // Tool Feedback is disabled: skip emitting a chat execution
                // note, per the tool_feedback.enabled setting from the config
                // UI. The node graph event above still fires regardless, since
                // it drives a separate monitoring surface, not the chat log.
                continue;
              }

              const argsPreview = _previewToolArgs(
                event.input,
                toolFeedback.maxArgsLength,
              );
              const toolCallPayload = {
                id: crypto.randomUUID(),
                type: "function",
                function: {
                  name: event.tool,
                  arguments: argsPreview,
                },
                extra_content: {
                  tool_feedback_explanation: _toolActionDescription(
                    event.tool,
                    toolInput,
                  ),
                },
              };

              if (toolFeedback.separateMessages) {
                // Each tool feedback update gets its own chat message instead
                // of reusing the streaming placeholder/progress message.
                toolFeedbackCounter += 1;
                const toolMessageId = `${assistantMessageId}-tool-${toolFeedbackCounter}`;
                toolFeedbackMessageIds.set(invocationIndex, toolMessageId);
                _sendmiki(ws, {
                  type: "message.create",
                  id: crypto.randomUUID(),
                  session_id: sessionId,
                  timestamp: Date.now(),
                  payload: {
                    message_id: toolMessageId,
                    run_id: assistantMessageId,
                    content: "",
                    kind: "tool_calls",

                    tool_calls: [toolCallPayload],
                    model_name: orchestrator.modelName,
                  },
                });
              } else {
                _sendmiki(ws, {
                  type: "message.update",
                  id: crypto.randomUUID(),
                  session_id: sessionId,
                  timestamp: Date.now(),
                  payload: {
                    message_id: assistantMessageId,
                    run_id: assistantMessageId,
                    content: fullResponse,
                    kind: "tool_calls",
                    tool_calls: [toolCallPayload],
                  },
                });
              }
              continue;
            }

            if (event.type === "tool_retry") {
              const nodeId = `${assistantMessageId}-node-${event.invocation_index ?? 0}`;
              _sendInspectorThought(
                ws,
                sessionId,
                assistantMessageId,
                `Retrying ${String(event.tool || "the action")} (attempt ${Number(event.attempt) || 2}) before continuing.`,
                "Verification",
              );
              _sendmiki(ws, {
                type: "node.update",
                id: crypto.randomUUID(),
                session_id: sessionId,
                timestamp: Date.now(),
                payload: {
                  run_id: assistantMessageId,
                  node_id: nodeId,
                  status: "retrying",
                  attempt: event.attempt,
                  delay_ms: event.delay_ms,
                },
              });
              continue;
            }

            if (event.type === "tool_result") {
              const invocationIndex = Number(event.invocation_index ?? 0);
              const toolInput = toolInputs.get(invocationIndex);
              const nodeId = `${assistantMessageId}-node-${invocationIndex}`;
              const resultDescription = _toolResultDescription(
                event.tool,
                toolInput,
                event.ok === true,
                event.output,
                event.duration_ms,
                toolFeedback.maxArgsLength,
              );
              _sendmiki(ws, {
                type: "node.complete",
                id: crypto.randomUUID(),
                session_id: sessionId,
                timestamp: Date.now(),
                payload: {
                  run_id: assistantMessageId,
                  node_id: nodeId,
                  status: event.ok ? "completed" : "failed",
                  ok: event.ok,
                  duration_ms: event.duration_ms,
                  action: _toolActionDescription(event.tool, toolInput),
                  result_message: resultDescription,
                  output_preview: _previewToolOutput(
                    event.output,
                    toolFeedback.maxArgsLength,
                  ),
                },
              });
              _sendInspectorThought(
                ws,
                sessionId,
                assistantMessageId,
                resultDescription,
                event.ok === true ? "Verification" : "Progress",
              );

              if (toolFeedback.enabled) {
                const messageId = toolFeedback.separateMessages
                  ? toolFeedbackMessageIds.get(invocationIndex)
                  : assistantMessageId;
                if (messageId) {
                  _sendmiki(ws, {
                    type: "message.update",
                    id: crypto.randomUUID(),
                    session_id: sessionId,
                    timestamp: Date.now(),
                    payload: {
                      message_id: messageId,
                      run_id: assistantMessageId,
                      content: _toolResultDescription(
                        event.tool,
                        toolInput,
                        event.ok === true,
                        event.output,
                        event.duration_ms,
                        toolFeedback.maxArgsLength,
                      ),
                      kind: "tool_calls",
                      tool_calls: [
                        {
                          id: crypto.randomUUID(),
                          type: "function",
                          function: {
                            name: event.tool,
                            arguments: _previewToolArgs(
                              toolInput,
                              toolFeedback.maxArgsLength,
                            ),
                          },
                          extra_content: {
                            tool_feedback_explanation: _toolResultDescription(
                              event.tool,
                              toolInput,
                              event.ok === true,
                              event.output,
                              event.duration_ms,
                              toolFeedback.maxArgsLength,
                            ),
                          },
                        },
                      ],
                    },
                  });
                }
              }
              continue;
            }

            if (event.type === "tool_concurrency_metrics") {
              _sendmiki(ws, {
                type: "node.metrics",
                id: crypto.randomUUID(),
                session_id: sessionId,
                timestamp: Date.now(),
                payload: {
                  run_id: assistantMessageId,
                  stats: event.stats,
                  locks: event.locks,
                },
              });
              continue;
            }

            if (event.type === "error") {
              throw new Error(
                typeof event.content === "string"
                  ? event.content
                  : "Agent error",
              );
            }
          }

          let finalRunStatus:
            "completed" | "completed_with_warning" | "failed" =
            providerFailureDetected ? "failed" : "completed";
          if (providerFailureDetected && !fullResponse.trim()) {
            fullResponse = "I couldn’t complete that request this time.";
          }
          if (artifactContract) {
            const verification = _verifyArtifactContract(artifactContract);
            _sendInspectorThought(
              ws,
              sessionId,
              assistantMessageId,
              verification.ok
                ? `Verified required ${artifactContract.label} files: ${artifactContract.required.join(", ")}.`
                : `Required ${artifactContract.label} files are still missing or empty: ${[...verification.missing, ...verification.invalid].join(", ")}.`,
              "Verification",
            );
            finalRunStatus = _reconcileArtifactOutcome(
              verification,
              providerFailureDetected,
            );
            if (!verification.ok) {
              fullResponse = `I started the ${artifactContract.label}, but it is not complete yet. ${[...verification.missing, ...verification.invalid].join(", ")} still needs attention.`;
            } else if (providerFailureDetected) {
              fullResponse = `Completed and verified the required ${artifactContract.label} files: ${artifactContract.required.join(", ")}. A provider warning occurred while preparing the final response; see the run diagnostics.`;
            } else if (
              !fullResponse.trim() ||
              /not complete yet|still needs attention|missing or empty/i.test(
                fullResponse,
              )
            ) {
              fullResponse = `Completed and verified the required ${artifactContract.label} files: ${artifactContract.required.join(", ")}.`;
            }
          }

          _sendmiki(ws, {
            type: streaming.enabled ? "message.update" : "message.create",
            id: crypto.randomUUID(),
            session_id: sessionId,
            timestamp: Date.now(),
            payload: {
              message_id: assistantMessageId,
              run_id: assistantMessageId,
              content: fullResponse,
              kind: "normal",
              model_name: orchestrator.modelName,
              context_usage: _mikiContextUsage(fullResponse, lastContextUsage),
            },
          });
          if (fullResponse.trim()) {
            _sendInspectorThought(
              ws,
              sessionId,
              assistantMessageId,
              "The final user-facing reply was prepared after the execution checks.",
              "Progress",
            );
          }
          if (streaming.enabled) {
            _sendmiki(ws, { type: "typing.stop", session_id: sessionId });
          }
          _sendmiki(ws, {
            type: "node.run_end",
            id: crypto.randomUUID(),
            session_id: sessionId,
            timestamp: Date.now(),
            payload: { run_id: assistantMessageId, status: finalRunStatus },
          });
        } catch (err: unknown) {
          const safeError = getErrorMessage(err);
          _sendInspectorThought(
            ws,
            sessionId,
            assistantMessageId,
            `The run stopped before completion: ${safeError}`,
            "Verification",
          );
          _sendmiki(ws, {
            type: "message.update",
            id: crypto.randomUUID(),
            session_id: sessionId,
            timestamp: Date.now(),
            payload: {
              message_id: assistantMessageId,
              run_id: assistantMessageId,
              content:
                fullResponse.trim() ||
                "I couldn’t complete that request this time.",
              kind: "normal",
              model_name: orchestrator.modelName,
            },
          });
          if (streaming.enabled) {
            _sendmiki(ws, { type: "typing.stop", session_id: sessionId });
          }
          _sendmiki(ws, {
            type: "error",
            session_id: sessionId,
            payload: {
              request_id: requestId,
              message: safeError,
            },
          });
          _sendmiki(ws, {
            type: "node.run_end",
            id: crypto.randomUUID(),
            session_id: sessionId,
            timestamp: Date.now(),
            payload: {
              run_id: assistantMessageId,
              status: "failed",
              error: getErrorMessage(err),
            },
          });
        } finally {
          if (activeRunIds.get(sessionId) === assistantMessageId) {
            activeRunIds.delete(sessionId);
          }
          if (!activeRunIds.has(sessionId)) {
            const queuedCount = pendingFeedback.get(sessionId)?.length ?? 0;
            if (queuedCount > 0) {
              _sendInspectorThought(
                ws,
                sessionId,
                assistantMessageId,
                `${queuedCount} feedback message${queuedCount === 1 ? "" : "s"} preserved for the next safe checkpoint.`,
                "Progress",
              );
            }
          }
        }
      });
    chatRunQueues.set(sessionId, currentRun);
    void currentRun
      .finally(() => {
        if (chatRunQueues.get(sessionId) === currentRun) {
          chatRunQueues.delete(sessionId);
        }
      })
      .catch(() => undefined);
  });
});

function _clearWSPing(): void {
  if (wsPingTimer) {
    clearInterval(wsPingTimer);
    wsPingTimer = null;
  }
}

_setupWSPing();

wss.on("connection", (ws) => {
  const aliveWs = ws as AliveWebSocket;
  aliveWs.__alive = true;
  ws.on("pong", () => {
    aliveWs.__alive = true;
  });
  let checkpointId: string | null = null;
  let lastSeq = 0;
  let sessionId: string | null = null;
  let currentTaskId: string | null = null;
  let streamDone = false;
  let isResuming = false;

  ws.on("message", async (raw) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw.toString());
      if (typeof data !== "object" || data === null)
        throw new Error("Payload must be an object");
    } catch {
      ws.send(
        JSON.stringify({
          type: "error",
          content: "Invalid JSON payload",
        }),
      );
      return;
    }
    if (typeof data.type !== "string") {
      ws.send(
        JSON.stringify({
          type: "error",
          content: "Missing or invalid 'type' field",
        }),
      );
      return;
    }
    const msg = data as WSMessage;

    // ── resume / replay ──────────────────────────────────────────────────
    if (
      msg.type === "resume" &&
      typeof msg.session_id === "string" &&
      msg.checkpoint_id !== undefined
    ) {
      sessionId = msg.session_id;
      checkpointId = String(msg.checkpoint_id);
      lastSeq = typeof msg.last_sequence === "number" ? msg.last_sequence : 0;
      if (!checkpointId || !sessionId) return;

      isResuming = true;
      try {
        ws.send(
          JSON.stringify({
            type: "resume",
            session_id: sessionId,
            checkpoint_id: checkpointId,
            last_sequence: lastSeq,
            replaying: true,
          }),
        );
        const chunks = _getStreamChunks(sessionId, checkpointId, lastSeq);
        for (const c of chunks) {
          ws.send(c.chunk);
        }
      } finally {
        isResuming = false;
      }
      return;
    }

    // ── cancel task ───────────────────────────────────────────────────────
    if (msg.type === "cancel_task" && typeof msg.task_id === "string") {
      const cancelled = orchestrator.cancelTask(msg.task_id);
      ws.send(
        JSON.stringify({
          type: "task_status",
          task_id: msg.task_id,
          status: cancelled ? "cancelled" : "error",
        }),
      );
      return;
    }

    // ── normal chat message ───────────────────────────────────────────────
    const sid: string =
      typeof msg.session_id === "string" ? msg.session_id : "";
    const message: string = typeof msg.message === "string" ? msg.message : "";
    if (!sid || !message) {
      ws.send(
        JSON.stringify({
          type: "error",
          content: "Missing session_id or message",
        } as WSMessage),
      );
      return;
    }
    sessionId = sid;

    // Enqueue task with priority (pass to agent loop which will manage the lifecycle)
    const task = orchestrator.taskQueue.enqueue(sessionId, message);
    if (!task) {
      ws.send(
        JSON.stringify({
          type: "error",
          content: "Task queue is full. Please try again later.",
        } as WSMessage),
      );
      return;
    }
    currentTaskId = task.id;
    streamDone = false;

    persistAgentTask(task);

    // Notify client of queue status
    if (orchestrator.concurrentManager.isAtCapacity()) {
      ws.send(
        JSON.stringify({
          type: "task_status",
          task_id: task.id,
          status: "queued",
          position: orchestrator.taskQueue.getPosition(task.id),
        }),
      );
    } else {
      ws.send(
        JSON.stringify({
          type: "task_status",
          task_id: task.id,
          status: "queued",
          message: "Task will start shortly",
        }),
      );
    }

    checkpointId = crypto.randomUUID();
    lastSeq = 0;
    let seq = 0;
    ws.send(
      JSON.stringify({
        type: "stream_checkpoint",
        session_id: sessionId,
        checkpoint_id: checkpointId,
        sequence: -1,
      }),
    );
    try {
      // Pass the already-enqueued task to agent loop (it will use it directly)
      for await (const chunk of orchestrator.runAgentLoopWithTask(
        sessionId,
        message,
        task,
      )) {
        const currentSequence = seq++;
        let envelopeObj: Record<string, unknown>;
        if (typeof chunk === "string") {
          try {
            const parsed = JSON.parse(chunk) as unknown;
            envelopeObj =
              parsed && typeof parsed === "object"
                ? { ...(parsed as Record<string, unknown>) }
                : { type: "stream_chunk", content: chunk };
          } catch {
            envelopeObj = { type: "stream_chunk", content: chunk };
          }
        } else if (chunk && typeof chunk === "object") {
          envelopeObj = { ...(chunk as Record<string, unknown>) };
        } else {
          envelopeObj = { type: "stream_chunk", content: String(chunk) };
        }
        envelopeObj.checkpoint_id = checkpointId;
        envelopeObj.sequence = currentSequence;
        const envelopeStr = JSON.stringify(envelopeObj);
        ws.send(envelopeStr);
        lastSeq = currentSequence;
        _saveStreamChunk(
          sessionId!,
          checkpointId!,
          currentSequence,
          envelopeStr,
        );
      }
      const doneEnvelope = {
        type: "stream_done",
        session_id: sessionId,
        checkpoint_id: checkpointId,
        sequence: seq,
      };
      _saveStreamChunk(
        sessionId!,
        checkpointId!,
        seq,
        JSON.stringify(doneEnvelope),
      );
      ws.send(JSON.stringify(doneEnvelope));
      streamDone = true;
    } catch (err: unknown) {
      let errEnvelope = JSON.stringify({
        type: "error",
        content: getErrorMessage(err),
      } as WSMessage);
      try {
        const parsed = JSON.parse(errEnvelope) as Record<string, unknown>;
        parsed.session_id = sessionId;
        parsed.checkpoint_id = checkpointId;
        parsed.sequence = seq;
        errEnvelope = JSON.stringify(parsed);
      } catch {
        // Keep the original error envelope if defensive annotation fails.
      }
      _saveStreamChunk(sessionId!, checkpointId!, seq, errEnvelope);
      ws.send(errEnvelope);
      streamDone = true;
    }
  });

  ws.on("close", () => {
    // Only cancel task on close if stream is not done and we are not in the resume handshake.
    if (currentTaskId && !streamDone && !isResuming) {
      orchestrator.cancelTask(currentTaskId);
    }
  });

  ws.on("error", (err) => {
    console.warn(`[WS] Connection error: ${getErrorMessage(err)}`);
  });
});

// Enhanced API endpoints with circuit breaker protection
app.get("/", (_req, res) => {
  res.json({
    service: "Miki Core API",
    version: "1.0.0",
    status: "running",
    provider: orchestrator.provider,
    requestId: (_req as AuthenticatedRequest).requestId,
  });
});

function uniqueResolvedPaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => path.resolve(item)))];
}

function resolveDashboardDirs(): string[] {
  const candidates: string[] = [];
  const runtimeRoot = readMikiEnv("MIKI_RUNTIME_ROOT");
  if (runtimeRoot) {
    candidates.push(
      path.join(runtimeRoot, "packages", "ui", "frontend", "dist"),
    );
  }
  candidates.push(
    path.join(workspaceDir, "packages", "ui", "frontend", "dist"),
  );
  return uniqueResolvedPaths(candidates);
}

// Serve the React dashboard build from the packaged runtime first, then dev dist.
const webDirs = resolveDashboardDirs();
let cachedWebIndex: { filePath: string; mtimeMs: number; html: string } | null =
  null;

function loadDashboardIndex(): string | null {
  for (const webDir of webDirs) {
    const webIndexPath = path.join(webDir, "index.html");
    try {
      const stat = fs.statSync(webIndexPath);
      if (
        cachedWebIndex?.filePath === webIndexPath &&
        cachedWebIndex.mtimeMs === stat.mtimeMs
      ) {
        return cachedWebIndex.html;
      }
      const html = fs.readFileSync(webIndexPath, "utf-8");
      cachedWebIndex = { filePath: webIndexPath, mtimeMs: stat.mtimeMs, html };
      return html;
    } catch {
      // Try the next candidate.
    }
  }
  cachedWebIndex = null;
  return null;
}

for (const webDir of webDirs) {
  app.use(express.static(webDir));
  app.use("/web", express.static(webDir));
}
app.get("/web", (_req, res) => {
  const html = loadDashboardIndex();
  if (html) {
    res.type("html").send(html);
  } else {
    res
      .status(404)
      .type("html")
      .send(
        "<h1>Dashboard not found. Run 'npm run build' in packages/ui/frontend</h1>",
      );
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "core",
    requestId: (_req as AuthenticatedRequest).requestId,
  });
});

app.get("/status", (_req, res) => {
  let hb: Record<string, unknown> | null = null;
  if (orchestrator.heartbeat) {
    const h = orchestrator.heartbeat as unknown as Record<string, unknown>;
    hb = {
      running: h._running,
      cycle: h._cycle,
      idle_minutes:
        Math.round(
          ((Date.now() / 1000 - ((h._lastUserInteraction as number) || 0)) /
            60) *
            10,
        ) / 10,
      token_budget: h._tokenBudget,
    };
  }
  const agentConfig = (orchestrator.config.agent || {}) as {
    name?: string;
    project?: string;
  };
  res.json({
    status: "idle",
    agent: agentConfig.name || "Miki",
    project: agentConfig.project || "Miki",
    llm_provider: orchestrator.provider,
    llm_model: orchestrator.modelName,
    heartbeat: hb,
    requestId: (_req as AuthenticatedRequest).requestId,
  });
});

app.post("/agent/route-preview", async (req, res) => {
  try {
    const body = (req.body || {}) as { message?: unknown };
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message) {
      return res.status(400).json({
        success: false,
        error: "message is required",
        requestId: (req as AuthenticatedRequest).requestId,
      });
    }
    const decision = orchestrator.routeAgentTask(message);
    const capabilityReport = analyzePlanCapabilities(
      message,
      {
        skills: await skillLoader.getAllSkillsMetadata(),
        tools: orchestrator.tools.getToolDefinitions(),
      },
      `${decision.profile.complexity}/${decision.profile.executionStyle}`,
    );
    const acceleration = buildWorkflowAccelerationPlan(
      decision.profile,
      decision,
      {
        maxParallelToolCalls:
          orchestrator.concurrencyConfig.maxParallelToolCalls ??
          orchestrator.concurrencyConfig.maxConcurrentTasks,
      },
    );
    const decisionPattern = buildWorkflowDecisionPattern(
      decision.profile,
      decision,
      acceleration,
    );
    return res.json({
      success: true,
      data: decision,
      summary: summarizeAgentRoute(decision),
      acceleration,
      decisionPattern,
      capabilityReport,
      requestId: (req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    return res.status(500).json({
      success: false,
      error: getErrorMessage(e),
      requestId: (req as AuthenticatedRequest).requestId,
    });
  }
});

function isHttpRequestAuthorized(req: Request): boolean {
  const apiKey = apiKeyFromHeaders(req.headers);
  const apiKeyAuth = isApiKeyRequestAuthenticated(req.headers);
  if (process.env.MIKI_DEBUG_AUTH === "true") {
    let expectedLength = 0;
    try {
      expectedLength = getRequiredApiKeySecret().length;
    } catch {
      // Configuration errors are represented by the auth result.
    }
    console.warn(
      `[auth-debug] path=${req.path} headerPresent=${Boolean(apiKey)} headerLength=${apiKey.length} expectedLength=${expectedLength} apiKeyAuth=${apiKeyAuth}`,
    );
  }
  if (apiKeyAuth) return true;
  if (launcherRuntimeAuth?.isDashboardAuthenticated(req.headers)) return true;
  return false;
}

// (#94) Whether this request's real client address (see `trust proxy:
// "loopback"` above, which makes req.ip resolve through the gateway's
// X-Forwarded-For) is the local machine or a remote one. Used to enforce
// config/tools.yaml's runtime.exec.allow_remote in ShellExecutor -- see
// packages/core/src/tools/executor/call-context.ts for how this is threaded
// down to the actual shell execution without changing agent.ts.
function resolveCallOrigin(req: Request): CallOrigin {
  const ip = req.ip || req.socket.remoteAddress || "";
  return ip && isLoopbackAddress(ip) ? "local" : "remote";
}

function requireHttpAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isHttpRequestAuthorized(req)) {
    next();
    return;
  }
  res.status(401).json({
    error: "Unauthorized",
    detail: "Valid API key or dashboard session required",
  });
}

app.get("/tools", requireHttpAuth, async (_req, res) => {
  try {
    res.json({
      tools: orchestrator.tools.getToolDefinitions(),
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({
      detail: getErrorMessage(e),
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  }
});

/**
 * POST /tools/:name/call
 * Execute a specific tool directly (bypasses agent loop).
 */
app.post("/tools/:name/call", requireHttpAuth, async (req, res) => {
  try {
    const { name } = req.params;
    const { args, session_id, caller } = req.body as {
      args?: Record<string, unknown>;
      session_id?: string;
      caller?: string;
    };

    // Check session-based permissions if session_id is provided
    if (session_id && !isToolEnabledForSession(session_id, name)) {
      const decision = getToolPermissionDecision(session_id, name);
      const denial = recordToolPermissionDenial(session_id, decision, {
        actor: caller === "mcp" ? "mcp" : "api",
        requestId: (req as AuthenticatedRequest).requestId,
        args,
      });
      try {
        permissionAuditLog.record({
          type: "tool.execute",
          actor: caller === "mcp" ? "mcp" : "api",
          subject: name,
          requestId: (req as AuthenticatedRequest).requestId,
          details: {
            action: "tool.denied",
            sessionId: session_id,
            toolName: decision.toolName,
            reason: decision.reason,
            policy: decision.source,
            deniedAt: denial.deniedAt,
          },
        });
      } catch (error) {
        console.warn("[API] tool denial audit failed:", error);
      }
      return res.status(403).json({
        success: false,
        error: `Tool '${name}' is disabled for this session`,
        denial: {
          toolName: decision.toolName,
          decision: "denied",
          reason: decision.reason,
          policy: decision.source,
          sessionId: session_id,
          deniedAt: denial.deniedAt,
        },
        requestId: (req as AuthenticatedRequest).requestId,
      });
    }

    const governance = orchestrator.skillGovernance;
    if (governance) {
      const violations = governance.getRuleViolations(name, args || {});
      const blocked = violations.find((v) => v.action === "block");
      if (blocked) {
        try {
          permissionAuditLog.record({
            type: "tool.execute",
            actor: "api",
            subject: name,
            requestId: (req as AuthenticatedRequest).requestId,
            details: {
              action: "tool.blocked",
              toolName: name,
              reason: blocked.description,
              violations,
            },
          });
        } catch (error) {
          console.warn("[API] tool block audit failed:", error);
        }
        res.status(403).json({
          success: false,
          error: `Tool call blocked by governance rule: ${blocked.description}`,
          violations,
          requestId: (req as AuthenticatedRequest).requestId,
        });
        return;
      }
    }

    const result = await runWithCallOrigin(resolveCallOrigin(req), () =>
      orchestrator.tools.executeToolStructured(name, args || {}),
    );
    res.json({
      ...result,
      requestId: (req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({
      success: false,
      error: getErrorMessage(e),
      requestId: (req as AuthenticatedRequest).requestId,
    });
  }
});

// Enhanced chat endpoint with circuit breaker
async function handleChatRequest(req: Request, res: Response): Promise<void> {
  if (WEB_UI_CHAT_DISABLED) {
    res.status(403).json({
      detail:
        "Web UI chat is disabled - use a connected platform (Telegram, Discord, etc.)",
      requestId: (req as AuthenticatedRequest).requestId,
    });
    return;
  }
  const { session_id, message } = req.body;
  if (!session_id || !message) {
    if (!res.headersSent) {
      res.status(422).json({
        detail: "session_id and message are required",
        requestId: (req as AuthenticatedRequest).requestId,
      });
    }
    return;
  }
  try {
    let fullResponse = "";
    await runWithCallOrigin(resolveCallOrigin(req), async () => {
      for await (const chunk of orchestrator.runAgentLoop(
        session_id,
        message,
      )) {
        const data = JSON.parse(chunk);
        if (data.type === "stream_chunk") {
          fullResponse += data.content;
        }
      }
    });
    if (!res.headersSent) {
      res.json({
        status: "success",
        response: fullResponse,
        requestId: (req as AuthenticatedRequest).requestId,
      });
    }
  } catch (e: unknown) {
    if (!res.headersSent) {
      res.status(500).json({
        detail: getErrorMessage(e),
        requestId: (req as AuthenticatedRequest).requestId,
      });
    }
  }
}

app.post("/chat", requireHttpAuth, handleChatRequest);

// ... rest of the endpoints remain the same but with requestId added
app.get("/improvement/status", requireHttpAuth, (_req, res) => {
  try {
    const si = orchestrator.selfImprovement.getStatus();
    const sg = orchestrator.skillGovernance.getStatus();
    res.json({
      self_improvement: si,
      skill_governance: sg,
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.get("/improvement/tunings", requireHttpAuth, (_req, res) => {
  try {
    const tunings = orchestrator.selfImprovement.getAccumulatedTunings();
    res.json({
      tunings,
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.post(
  "/improvement/force-reflection",
  requireHttpAuth,
  async (_req, res) => {
    try {
      const result = await orchestrator.selfImprovement.runReflectionCycle({
        force: true,
      });
      res.json({
        success: result !== null && result !== undefined,
        result,
        requestId: (_req as AuthenticatedRequest).requestId,
      });
    } catch (e: unknown) {
      res.status(500).json({ detail: getErrorMessage(e) });
    }
  },
);

app.post(
  "/improvement/force-optimization",
  requireHttpAuth,
  async (_req, res) => {
    try {
      const body = (_req.body || {}) as Record<string, unknown>;
      const result = await orchestrator.selfImprovement.runOptimizationCycle({
        force: true,
        apply: body["apply"] === true || body["apply_code"] === true,
      });
      res.json({
        success: result !== null && result !== undefined,
        result,
        requestId: (_req as AuthenticatedRequest).requestId,
      });
    } catch (e: unknown) {
      res.status(500).json({ detail: getErrorMessage(e) });
    }
  },
);

app.post("/improvement/force-tuning", requireHttpAuth, async (_req, res) => {
  try {
    const tuning = await orchestrator.selfImprovement.runPromptTuningCycle({
      force: true,
    });
    res.json({
      success: tuning !== null && tuning !== undefined,
      tuning,
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

// ── Task Queue Endpoints ─────────────────────────────────────────────────
app.get("/tasks", requireHttpAuth, (_req, res) => {
  try {
    const stats = orchestrator.getTaskQueueStats();
    res.json({
      stats,
      pending: orchestrator.taskQueue.getPendingTasks(),
      running: orchestrator.taskQueue.getRunningTasks(),
      completed: orchestrator.taskQueue.getCompletedTasks().slice(-20),
      scheduled: orchestrator.getScheduledTasks(),
      scheduled_history: orchestrator.getScheduledTaskHistory(50),
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.post("/tasks", requireHttpAuth, (_req, res) => {
  try {
    const body = (_req.body || {}) as Record<string, unknown>;
    const sessionId =
      typeof body["session_id"] === "string"
        ? body["session_id"]
        : typeof body["sessionId"] === "string"
          ? body["sessionId"]
          : "";
    const message = typeof body["message"] === "string" ? body["message"] : "";
    const priority =
      typeof body["priority"] === "number" ? body["priority"] : undefined;

    if (!sessionId || !message) {
      res.status(400).json({ detail: "session_id and message are required" });
      return;
    }

    const task = orchestrator.enqueueTask(sessionId, message, priority);
    if (!task) {
      res.status(429).json({ detail: "Task queue is full" });
      return;
    }

    persistAgentTask(task);
    res.status(202).json({
      task,
      position: orchestrator.taskQueue.getPosition(task.id),
      stats: orchestrator.getTaskQueueStats(),
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.get("/tasks/scheduled", requireHttpAuth, (_req, res) => {
  try {
    res.json({
      scheduled: orchestrator.getScheduledTasks(),
      history: orchestrator.getScheduledTaskHistory(100),
      stats: orchestrator.getTaskSchedulerStats(),
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.post("/tasks/scheduled", requireHttpAuth, (_req, res) => {
  try {
    const body = (_req.body || {}) as Record<string, unknown>;
    const sessionId =
      typeof body["session_id"] === "string"
        ? body["session_id"]
        : typeof body["sessionId"] === "string"
          ? body["sessionId"]
          : "";
    const message = typeof body["message"] === "string" ? body["message"] : "";
    const cronExpression =
      typeof body["cron_expression"] === "string"
        ? body["cron_expression"]
        : typeof body["cronExpression"] === "string"
          ? body["cronExpression"]
          : undefined;
    const runAtRaw = body["run_at"] ?? body["runAt"];
    const maxAttemptsRaw = body["max_attempts"] ?? body["maxAttempts"];
    const maxAttempts =
      typeof maxAttemptsRaw === "number" && Number.isFinite(maxAttemptsRaw)
        ? Math.max(1, Math.floor(maxAttemptsRaw))
        : undefined;
    let runAt: number | undefined;
    if (typeof runAtRaw === "number") {
      runAt = runAtRaw;
    } else if (typeof runAtRaw === "string") {
      const parsed = Date.parse(runAtRaw);
      runAt = Number.isNaN(parsed) ? undefined : parsed;
    }

    if (!sessionId || !message || (!cronExpression && runAt === undefined)) {
      res.status(400).json({
        detail:
          "session_id, message, and either cron_expression or run_at are required",
      });
      return;
    }

    const scheduled = orchestrator.scheduleTask(
      sessionId,
      message,
      cronExpression,
      runAt,
      { maxAttempts },
    );
    res.status(202).json({
      scheduled,
      stats: orchestrator.getTaskSchedulerStats(),
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.delete(
  "/tasks/scheduled/:scheduledTaskId",
  requireHttpAuth,
  (_req, res) => {
    const scheduledTaskId = _req.params["scheduledTaskId"];
    try {
      const cancelled = orchestrator.cancelScheduledTask(scheduledTaskId);
      res.json({
        success: cancelled,
        requestId: (_req as AuthenticatedRequest).requestId,
      });
    } catch (e: unknown) {
      res.status(500).json({ detail: getErrorMessage(e) });
    }
  },
);

app.get("/tasks/session/:sessionId", requireHttpAuth, (_req, res) => {
  const sessionId = _req.params["sessionId"];
  try {
    const tasks = orchestrator.getTasksBySession(sessionId);
    res.json({
      tasks,
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.get("/tasks/:taskId", requireHttpAuth, (_req, res) => {
  const taskId = _req.params["taskId"];
  try {
    const task = orchestrator.getTask(taskId);
    if (!task) {
      res.status(404).json({ detail: "Task not found" });
      return;
    }
    res.json({
      task,
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.delete("/tasks/:taskId", requireHttpAuth, (_req, res) => {
  const taskId = _req.params["taskId"];
  try {
    const cancelled = orchestrator.cancelTask(taskId);
    res.json({
      success: cancelled,
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

// ── Model Management Endpoints ─────────────────────────────────────────────
app.get("/models", requireHttpAuth, (_req, res) => {
  try {
    const models = {
      available: settings.getSupportedModels(),
      provider_models: [],
      active_model: orchestrator.modelName,
      provider: orchestrator.provider,
    };
    res.json({ models, requestId: (_req as AuthenticatedRequest).requestId });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.post("/models", requireHttpAuth, (req, res) => {
  const { model_name } = req.body;
  if (!model_name) {
    res.status(400).json({ detail: "model_name is required" });
    return;
  }
  res.json({
    success: true,
    model: model_name,
    requestId: (req as AuthenticatedRequest).requestId,
  });
});

app.delete("/models/:modelName", requireHttpAuth, (req, res) => {
  const { modelName } = req.params;
  if (!modelName) {
    res.status(400).json({ detail: "modelName is required" });
    return;
  }
  res.json({
    success: true,
    requestId: (req as AuthenticatedRequest).requestId,
  });
});

app.put("/models/active", requireHttpAuth, (req, res) => {
  const { model_name } = req.body;
  if (!model_name) {
    res.status(400).json({ detail: "model_name is required" });
    return;
  }
  const isSupported = settings.getSupportedModels().includes(model_name);
  if (!isSupported) {
    res.status(400).json({ detail: `Model '${model_name}' not available` });
    return;
  }
  settings.setModel(model_name);
  orchestrator.modelName = model_name;
  orchestrator.provider = getProviderForModel(model_name);
  res.json({
    success: true,
    active_model: model_name,
    requestId: (req as AuthenticatedRequest).requestId,
  });
});

app.get("/metrics", (_req, res) => {
  const used = process.memoryUsage();
  const uptime = process.uptime();
  res.json({
    memory: {
      rss: used.rss,
      heapUsed: used.heapUsed,
      heapTotal: used.heapTotal,
      external: used.external,
    },
    uptime,
    activeSessions: 0,
    requestId: (_req as AuthenticatedRequest).requestId,
  });
});

// ── System Monitoring Endpoints ──────────────────────────────────────────────
app.get("/system/stats", requireHttpAuth, (_req, res) => {
  try {
    const stats = getSystemStats();
    res.json({
      ...stats,
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.get("/system/health", requireHttpAuth, (_req, res) => {
  try {
    const stats = getSystemStats();
    const isHealthy =
      stats.cpu.usage < 90 &&
      stats.memory.percentage < 90 &&
      stats.processMemory.heapUsed < stats.processMemory.heapTotal * 0.9;
    res.json({
      status: isHealthy ? "healthy" : "degraded",
      timestamp: stats.timestamp,
      cpu_usage: stats.cpu.usage,
      memory_usage: stats.memory.percentage,
      heap_usage: Math.round(
        (stats.processMemory.heapUsed / stats.processMemory.heapTotal) * 100,
      ),
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

// ── MCP in-process server (collocated with ToolRegistry, no HTTP hop) ──────

let mcpClose: (() => Promise<void>) | null = null;

const enableMcp = process.env["ENABLE_MCP"] !== "false";
if (enableMcp) {
  try {
    getRequiredApiKeySecret();
    app.use("/mcp", validateRequiredApiKey);
    app.use("/mcp", (_req, res, next) => {
      const runtimeConfig = orchestrator.config as Record<string, unknown>;
      const tools = runtimeConfig.tools;
      const mcp =
        tools && typeof tools === "object" && !Array.isArray(tools)
          ? (tools as Record<string, unknown>).mcp
          : undefined;
      const enabled =
        !mcp || typeof mcp !== "object" || Array.isArray(mcp)
          ? true
          : (mcp as Record<string, unknown>).enabled !== false;
      if (!enabled) {
        res.status(503).json({
          error: "MCP is disabled in the runtime configuration.",
          code: "mcp_disabled",
        });
        return;
      }
      next();
    });
    mcpClose = mountMcpSessionManager(app, {
      executeTool: (name: string, args: Record<string, unknown>) =>
        runWithCallContext(
          {
            origin: "remote",
            source: "mcp",
            actor: "mcp-session",
          },
          () => orchestrator.tools.executeToolStructured(name, args),
        ),
      workspaceDir,
    });
    console.log(`MCP in-process ready at /mcp with API key auth`);
  } catch (err: unknown) {
    console.warn(
      `MCP in-process skipped: ${getErrorMessage(err)}. Set a strong API_KEY_SECRET before enabling ENABLE_MCP=true.`,
    );
  }
}

server.listen(settings.corePort, settings.coreHost, () => {
  try {
    const entry = globalStartupTimer.end("core.process_start");
    globalMetricsCollector.recordLatency(
      "core_process_start",
      entry.durationMs,
    );
  } catch {
    // Timer is best-effort instrumentation.
  }
  console.log(
    `Core API listening on ${settings.coreHost}:${settings.corePort}`,
  );

  // Telegram long-polling can run forever; ensure we never crash the HTTP server.
  process.on("uncaughtException", (err) => {
    console.error("Uncaught exception:", err);
  });
  process.on("unhandledRejection", (err) => {
    console.error("Unhandled rejection:", err);
  });

  const bootStart = Date.now();

  orchestrator
    .startBackgroundTasks()
    .catch((e: unknown) =>
      console.warn(`Background tasks startup: ${getErrorMessage(e)}`),
    );

  persistentJobRunner.start();
  console.log("Persistent job worker started");

  channelRuntimeManager.startAll();
  console.log(
    `Channel runtime bootstrap completed in ${Date.now() - bootStart}ms (non-blocking)`,
  );
});

let shutdownInProgress = false;

// Enhanced shutdown function
async function shutdown() {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log("Shutting down...");
  _clearWSPing();
  unsubscribeDeliveryOutcome();
  await Promise.all([closeWebSocketServer(wss), closeWebSocketServer(mikiWss)]);
  await closeHttpServer(server, {
    timeoutMs: 5000,
    onForceClose: () =>
      console.warn(
        "HTTP server drain timed out; forcing open connections closed",
      ),
  });
  if (mcpClose) {
    try {
      await mcpClose();
    } catch (e: unknown) {
      console.warn(`MCP close: ${getErrorMessage(e) || e}`);
    }
  }
  try {
    await orchestrator.stopBackgroundTasks();
  } catch (e: unknown) {
    console.warn(`Background tasks shutdown: ${getErrorMessage(e) || e}`);
  }
  try {
    orchestrator.close();
  } catch (e: unknown) {
    console.warn(`Session history shutdown: ${getErrorMessage(e) || e}`);
  }
  await persistentJobRunner.stop();
  channelRuntimeManager.stopAll();
  try {
    if (orchestrator.tools?.browser?.close) {
      await orchestrator.tools.browser.close();
    }
  } catch (e: unknown) {
    console.warn(`Browser close: ${getErrorMessage(e) || e}`);
  }
}

process.on("SIGINT", () => {
  shutdown()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("Shutdown error:", e);
      process.exit(1);
    });
});
process.on("SIGTERM", () => {
  shutdown()
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("Shutdown error:", e);
      process.exit(1);
    });
});
