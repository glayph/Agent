import express from "express";
import { createProxyMiddleware, fixRequestBody } from "http-proxy-middleware";
import { WebSocket as WSWebSocket } from "ws";
import * as http from "http";
import * as child_process from "child_process";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath, pathToFileURL } from "url";
import * as dotenv from "dotenv";
import { loadConfiguredSecretsIntoEnv, readMikiEnv } from "@miki/config";
import {
  allowedCorsOriginsFromEnv,
  hasExplicitAllowedOrigins,
  isAllowedCorsOrigin,
  normalizeCorsOrigin,
  resolveAllowedCidrsFromEnv,
  isIpAllowedByCidrs,
  getRequiredEnvSecret,
} from "@miki/config/security";
import { rewriteMcpProxyPath } from "./runtime-utils.js";
import {
  createRelayWebSocketServer,
  rejectWsUpgrade,
  hasWsAuthMaterial,
  relayWs,
  closeWebSocketServer,
} from "./websocket-relay.js";
import { closeHttpServer, terminateProcessTree } from "./shutdown.js";
import { createRotatingLogStream } from "./log-rotation.js";
import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import { createProcessStateStore } from "./process-state-snapshot.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Config ───────────────────────────────────────────────────────────────────

function env(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

function positiveIntEnv(key: string, fallback: number): number {
  const parsed = Number.parseInt(env(key, String(fallback)), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const inferredSourceRoot = path.resolve(__dirname, "../../..");
const sourceRoot = path.resolve(
  readMikiEnv("MIKI_SOURCE_ROOT") || inferredSourceRoot,
);
const runtimeRoot = path.resolve(
  readMikiEnv("MIKI_RUNTIME_ROOT") || sourceRoot,
);
const workspaceDir = path.resolve(
  readMikiEnv("MIKI_WORKSPACE_DIR") || runtimeRoot,
);
dotenv.config({ path: path.join(workspaceDir, ".env") });
loadConfiguredSecretsIntoEnv(undefined, workspaceDir);

const config = {
  workspaceDir,
  runtimeRoot,
  corePort: positiveIntEnv("CORE_PORT", 8000),
  gatewayPort: positiveIntEnv("GATEWAY_PORT", 18800),
  gatewayHost: env("GATEWAY_HOST", "127.0.0.1"),
  enableMcp: env("ENABLE_MCP", "true") !== "false",
  // 0 = unbounded restarts (with capped exponential backoff)
  maxCoreRestarts: positiveIntEnv("CORE_MAX_RESTARTS", 0),
  coreStartupTimeout: positiveIntEnv("CORE_STARTUP_TIMEOUT", 60000),
  coreHealthInterval: positiveIntEnv("CORE_HEALTH_INTERVAL", 15000),
  coreHealthTimeout: positiveIntEnv("CORE_HEALTH_TIMEOUT", 5000),
  maxPayloadSize: 5 * 1024 * 1024,
  maxWsEarlyMessages: 100,
} as const;

const currentAllowedCorsOrigins = () =>
  allowedCorsOriginsFromEnv({ workspaceDir });

function allowedOriginsForRequest(
  request: { headers: http.IncomingHttpHeaders },
  origin: string | undefined,
): { origins: string[]; explicit: boolean } {
  const explicit = hasExplicitAllowedOrigins({ workspaceDir });
  const origins = currentAllowedCorsOrigins();
  if (!explicit && origin && config.gatewayHost === "0.0.0.0") {
    try {
      const parsed = new URL(origin);
      const requestHost = String(request.headers.host || "").toLowerCase();
      if (requestHost && parsed.host.toLowerCase() === requestHost) {
        origins.push(normalizeCorsOrigin(origin));
      }
    } catch {
      // Malformed browser origins are rejected by isAllowedCorsOrigin.
    }
  }
  return { origins, explicit };
}

function runtimePath(...segments: string[]): string {
  return path.join(config.runtimeRoot, ...segments);
}
function sourcePath(...segments: string[]): string {
  return path.join(sourceRoot, ...segments);
}
function runtimeLoaderArgs(): string[] {
  const loaderPath = sourcePath("runtime-loader.mjs");
  if (!fs.existsSync(loaderPath)) return [];
  const registerSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(pathToFileURL(loaderPath).href)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--import",
    `data:text/javascript,${encodeURIComponent(registerSource)}`,
  ];
}

function isLoopbackIp(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0"
  )
    return true;
  return /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

// ── Logger ───────────────────────────────────────────────────────────────────

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

function createLogger(level: LogLevel = "info") {
  const threshold = LOG_LEVELS[level];
  const ts = () => new Date().toISOString();
  return {
    debug: (...args: unknown[]) =>
      threshold <= 0 && console.error(`[${ts()}] [DEBUG]`, ...args),
    info: (...args: unknown[]) =>
      threshold <= 1 && console.log(`[${ts()}] [INFO]`, ...args),
    warn: (...args: unknown[]) =>
      threshold <= 2 && console.warn(`[${ts()}] [WARN]`, ...args),
    error: (...args: unknown[]) =>
      threshold <= 3 && console.error(`[${ts()}] [ERROR]`, ...args),
  } as {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

const log = createLogger(env("LOG_LEVEL", "info") as LogLevel);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function coreHealthHeaders(): Record<string, string> | undefined {
  const apiKey = process.env.API_KEY_SECRET?.trim();
  return apiKey ? { "x-api-key": apiKey } : undefined;
}

// ── Core process management ──────────────────────────────────────────────────

const processStateStore = createProcessStateStore(config.workspaceDir);
// A prior snapshot with restart attempts recorded but never marked
// cleanShutdown means the gateway's own process ended unexpectedly last
// run (crash, kill -9, power loss) rather than via the SIGINT/SIGTERM
// path below - surfaced only as a log line for now; the recovery
// behavior itself (spawning a fresh core) is unaffected either way since
// core is always started fresh on gateway boot. A fresh/never-written
// snapshot naturally has restartAttempts === 0, so no explicit
// "was this snapshot ever written" check is needed.
{
  const priorState = processStateStore.read();
  if (!priorState.cleanShutdown && priorState.restartAttempts > 0) {
    log.warn(
      `Gateway restarted after an unclean prior exit (last snapshot: ${priorState.updatedAt}, ${priorState.restartAttempts} restart attempt(s) recorded).`,
    );
  }
  processStateStore.resetForColdStart();
}

let coreProcess: child_process.ChildProcess | null = null;
let coreRestartTimer: ReturnType<typeof setTimeout> | null = null;
let coreRestartAttempts = 0;
let coreHealthy = false;

function startCore(): child_process.ChildProcess {
  const logFile = path.join(config.workspaceDir, "data", "core_backend.log");
  const logDir = path.dirname(logFile);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  const logStream = createRotatingLogStream(logFile);

  logStream.write(
    `\n--- Gateway spawning core at ${new Date().toISOString()} ---\n`,
  );

  const coreEntry = sourcePath("packages", "core", "dist", "api", "index.js");
  const proc = child_process.spawn(
    "node",
    [...runtimeLoaderArgs(), coreEntry],
    {
      cwd: config.workspaceDir,
      env: {
        ...process.env,
        MIKI_SOURCE_ROOT: sourceRoot,
        MIKI_RUNTIME_ROOT: config.runtimeRoot,
        MIKI_WORKSPACE_DIR: config.workspaceDir,
        // Legacy mixed-case aliases: older installs / external tooling may
        // still read these directly. readMikiEnv() checks MIKI_* first.
        Miki_RUNTIME_ROOT: config.runtimeRoot,
        Miki_WORKSPACE_DIR: config.workspaceDir,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
    },
  );

  proc.stdout?.on("data", (d: Buffer) => logStream.write(d.toString()));
  proc.stdout?.on("error", (err: Error) =>
    log.error("Core stdout error:", err),
  );

  proc.stderr?.on("data", (d: Buffer) =>
    logStream.write(`[STDERR] ${d.toString()}`),
  );
  proc.stderr?.on("error", (err: Error) =>
    log.error("Core stderr error:", err),
  );

  proc.on("exit", (code) => {
    coreHealthy = false;
    log.warn(`Core exited with code ${code}`);
    logStream.write(
      `\n--- Core exited code ${code} at ${new Date().toISOString()} ---\n`,
    );
    logStream.end();
    // Any unexpected core exit, including SIGKILL (code === null) or an
    // accidental zero exit, must recover in a 24/7 runtime. The gateway's
    // deliberate shutdown path is guarded by shutdownInProgress.
    if (!shutdownInProgress) {
      attemptCoreRestart();
    }
  });

  proc.on("error", (err: Error) => {
    coreHealthy = false;
    log.error("Failed to spawn core:", err.message);
    logStream.write(`\n--- Core spawn error: ${err.message} ---\n`);
  });

  return proc;
}

function attemptCoreRestart(): void {
  if (shutdownInProgress || coreRestartTimer) {
    return;
  }
  // config.maxCoreRestarts === 0 means unbounded
  if (
    config.maxCoreRestarts > 0 &&
    coreRestartAttempts >= config.maxCoreRestarts
  ) {
    log.error(
      `Max core restarts (${config.maxCoreRestarts}) reached. Giving up. Set CORE_MAX_RESTARTS=0 for unbounded.`,
    );
    return;
  }
  coreRestartAttempts++;
  processStateStore.recordRestartAttempt();
  // Backoff: 2s, 4s, 8s … capped at 5 minutes
  const backoff = Math.min(
    Math.pow(2, coreRestartAttempts) * 1000,
    5 * 60 * 1000,
  );
  log.info(`Restarting core in ${backoff}ms (attempt ${coreRestartAttempts})`);
  coreRestartTimer = setTimeout(async () => {
    coreRestartTimer = null;
    if (shutdownInProgress) {
      return;
    }
    coreProcess = startCore();
    try {
      await waitForCore();
    } catch (err: unknown) {
      log.error(
        "Core restart failed:",
        err instanceof Error ? err.message : String(err),
      );
      attemptCoreRestart();
    }
  }, backoff);
  coreRestartTimer.unref?.();
}

async function waitForCore(timeout = config.coreStartupTimeout): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${config.corePort}/health`, {
        headers: coreHealthHeaders(),
        signal: AbortSignal.timeout(config.coreHealthTimeout),
      });
      if (res.ok) {
        coreHealthy = true;
        coreRestartAttempts = 0;
        log.info("Core backend is healthy");
        return;
      }
    } catch {
      // not ready yet
    }
    await sleep(250);
  }
  throw new Error("Core backend failed to start within timeout");
}

// ── Core health monitor (circuit breaker) ────────────────────────────────────

let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let consecutiveFailures = 0;
const MAX_CONSECUTIVE_FAILURES = 3;

function startCoreHealthMonitor(): void {
  healthCheckTimer = setInterval(async () => {
    try {
      const res = await fetch(`http://127.0.0.1:${config.corePort}/health`, {
        headers: coreHealthHeaders(),
        signal: AbortSignal.timeout(config.coreHealthTimeout),
      });
      if (res.ok) {
        if (!coreHealthy) {
          log.info("Core health restored");
        }
        coreHealthy = true;
        consecutiveFailures = 0;
        processStateStore.recordHealthy();
      } else {
        throw new Error(`Health check returned ${res.status}`);
      }
    } catch (err: unknown) {
      consecutiveFailures++;
      coreHealthy = false;

      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        log.warn(
          `Core unhealthy (${consecutiveFailures} failures): ${err instanceof Error ? err.message : String(err)}`,
        );
        // Bug fix (2026-08-12): the old guard `!coreProcess ||
        // coreProcess.killed` only restarted when the process had
        // *already* exited on its own - but a hung/zombie process is by
        // definition still running and unresponsive, so `.killed` is
        // false and this branch never fired. That silently defeated the
        // "kill zombie/stuck process and restart" auto-recovery
        // requirement: repeated health-check failures were logged
        // forever with no actual recovery action taken.
        //
        // A zombie process must be force-terminated before restarting,
        // since simply spawning a new core alongside the stuck one would
        // leave two processes fighting over the same port/state.
        if (!coreProcess || coreProcess.killed) {
          attemptCoreRestart();
        } else {
          log.warn(
            "Core process is still running but unresponsive - terminating before restart.",
          );
          const zombie = coreProcess;
          terminateProcessTree(zombie, config.coreHealthTimeout)
            .catch((killErr: unknown) =>
              log.error(
                "Failed to terminate unresponsive core:",
                killErr instanceof Error ? killErr.message : String(killErr),
              ),
            )
            .finally(() => {
              // The process's own "exit" handler normally drives restart,
              // but if terminateProcessTree couldn't confirm exit (e.g.
              // SIGKILL raced with an already-dying process and the
              // "exit" event was missed), fall back to an explicit
              // restart attempt so recovery still happens.
              if (
                !shutdownInProgress &&
                (!coreProcess || coreProcess === zombie)
              ) {
                attemptCoreRestart();
              }
            });
        }
      }
    }
  }, config.coreHealthInterval);
  healthCheckTimer.unref?.();
}

function stopCoreHealthMonitor(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

// ── Auth helper for gateway control routes ───────────────────────────────────

const GATEWAY_DASHBOARD_COOKIE = "Miki_dashboard_session";

function parseCookieValue(
  cookieHeader: string | string[] | undefined,
  name: string,
): string {
  const raw = Array.isArray(cookieHeader)
    ? cookieHeader[0]
    : cookieHeader || "";
  const match = new RegExp(`(?:^|;\\s*)${name}=([^;]*)`).exec(raw);
  return match?.[1] || "";
}

// A dashboard session cookie's mere *presence* proves nothing: the token it
// carries is validated against core's in-memory activeSessions map
// (packages/core/src/api/launcher-compat.ts), which lives in the core
// process, not this one. Gateway-owned routes like /gateway/shutdown have
// no further downstream auth check -- unlike /api/* traffic, which core
// re-validates itself after the proxy -- so accepting any cookie value at
// face value here would let anyone who can reach the gateway forge a
// session and, e.g., shut the whole system down. Ask core's own auth
// status endpoint (GET /api/auth/status, always safe to call, never
// mutates state) whether the cookie is a real, still-active session before
// trusting it.
async function isValidDashboardSession(
  cookieHeader: string | string[] | undefined,
): Promise<boolean> {
  const raw = Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader;
  if (!raw) return false;
  try {
    const res = await fetch(
      `http://127.0.0.1:${config.corePort}/api/auth/status`,
      {
        headers: { Cookie: raw },
        signal: AbortSignal.timeout(config.coreHealthTimeout),
      },
    );
    if (!res.ok) return false;
    const body = (await res.json()) as { authenticated?: boolean };
    return body.authenticated === true;
  } catch {
    // Core unreachable/slow: fail closed rather than treating an
    // unverifiable cookie as authenticated.
    return false;
  }
}

// Protects non-health gateway routes.
// Accepts X-API-Key header, Authorization: Bearer, or a verified dashboard
// session cookie (checked against core, see isValidDashboardSession above).
async function gatewayAuthMiddleware(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): Promise<void> {
  if (req.path === "/health") {
    next();
    return;
  }
  const apiKey =
    (Array.isArray(req.headers["x-api-key"])
      ? req.headers["x-api-key"][0]
      : req.headers["x-api-key"]) ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "") ||
    "";
  if (apiKey) {
    let expected: string;
    try {
      expected = getRequiredEnvSecret("API_KEY_SECRET", {
        weakValues: ["Miki-dev-key", "sk-anything"],
      });
    } catch {
      res.status(500).json({ error: "Gateway auth is misconfigured" });
      return;
    }
    if (apiKey !== expected) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
    return;
  }
  // Cheap presence check first so requests with no cookie at all (the
  // common unauthenticated case) don't pay for a round trip to core.
  const sessionCookie = parseCookieValue(
    req.headers.cookie,
    GATEWAY_DASHBOARD_COOKIE,
  );
  if (sessionCookie && (await isValidDashboardSession(req.headers.cookie))) {
    next();
    return;
  }
  res.status(401).json({ error: "Unauthorized" });
}

// ── Express app ──────────────────────────────────────────────────────────────

const app = express();

// Middleware: request logging & timing
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    log.info(`${req.method} ${req.originalUrl} → ${res.statusCode} (${ms}ms)`);
  });
  next();
});

function setSecurityHeaders(res: express.Response): void {
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
}

// Middleware: CORS for browser clients. Defaults to loopback origins only.
app.use((req, res, next) => {
  setSecurityHeaders(res);
  const origin = Array.isArray(req.headers.origin)
    ? req.headers.origin[0]
    : req.headers.origin;
  const corsPolicy = allowedOriginsForRequest(req, origin);
  if (!isAllowedCorsOrigin(origin, corsPolicy.origins, corsPolicy.explicit)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  const normalizedOrigin = origin ? normalizeCorsOrigin(origin) : null;
  if (normalizedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", normalizedOrigin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-API-Key, MCP-Session-ID, X-Session-ID",
  );
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ── CIDR enforcement middleware ──────────────────────────────────────────────
// When Miki_ALLOWED_CIDRS is set, reject non-loopback clients not in the list.
const configuredAllowedCidrs = resolveAllowedCidrsFromEnv();
if (configuredAllowedCidrs.length > 0) {
  app.use((req, res, next) => {
    const clientIp = (req.ip || req.socket.remoteAddress || "").replace(
      /^::ffff:/,
      "",
    );
    if (isLoopbackIp(clientIp)) {
      return next();
    }
    if (!isIpAllowedByCidrs(clientIp, configuredAllowedCidrs)) {
      return res
        .status(403)
        .json({ error: "Client IP not allowed by CIDR policy" });
    }
    return next();
  });
}

// ── Static routes ────────────────────────────────────────────────────────────

// Serve the React dashboard build from the frontend package.
const webDir = runtimePath("packages", "ui", "frontend", "dist");
const webIndexPath = path.join(webDir, "index.html");
let cachedIndexHtml: { mtimeMs: number; html: string } | null = null;

function loadIndexHtml(): string | null {
  try {
    const stat = fs.statSync(webIndexPath);
    if (cachedIndexHtml?.mtimeMs === stat.mtimeMs) {
      return cachedIndexHtml.html;
    }
    const html = fs.readFileSync(webIndexPath, "utf-8");
    cachedIndexHtml = { mtimeMs: stat.mtimeMs, html };
    return html;
  } catch {
    cachedIndexHtml = null;
    return null;
  }
}

function sendDashboardHtml(res: express.Response): void {
  const html = loadIndexHtml();
  if (!html) {
    res
      .status(404)
      .type("html")
      .send(
        "<h1>Dashboard not found. Run 'npm run build' in packages/ui/frontend</h1>",
      );
    return;
  }

  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });
  res.type("html").send(html);
}

app.use(express.static(webDir));
app.use("/web", express.static(webDir));
app.get(["/", "/web"], (_req, res) => {
  sendDashboardHtml(res);
});

// Protect all /gateway/* routes except /gateway/health
app.use("/gateway", gatewayAuthMiddleware);

// Health endpoint for the gateway itself
app.get("/gateway/health", (_req, res) => {
  res.json({
    status: "ok",
    coreHealthy,
    uptime: process.uptime(),
    pid: process.pid,
  });
});

app.post("/gateway/shutdown", (_req, res) => {
  res.json({
    ok: true,
    message: "Gateway and backend services shutting down...",
  });
  setTimeout(() => {
    shutdown("API_SHUTDOWN", 0);
  }, 500);
});

// ── API proxy to core ────────────────────────────────────────────────────────

const coreProxyTarget = `http://127.0.0.1:${config.corePort}`;
const apiProxy = createProxyMiddleware({
  target: coreProxyTarget,
  changeOrigin: false,
  // xfwd adds X-Forwarded-For/-Port/-Proto headers derived from the real
  // client connection on the gateway's socket. Without this, core (which
  // only ever sees the gateway's loopback connection) has no way to tell
  // dashboard clients apart, and per-client throttles (e.g. login failure
  // lockout) collapse into a single shared bucket for every browser/LAN
  // client behind the gateway. Core only trusts this header when it
  // arrives over its own loopback socket (see `trust proxy` in
  // packages/core/src/api/index.ts), so this cannot be spoofed by a
  // client talking to core directly on a non-loopback CORE_HOST.
  xfwd: true,
  proxyTimeout: 120000,
  timeout: 120000,
  pathRewrite: (proxyPath) => `/api${proxyPath}`,
  on: {
    proxyReq: fixRequestBody,
  },
});

app.use("/api", apiProxy);

// Rate limiters for channel webhooks and WebSocket upgrades (30 req/min by default)
const channelRateLimiter = new SlidingWindowRateLimiter({
  windowMs: positiveIntEnv("RATE_LIMIT_WINDOW_MS", 60000),
  maxRequests: positiveIntEnv("RATE_LIMIT_MAX_REQUESTS", 30),
});
const wsRateLimiter = new SlidingWindowRateLimiter({
  windowMs: positiveIntEnv("RATE_LIMIT_WINDOW_MS", 60000),
  maxRequests: positiveIntEnv("RATE_LIMIT_MAX_REQUESTS", 30),
});
setInterval(() => {
  channelRateLimiter.cleanup();
  wsRateLimiter.cleanup();
}, 60000).unref();

// Public channel webhooks terminate at the gateway and are proxied to core.
app.use(
  "/webhooks",
  (req, res, next) => {
    const clientKey =
      (req.ip || req.socket.remoteAddress || "unknown") + ":" + req.path;
    if (!channelRateLimiter.isAllowed(clientKey)) {
      res
        .status(429)
        .json({ error: "Too many requests. Rate limit exceeded." });
      return;
    }
    next();
  },
  createProxyMiddleware({
    target: coreProxyTarget,
    changeOrigin: false,
    pathRewrite: (proxyPath) =>
      `/webhooks${proxyPath === "/" ? "" : proxyPath}`,
    proxyTimeout: 120000,
    timeout: 120000,
    on: {
      proxyReq: fixRequestBody,
    },
  }),
);

// Proxy MCP to core (MCP server runs in-process with ToolRegistry)
// Only mounted when ENABLE_MCP is true
if (config.enableMcp) {
  app.use(
    "/mcp",
    createProxyMiddleware({
      target: coreProxyTarget,
      changeOrigin: true,
      pathRewrite: rewriteMcpProxyPath,
      proxyTimeout: 120000,
      timeout: 120000,
      on: {
        proxyReq: fixRequestBody,
      },
    }),
  );
}

app.get("*", (req, res, next) => {
  if (req.method !== "GET" || !req.accepts("html")) {
    next();
    return;
  }
  sendDashboardHtml(res);
});

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(app);

// ── WebSocket relay ──────────────────────────────────────────────────────────

const WS_PATHS = ["/miki/ws", "/ws/chat", "/ws", "/chat/ws"];
const wss = createRelayWebSocketServer();
const activeWsConnections = new Set<WSWebSocket>();

server.on("upgrade", (request, socket, head) => {
  const origin = Array.isArray(request.headers.origin)
    ? request.headers.origin[0]
    : request.headers.origin;
  const corsPolicy = allowedOriginsForRequest(request, origin);
  if (!isAllowedCorsOrigin(origin, corsPolicy.origins, corsPolicy.explicit)) {
    rejectWsUpgrade(socket, 403, "Forbidden");
    return;
  }
  const url = request.url || "";
  const matched = WS_PATHS.find(
    (p) => url === p || url.startsWith(p + "?") || url.startsWith(p + "#"),
  );
  if (matched) {
    const clientIp = request.socket.remoteAddress || "unknown";
    if (!wsRateLimiter.isAllowed(clientIp)) {
      rejectWsUpgrade(socket, 403, "Rate limit exceeded");
      return;
    }
    if (!hasWsAuthMaterial(request)) {
      rejectWsUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(request, socket, head, (clientWs) => {
      relayWs(
        clientWs,
        `ws://127.0.0.1:${config.corePort}${url}`,
        request,
        activeWsConnections,
      );
    });
    return;
  }
  socket.destroy();
});

// ── MCP server ───────────────────────────────────────────────────────────────

// MCP runs in-process inside the core API at /mcp.
// The gateway proxies /mcp traffic to the core via a dedicated middleware (see
// line ~802) gated behind ENABLE_MCP.

// ── Shutdown ─────────────────────────────────────────────────────────────────

let shutdownInProgress = false;

async function shutdown(signal: string, exitCode = 0): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  log.info(`Received ${signal}, shutting down...`);
  // Marked before any teardown step that could throw, so an intentional
  // SIGINT/SIGTERM is distinguishable on next boot from a crash even if
  // shutdown itself is later interrupted (e.g. a second signal forcing
  // an immediate exit).
  processStateStore.recordCleanShutdown();

  if (coreRestartTimer) {
    clearTimeout(coreRestartTimer);
    coreRestartTimer = null;
  }

  // 1. Stop background probes and accepting new HTTP connections.
  stopCoreHealthMonitor();
  await closeHttpServer(server, {
    timeoutMs: 5000,
    onForceClose: () =>
      log.warn("HTTP server drain timed out; forcing open connections closed"),
  });
  log.info("HTTP server closed");

  // 2. Close active WebSocket connections
  for (const ws of activeWsConnections) {
    try {
      ws.close(1001, "Server shutdown");
    } catch (err) {
      log.warn("WS close error:", err);
    }
  }
  activeWsConnections.clear();
  await closeWebSocketServer(wss);

  // 3. Kill core backend
  if (coreProcess) {
    await terminateProcessTree(coreProcess, 2000);
    coreProcess = null;
  }

  // Clean up PID file
  try {
    const pidFile = path.join(workspaceDir, "data", "gateway.pid");
    if (fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  } catch {}

  log.info("Shutdown complete");
  process.exit(exitCode);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log.info(`Core target: 127.0.0.1:${config.corePort}`);
  coreProcess = startCore();

  try {
    await waitForCore();
  } catch (err: unknown) {
    log.error(err instanceof Error ? err.message : String(err));
    await shutdown("startup failure", 1);
  }

  startCoreHealthMonitor();

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log.error(`Port ${config.gatewayPort} is already in use`);
    } else {
      log.error("Gateway server error:", err.message);
    }
    if (coreProcess) coreProcess.kill("SIGTERM");
    process.exit(1);
  });

  server.listen(config.gatewayPort, config.gatewayHost, () => {
    try {
      fs.writeFileSync(
        path.join(workspaceDir, "data", "gateway.pid"),
        process.pid.toString(),
      );
    } catch (err) {
      log.warn("Failed to write PID file:", err);
    }
    log.info(
      `Gateway listening on http://${config.gatewayHost}:${config.gatewayPort}`,
    );
    log.info(`API proxy: /api/* → 127.0.0.1:${config.corePort}/*`);
    log.info(`WebSocket paths: ${WS_PATHS.join(", ")}`);
    if (config.enableMcp) {
      log.info(
        `MCP: http://127.0.0.1:${config.gatewayPort}/mcp (ENABLE_MCP=false to disable)`,
      );
    }
    log.info(
      `Gateway health: http://127.0.0.1:${config.gatewayPort}/gateway/health`,
    );
  });
}

main();

// ── Signal handlers ──────────────────────────────────────────────────────────

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
