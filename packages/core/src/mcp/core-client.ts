import http from "http";

const CORE_PORT = parseInt(process.env["CORE_PORT"] || "8000", 10);
const MAX_RETRY_ATTEMPTS = 3;

const keepAliveAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,
  maxFreeSockets: 5,
  timeout: 30000,
});

export const MCP_RESOURCE_TTL = {
  HEALTH: 2_000,
  CONFIG: 30_000,
  SESSIONS: 5_000,
  GOALS: 10_000,
  TASKS: 5_000,
  MODELS: 60_000,
  METRICS: 3_000,
  HEARTBEAT: 4_000,
  IMPROVEMENT: 10_000,
} as const;

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

class ResponseCache {
  private store = new Map<string, CacheEntry<unknown>>();

  get<T>(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.data as T;
  }

  set<T>(key: string, data: T, ttlMs: number): void {
    this.store.set(key, { data, expiresAt: Date.now() + ttlMs });
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }
}

const responseCache = new ResponseCache();
const inFlight = new Map<string, Promise<unknown>>();

export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = MAX_RETRY_ATTEMPTS,
  baseDelayMs = 200,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) =>
          setTimeout(resolve, baseDelayMs * Math.pow(2, i)),
        );
      }
    }
  }
  throw lastErr;
}

export async function callCoreApi<T>(
  endpoint: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<T> {
  return withRetry(async () => {
    const url = `http://127.0.0.1:${CORE_PORT}${endpoint}`;

    return new Promise<T>((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const req = http.request(
        url,
        {
          method,
          agent: keepAliveAgent,
          headers: {
            "Content-Type": "application/json",
            ...(bodyStr
              ? { "Content-Length": Buffer.byteLength(bodyStr) }
              : {}),
          },
        },
        (res) => {
          let raw = "";
          res.on("data", (chunk: Buffer) => {
            raw += chunk.toString();
          });
          res.on("end", () => {
            const statusCode = res.statusCode;
            if (!statusCode || statusCode >= 400) {
              reject(new Error(formatCoreApiError(statusCode || 0, raw)));
              return;
            }
            try {
              resolve(JSON.parse(raw) as T);
            } catch {
              reject(new Error(`Core API: invalid JSON from ${endpoint}`));
            }
          });
        },
      );
      req.on("error", reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  });
}

function formatCoreApiError(statusCode: number, raw: string): string {
  try {
    const parsed = JSON.parse(raw) as {
      error?: unknown;
      detail?: unknown;
      denial?: {
        toolName?: unknown;
        reason?: unknown;
        policy?: unknown;
        deniedAt?: unknown;
      };
      requestId?: unknown;
    };
    if (parsed.denial && typeof parsed.denial === "object") {
      const toolName = safeErrorText(parsed.denial.toolName, "unknown");
      const reason = safeErrorText(parsed.denial.reason, "No reason provided");
      const policy = safeErrorText(parsed.denial.policy, "unknown");
      const requestId = safeErrorText(parsed.requestId);
      return [
        `Core API error ${statusCode}: tool denied`,
        `tool=${toolName}`,
        `policy=${policy}`,
        `reason=${reason}`,
        requestId ? `requestId=${requestId}` : "",
      ]
        .filter(Boolean)
        .join("; ");
    }
    const error = safeErrorText(parsed.error);
    const detail = safeErrorText(parsed.detail);
    if (error || detail) {
      return [`Core API error ${statusCode}`, error, detail]
        .filter(Boolean)
        .join(": ");
    }
  } catch {
    // Fall through to a bounded raw preview.
  }
  return `Core API error ${statusCode}: ${raw.slice(0, 500)}`;
}

function safeErrorText(value: unknown, fallback = ""): string {
  if (typeof value !== "string") return fallback;
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

export async function cachedCoreApi<T>(
  cacheKey: string,
  endpoint: string,
  ttlMs: number,
): Promise<T> {
  const cached = responseCache.get<T>(cacheKey);
  if (cached !== null) return cached;
  const data = await callCoreApi<T>(endpoint);
  responseCache.set(cacheKey, data, ttlMs);
  return data;
}

export async function deduplicatedFetch<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;
  const promise = fn().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

export async function fetchCachedResource(
  cacheKey: string,
  endpoint: string,
  ttlMs: number,
  uri: URL,
) {
  const data = await deduplicatedFetch(cacheKey, () =>
    cachedCoreApi(cacheKey, endpoint, ttlMs),
  );
  return {
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}
