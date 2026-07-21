import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const MATRIX_MESSAGE_LIMIT = 4000;
const MATRIX_SYNC_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

export interface MatrixRuntimeConfig {
  enabled: boolean;
  homeserverUrl: string;
  userId: string;
  accessToken: string;
  allowedIds: string[];
  reconnect: boolean;
}

export interface MatrixEvent {
  type?: string;
  sender?: string;
  event_id?: string;
  content?: {
    msgtype?: string;
    body?: string;
    "m.mentions"?: {
      user_ids?: string[];
    };
  };
}

interface MatrixSyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: {
          events?: MatrixEvent[];
        };
      }
    >;
  };
}

function recordOrEmpty(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(stringOrEmpty).filter(Boolean)
    : typeof value === "string" && value.trim()
      ? value
          .split(/\r?\n|,/)
          .map((item) => item.trim())
          .filter(Boolean)
      : [];
}

function normalizeHomeserverUrl(value: string): string {
  return value.replace(/\/+$/g, "");
}

export function resolveMatrixRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): MatrixRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.matrix);
  const settings = recordOrEmpty(raw.settings);
  const homeserverUrl = normalizeHomeserverUrl(
    stringOrEmpty(
      env.MATRIX_HOMESERVER_URL ??
        settings.homeserver_url ??
        raw.homeserver_url,
    ),
  );
  const userId = stringOrEmpty(
    env.MATRIX_USER_ID ?? settings.user_id ?? raw.user_id,
  );
  const accessToken = stringOrEmpty(
    env.MATRIX_ACCESS_TOKEN ?? settings.access_token ?? raw.access_token,
  );

  return {
    enabled:
      raw.enabled === true &&
      homeserverUrl.length > 0 &&
      userId.length > 0 &&
      accessToken.length > 0 &&
      env.ENABLE_MATRIX !== "false",
    homeserverUrl,
    userId,
    accessToken,
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
    reconnect: raw.reconnect !== false,
  };
}

export function normalizeMatrixPrompt(text: string, botUserId: string): string {
  return text.replaceAll(botUserId, "").replace(/\s+/g, " ").trim();
}

export function shouldHandleMatrixEvent(
  roomId: string,
  event: MatrixEvent,
  config: MatrixRuntimeConfig,
): boolean {
  const body = stringOrEmpty(event.content?.body);
  if (!roomId || !event.sender || !body) return false;
  if (event.type !== "m.room.message") return false;
  if (event.content?.msgtype !== "m.text") return false;
  if (event.sender === config.userId) return false;

  if (config.allowedIds.length > 0) {
    const allowed = new Set(config.allowedIds);
    return allowed.has(roomId) || allowed.has(event.sender);
  }

  return true;
}

export class MatrixBot {
  private readonly orchestrator: AgentOrchestrator;
  private started = false;
  private stopping = false;
  private since: string | undefined;
  private syncAbort: AbortController | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryAttempts = 0;
  private runtimeConfig: MatrixRuntimeConfig | null = null;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
  }

  start(): void {
    if (this.started) return;
    const config = resolveMatrixRuntimeConfig(this.orchestrator.config);
    this.runtimeConfig = config;
    if (!config.enabled) {
      if (!config.homeserverUrl || !config.userId || !config.accessToken) {
        console.log(
          "Matrix bot disabled: MATRIX_HOMESERVER_URL, MATRIX_USER_ID, or MATRIX_ACCESS_TOKEN not configured",
        );
      } else if (process.env.ENABLE_MATRIX === "false") {
        console.log("Matrix bot disabled via ENABLE_MATRIX=false");
      } else {
        console.log("Matrix bot disabled in channel configuration");
      }
      return;
    }

    this.started = true;
    this.stopping = false;
    this.syncLoop({ processEvents: false }).catch((err) => {
      console.warn(
        `Matrix sync startup failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      this.scheduleRetry();
    });
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.syncAbort) {
      this.syncAbort.abort();
      this.syncAbort = null;
    }
  }

  private scheduleRetry(): void {
    const config = this.runtimeConfig;
    if (
      this.retryTimer ||
      this.stopping ||
      !this.started ||
      !config?.reconnect
    ) {
      return;
    }
    this.retryAttempts += 1;
    const delayMs = Math.min(60_000, 1_000 * 2 ** this.retryAttempts);
    console.log(`Matrix sync retry ${this.retryAttempts} in ${delayMs}ms`);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.syncLoop({ processEvents: true }).catch((err) => {
        console.warn(
          `Matrix sync retry failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        this.scheduleRetry();
      });
    }, delayMs);
    this.retryTimer.unref?.();
  }

  private async syncLoop(options: { processEvents: boolean }): Promise<void> {
    const config = this.runtimeConfig;
    if (!config?.enabled || this.stopping) return;

    let processEvents = options.processEvents;
    while (!this.stopping && this.started) {
      const sync = await this.fetchSync(
        config,
        processEvents ? MATRIX_SYNC_TIMEOUT_MS : 0,
      );
      this.retryAttempts = 0;
      if (processEvents) {
        await this.handleSync(sync, config);
      }
      if (sync.next_batch) {
        this.since = sync.next_batch;
      }
      processEvents = true;
    }
  }

  private async fetchSync(
    config: MatrixRuntimeConfig,
    timeoutMs: number,
  ): Promise<MatrixSyncResponse> {
    const url = new URL(`${config.homeserverUrl}/_matrix/client/v3/sync`);
    url.searchParams.set("timeout", String(timeoutMs));
    if (this.since) url.searchParams.set("since", this.since);

    this.syncAbort = new AbortController();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
      signal: this.syncAbort.signal,
    });
    this.syncAbort = null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Matrix sync failed: ${res.status} ${body.slice(0, 200)}`,
      );
    }
    return (await res.json()) as MatrixSyncResponse;
  }

  private async handleSync(
    sync: MatrixSyncResponse,
    config: MatrixRuntimeConfig,
  ): Promise<void> {
    const joinedRooms = sync.rooms?.join || {};
    for (const [roomId, room] of Object.entries(joinedRooms)) {
      const events = room.timeline?.events || [];
      for (const event of events) {
        if (!shouldHandleMatrixEvent(roomId, event, config)) continue;
        await this.handleEvent(roomId, event, config);
      }
    }
  }

  private async handleEvent(
    roomId: string,
    event: MatrixEvent,
    config: MatrixRuntimeConfig,
  ): Promise<void> {
    const prompt = normalizeMatrixPrompt(
      event.content?.body || "",
      config.userId,
    );
    if (!prompt) return;
    const sessionId = ["matrix", roomId, event.sender || "unknown"].join("_");
    const response = await collectAgentResponse(
      this.orchestrator,
      sessionId,
      prompt,
    );
    for (const part of splitOutboundMessage(response, MATRIX_MESSAGE_LIMIT)) {
      await this.sendMessage(roomId, part, config);
    }
  }

  private async sendMessage(
    roomId: string,
    body: string,
    config: MatrixRuntimeConfig,
  ): Promise<void> {
    const txnId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = `${config.homeserverUrl}/_matrix/client/v3/rooms/${encodeURIComponent(
      roomId,
    )}/send/m.room.message/${encodeURIComponent(txnId)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ msgtype: "m.text", body }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Matrix send failed: ${res.status} ${text.slice(0, 200)}`,
      );
    }
  }
}
