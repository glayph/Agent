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
import { settings } from "@hiro/config";
import {
  allowedCorsOriginsFromEnv,
  hasExplicitAllowedOrigins,
  isAllowedCorsOrigin,
  normalizeCorsOrigin,
} from "@hiro/config/security";
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
import {
  findRuntimePluginProviderDescriptor,
  listRuntimePluginProviderMetadata,
} from "../plugins/plugin-provider-adapter.js";
import { summarizeAgentRoute } from "../agent-router.js";
import {
  buildWorkflowAccelerationPlan,
  buildWorkflowDecisionPattern,
} from "../workflow-accelerator.js";
import { createSessionRouter } from "./session-router.js";
import { getSystemStats } from "./system-monitoring.js";
import { resolveLiteLLMMasterKey } from "@hiro/config/security";
import { createEnhancementRouter } from "./enhancement-router.js";
import { closeHttpServer, closeWebSocketServer } from "./shutdown-utils.js";
import { globalStartupTimer } from "../performance-budgets.js";
import { globalMetricsCollector } from "../metrics-collector.js";
import { initializeSafetyAtStartup } from "../safety/startup.js";
import { getErrorMessage } from "../errors.js";
import { SqliteAuditLog } from "../audit-log.js";
import { resolveRuntimePaths } from "../paths.js";
import crypto from "crypto";
import {
  getAvailableProviders,
  getProviderById,
  setProviderApiKey,
  getProviderApiKey,
  getConfiguredProviders,
  getActiveProvider,
  getModelsByProvider,
} from "./provider-management.js";
import {
  getRequiredApiKeySecret,
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

globalStartupTimer.start("core.process_start");

const runtimePaths = resolveRuntimePaths();

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
const orchestrator = new AgentOrchestrator(runtimePaths);

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
const launcherCompatRouter = createLauncherCompatRouter({
  orchestrator,
  skillLoader,
  runtimePaths,
  workspaceDir,
  registerRuntimeAuth: (runtimeAuth) => {
    launcherRuntimeAuth = runtimeAuth;
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
});

function persistAgentTask(_task: AgentTask): void {
  // Task persistence is handled in-memory by TaskQueue
}

// Remove the circuit breaker instance — routes use direct error handling
const app = express();
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

function ishiroBearerAuthenticated(request: http.IncomingMessage): boolean {
  const configuredToken = launcherRuntimeAuth?.gethiroToken();
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
  return pathname === "/hiro/ws" && ishiroBearerAuthenticated(request);
}

validateApiKeyConfiguration();
resolveLiteLLMMasterKey({ workspaceDir });
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
      "X-Hiro-WhatsApp-Token",
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

// UI compatibility API used by the bundled dashboard.
app.use("/api", launcherCompatRouter);
app.use("/api/enhancements", enhancementRouter);
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
const hiroWss = new WebSocketServer({
  noServer: true,
  maxPayload: 5 * 1024 * 1024,
});

server.on("upgrade", (request, socket, head) => {
  const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
  const origin = firstHeaderValue(request.headers.origin);
  if (!isAllowedCorsOrigin(origin, currentAllowedCorsOrigins())) {
    rejectUpgrade(socket, 403, "Forbidden");
    return;
  }
  if (pathname === "/ws/chat") {
    if (!isWebSocketUpgradeAuthorized(request, pathname)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
    return;
  }
  if (pathname === "/hiro/ws") {
    if (!isWebSocketUpgradeAuthorized(request, pathname)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    hiroWss.handleUpgrade(request, socket, head, (ws) => {
      hiroWss.emit("connection", ws, request);
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
    for (const server of [wss, hiroWss]) {
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

function _sendhiro(ws: WebSocket, message: Record<string, unknown>): void {
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

interface hiroContextUsage {
  used_tokens: number;
  total_tokens: number;
  compress_at_tokens: number;
  used_percent: number;
}

function _normalizehiroContextUsage(value: unknown): hiroContextUsage | null {
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

function _hiroContextUsage(
  content: string,
  explicitUsage?: unknown,
): hiroContextUsage {
  const normalized = _normalizehiroContextUsage(explicitUsage);
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

hiroWss.on("connection", (ws, req) => {
  const aliveWs = ws as AliveWebSocket;
  aliveWs.__alive = true;
  ws.on("pong", () => {
    aliveWs.__alive = true;
  });

  const url = new URL(req.url || "/hiro/ws", "http://127.0.0.1");
  const sessionId = url.searchParams.get("session_id") || crypto.randomUUID();

  ws.on("message", async (raw) => {
    const data = _parseJsonMessage(
      Buffer.isBuffer(raw) ? raw : Buffer.from(raw.toString()),
    );
    if (!data) {
      _sendhiro(ws, {
        type: "error",
        session_id: sessionId,
        payload: { message: "Invalid JSON payload" },
      });
      return;
    }

    if (data.type === "ping") {
      _sendhiro(ws, { type: "pong", session_id: sessionId });
      return;
    }

    if (data.type !== "message.send") {
      _sendhiro(ws, {
        type: "error",
        session_id: sessionId,
        payload: {
          message: `Unsupported hiro message type: ${String(data.type)}`,
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

    if (!content && media.length === 0) {
      _sendhiro(ws, {
        type: "error",
        session_id: sessionId,
        payload: {
          request_id: requestId,
          message: "Message content is required",
        },
      });
      return;
    }

    const assistantMessageId = `assistant-${requestId}`;
    let fullResponse = "";
    let lastContextUsage: hiroContextUsage | null = null;

    _sendhiro(ws, { type: "typing.start", session_id: sessionId });
    _sendhiro(ws, {
      type: "message.create",
      id: crypto.randomUUID(),
      session_id: sessionId,
      timestamp: Date.now(),
      payload: {
        message_id: assistantMessageId,
        content: "",
        placeholder: true,
        model_name: orchestrator.modelName,
      },
    });

    const messageForAgent =
      media.length > 0
        ? `${content}\n\nAttached media:\n${media.join("\n")}`.trim()
        : content;

    try {
      for await (const chunk of orchestrator.runAgentLoop(
        sessionId,
        messageForAgent,
      )) {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(chunk) as Record<string, unknown>;
        } catch {
          event = { type: "stream_chunk", content: chunk };
        }

        const eventContextUsage = _normalizehiroContextUsage(
          event.context_usage,
        );
        if (eventContextUsage) {
          lastContextUsage = eventContextUsage;
        }

        if (event.type === "stream_chunk") {
          fullResponse +=
            typeof event.content === "string" ? event.content : "";
          _sendhiro(ws, {
            type: "message.update",
            id: crypto.randomUUID(),
            session_id: sessionId,
            timestamp: Date.now(),
            payload: {
              message_id: assistantMessageId,
              content: fullResponse,
              model_name: orchestrator.modelName,
              context_usage: _hiroContextUsage(fullResponse, lastContextUsage),
            },
          });
          continue;
        }

        if (event.type === "tool_call") {
          _sendhiro(ws, {
            type: "message.update",
            id: crypto.randomUUID(),
            session_id: sessionId,
            timestamp: Date.now(),
            payload: {
              message_id: assistantMessageId,
              content: fullResponse,
              kind: "tool_calls",
              tool_calls: [
                {
                  id: crypto.randomUUID(),
                  type: "function",
                  function: {
                    name: event.tool,
                    arguments: JSON.stringify(event.input || {}),
                  },
                },
              ],
            },
          });
          continue;
        }

        if (event.type === "error") {
          throw new Error(
            typeof event.content === "string" ? event.content : "Agent error",
          );
        }
      }

      _sendhiro(ws, {
        type: "message.update",
        id: crypto.randomUUID(),
        session_id: sessionId,
        timestamp: Date.now(),
        payload: {
          message_id: assistantMessageId,
          content: fullResponse,
          model_name: orchestrator.modelName,
          context_usage: _hiroContextUsage(fullResponse, lastContextUsage),
        },
      });
      _sendhiro(ws, { type: "typing.stop", session_id: sessionId });
    } catch (err: unknown) {
      _sendhiro(ws, { type: "typing.stop", session_id: sessionId });
      _sendhiro(ws, {
        type: "error",
        session_id: sessionId,
        payload: {
          request_id: requestId,
          message: getErrorMessage(err),
        },
      });
    }
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

    try {
      // Pass the already-enqueued task to agent loop (it will use it directly)
      for await (const chunk of orchestrator.runAgentLoopWithTask(
        sessionId,
        message,
        task,
      )) {
        const envelopeObj =
          typeof chunk === "string" && !chunk.startsWith("{")
            ? { type: "stream_chunk", content: chunk }
            : chunk;

        const envelopeStr =
          typeof envelopeObj === "string"
            ? envelopeObj
            : JSON.stringify(envelopeObj);

        ws.send(envelopeStr);
        _saveStreamChunk(sessionId!, checkpointId!, seq++, envelopeStr);
      }

      _saveStreamChunk(
        sessionId!,
        checkpointId!,
        seq,
        JSON.stringify({ type: "stream_done" }),
      );
      ws.send(JSON.stringify({ type: "stream_done" }));
      streamDone = true;
    } catch (err: unknown) {
      const errEnvelope = JSON.stringify({
        type: "error",
        content: getErrorMessage(err),
      } as WSMessage);
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
    service: "Hiro Core API",
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
  const runtimeRoot = process.env["Hiro_RUNTIME_ROOT"];
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
    project: agentConfig.project || "Hiro",
    llm_provider: orchestrator.provider,
    llm_model: orchestrator.modelName,
    heartbeat: hb,
    requestId: (_req as AuthenticatedRequest).requestId,
  });
});

app.post("/agent/route-preview", (req, res) => {
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
  if (isApiKeyRequestAuthenticated(req.headers)) return true;
  if (launcherRuntimeAuth?.isDashboardAuthenticated(req.headers)) return true;
  return false;
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

    const result = await orchestrator.tools.executeToolStructured(
      name,
      args || {},
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
app.post("/chat", async (req, res) => {
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
    for await (const chunk of orchestrator.runAgentLoop(session_id, message)) {
      const data = JSON.parse(chunk);
      if (data.type === "stream_chunk") {
        fullResponse += data.content;
      }
    }
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
});

// ... rest of the endpoints remain the same but with requestId added
app.get("/improvement/status", (_req, res) => {
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

app.get("/improvement/tunings", (_req, res) => {
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

app.post("/improvement/force-reflection", async (_req, res) => {
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
});

app.post("/improvement/force-optimization", async (_req, res) => {
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
});

app.post("/improvement/force-tuning", async (_req, res) => {
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
app.get("/tasks", (_req, res) => {
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

app.post("/tasks", (_req, res) => {
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

app.get("/tasks/scheduled", (_req, res) => {
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

app.post("/tasks/scheduled", (_req, res) => {
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

app.delete("/tasks/scheduled/:scheduledTaskId", (_req, res) => {
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
});

app.get("/tasks/session/:sessionId", (_req, res) => {
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

app.get("/tasks/:taskId", (_req, res) => {
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

app.delete("/tasks/:taskId", (_req, res) => {
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
app.get("/models", (_req, res) => {
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

app.post("/models", (req, res) => {
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

app.delete("/models/:modelName", (req, res) => {
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

app.put("/models/active", (req, res) => {
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
app.get("/system/stats", (_req, res) => {
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

app.get("/system/health", (_req, res) => {
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

// ── LLM Provider Management Endpoints ─────────────────────────────────────────
app.get("/providers", async (_req, res) => {
  try {
    const builtInProviders = getAvailableProviders();
    const pluginProviders =
      await listRuntimePluginProviderMetadata(workspaceDir);
    const providers = [
      ...builtInProviders,
      ...pluginProviders.filter(
        (provider) =>
          !builtInProviders.some((builtIn) => builtIn.id === provider.id),
      ),
    ];
    res.json({
      providers,
      configured: [
        ...getConfiguredProviders().map((p) => p.id),
        ...pluginProviders
          .filter((provider) => provider.isActive)
          .map((provider) => provider.id),
      ],
      active: getActiveProvider()?.id || null,
      requestId: (_req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.get("/providers/:providerId", async (req, res) => {
  try {
    const provider = getProviderById(req.params.providerId);
    if (provider) {
      return res.json({
        provider,
        models: getModelsByProvider(provider.id),
        requestId: (req as AuthenticatedRequest).requestId,
      });
    }
    const pluginProvider = await findRuntimePluginProviderDescriptor(
      workspaceDir,
      req.params.providerId,
    );
    if (!pluginProvider) {
      res.status(404).json({ detail: "Provider not found" });
      return;
    }
    return res.json({
      provider: pluginProvider.provider,
      models: pluginProvider.provider.models.map((modelName) => ({
        id: `${pluginProvider.provider.id}/${modelName}`,
        name: modelName,
        provider: pluginProvider.provider.id,
      })),
      requestId: (req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.post("/providers/:providerId/api-key", (req, res) => {
  try {
    const { api_key } = req.body;
    if (!api_key) {
      res.status(400).json({ detail: "api_key is required" });
      return;
    }
    const success = setProviderApiKey(req.params.providerId, api_key);
    if (!success) {
      res.status(404).json({ detail: "Provider not found" });
      return;
    }
    res.json({
      success: true,
      provider: req.params.providerId,
      requestId: (req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.get("/providers/:providerId/api-key", (req, res) => {
  try {
    const provider = getProviderById(req.params.providerId);
    if (!provider) {
      res.status(404).json({ detail: "Provider not found" });
      return;
    }
    const apiKey = getProviderApiKey(req.params.providerId);
    res.json({
      provider: req.params.providerId,
      configured: !!apiKey,
      keyLength: apiKey.length,
      requestId: (req as AuthenticatedRequest).requestId,
    });
  } catch (e: unknown) {
    res.status(500).json({ detail: getErrorMessage(e) });
  }
});

app.get("/models/by-provider", async (_req, res) => {
  try {
    const providers = getAvailableProviders();
    const modelsByProvider: Record<string, unknown[]> = {};
    for (const provider of providers) {
      modelsByProvider[provider.id] = getModelsByProvider(provider.id);
    }
    for (const provider of await listRuntimePluginProviderMetadata(
      workspaceDir,
    )) {
      if (modelsByProvider[provider.id]) continue;
      modelsByProvider[provider.id] = provider.models.map((modelName) => ({
        id: `${provider.id}/${modelName}`,
        name: modelName,
        provider: provider.id,
      }));
    }
    res.json({
      models_by_provider: modelsByProvider,
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
    mcpClose = mountMcpSessionManager(app, {
      executeTool: (name: string, args: Record<string, unknown>) =>
        orchestrator.tools.executeToolStructured(name, args),
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
  await Promise.all([closeWebSocketServer(wss), closeWebSocketServer(hiroWss)]);
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
