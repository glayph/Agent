import net from "net";
import tls from "tls";
import type { Socket } from "net";
import type { AgentOrchestrator } from "../agent.js";
import {
  collectAgentResponse,
  splitOutboundMessage,
} from "./agent-response.js";

const IRC_LINE_LIMIT = 400;
const DEFAULT_IRC_PORT = 6667;
const DEFAULT_IRC_TLS_PORT = 6697;

type JsonRecord = Record<string, unknown>;

export interface IrcRuntimeConfig {
  enabled: boolean;
  server: string;
  port: number;
  nick: string;
  username: string;
  realname: string;
  password: string;
  nickservPassword: string;
  channels: string[];
  allowedIds: string[];
  mentionOnly: boolean;
  triggerPrefixes: string[];
  useTls: boolean;
  reconnect: boolean;
}

export interface IrcMessage {
  prefix?: string;
  command: string;
  params: string[];
  trailing?: string;
  raw: string;
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

function boolFromValue(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }
  return fallback;
}

function intFromValue(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function nickFromPrefix(prefix = ""): string {
  const bang = prefix.indexOf("!");
  return bang >= 0 ? prefix.slice(0, bang) : prefix;
}

function isChannelTarget(target: string): boolean {
  return /^[#&+!]/.test(target);
}

export function resolveIrcRuntimeConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): IrcRuntimeConfig {
  const channels = recordOrEmpty(config.channels ?? config.channel_list);
  const raw = recordOrEmpty(channels.irc);
  const settings = recordOrEmpty(raw.settings);
  const useTls = boolFromValue(
    env.IRC_TLS ?? settings.tls ?? settings.use_tls ?? raw.tls ?? raw.use_tls,
  );
  const server = stringOrEmpty(env.IRC_SERVER ?? settings.server ?? raw.server);
  const nick = stringOrEmpty(env.IRC_NICK ?? settings.nick ?? raw.nick);
  const port = intFromValue(
    env.IRC_PORT ?? settings.port ?? raw.port,
    useTls ? DEFAULT_IRC_TLS_PORT : DEFAULT_IRC_PORT,
  );
  const username =
    stringOrEmpty(env.IRC_USERNAME ?? settings.username ?? raw.username) ||
    nick ||
    "Hiro";
  const realname =
    stringOrEmpty(env.IRC_REALNAME ?? settings.realname ?? raw.realname) ||
    "Hiro Agent";

  return {
    enabled:
      raw.enabled === true &&
      server.length > 0 &&
      nick.length > 0 &&
      env.ENABLE_IRC !== "false",
    server,
    port,
    nick,
    username,
    realname,
    password: stringOrEmpty(
      env.IRC_PASSWORD ?? settings.password ?? raw.password,
    ),
    nickservPassword: stringOrEmpty(
      env.IRC_NICKSERV_PASSWORD ??
        settings.nickserv_password ??
        raw.nickserv_password,
    ),
    channels: stringArray(
      env.IRC_CHANNELS ?? settings.channels ?? raw.channels,
    ),
    allowedIds: stringArray(settings.allow_from ?? raw.allow_from),
    mentionOnly:
      recordOrEmpty(settings.group_trigger ?? raw.group_trigger)
        .mention_only !== false,
    triggerPrefixes: stringArray(
      recordOrEmpty(settings.group_trigger ?? raw.group_trigger).prefixes,
    ),
    useTls,
    reconnect: raw.reconnect !== false,
  };
}

export function parseIrcLine(raw: string): IrcMessage {
  let line = raw.replace(/\r?\n$/, "");
  let prefix: string | undefined;
  if (line.startsWith("@")) {
    const space = line.indexOf(" ");
    line = space >= 0 ? line.slice(space + 1) : "";
  }
  if (line.startsWith(":")) {
    const space = line.indexOf(" ");
    prefix = space >= 0 ? line.slice(1, space) : line.slice(1);
    line = space >= 0 ? line.slice(space + 1) : "";
  }
  const trailingIndex = line.indexOf(" :");
  const trailing =
    trailingIndex >= 0 ? line.slice(trailingIndex + 2) : undefined;
  const beforeTrailing =
    trailingIndex >= 0 ? line.slice(0, trailingIndex) : line;
  const parts = beforeTrailing.split(/\s+/).filter(Boolean);
  const command = (parts.shift() || "").toUpperCase();
  return { prefix, command, params: parts, trailing, raw };
}

export function normalizeIrcPrompt(
  text: string,
  botNick: string,
  prefixes: string[] = [],
): string {
  let prompt = text.trim();
  const mentionPattern = new RegExp(`^${escapeRegex(botNick)}[:,]?\\s*`, "i");
  prompt = prompt.replace(mentionPattern, "").trim();
  for (const prefix of prefixes) {
    if (prefix && prompt.startsWith(prefix)) {
      return prompt.slice(prefix.length).trim();
    }
  }
  return prompt;
}

export function shouldHandleIrcMessage(
  message: IrcMessage,
  config: IrcRuntimeConfig,
): boolean {
  if (message.command !== "PRIVMSG") return false;
  const target = message.params[0] || "";
  const body = stringOrEmpty(message.trailing);
  const senderNick = nickFromPrefix(message.prefix);
  if (!target || !body || !senderNick) return false;
  if (senderNick.toLowerCase() === config.nick.toLowerCase()) return false;

  if (config.allowedIds.length > 0) {
    const allowed = new Set(
      config.allowedIds.map((item) => item.toLowerCase()),
    );
    const matched =
      allowed.has(senderNick.toLowerCase()) ||
      allowed.has(target.toLowerCase());
    if (!matched) return false;
  }

  if (!isChannelTarget(target)) return true;

  const mentioned = new RegExp(
    `^${escapeRegex(config.nick)}[:,]?\\s+`,
    "i",
  ).test(body);
  const prefixMatched =
    config.triggerPrefixes.length > 0 &&
    config.triggerPrefixes.some((prefix) => body.startsWith(prefix));
  return !config.mentionOnly || mentioned || prefixMatched;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class IrcBot {
  private readonly orchestrator: AgentOrchestrator;
  private socket: Socket | null = null;
  private buffer = "";
  private started = false;
  private stopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private runtimeConfig: IrcRuntimeConfig | null = null;

  constructor(orchestrator: AgentOrchestrator) {
    this.orchestrator = orchestrator;
  }

  start(): void {
    if (this.started) return;
    const config = resolveIrcRuntimeConfig(this.orchestrator.config);
    this.runtimeConfig = config;
    if (!config.enabled) {
      if (!config.server || !config.nick) {
        console.log("IRC bot disabled: IRC_SERVER or IRC_NICK not configured");
      } else if (process.env.ENABLE_IRC === "false") {
        console.log("IRC bot disabled via ENABLE_IRC=false");
      } else {
        console.log("IRC bot disabled in channel configuration");
      }
      return;
    }

    this.started = true;
    this.stopping = false;
    this.connect();
  }

  stop(): void {
    this.stopping = true;
    this.started = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.write("QUIT :Hiro shutdown");
        this.socket.end();
        this.socket.destroy();
      } catch {
        // Ignore shutdown errors.
      }
      this.socket = null;
    }
  }

  private connect(): void {
    const config = this.runtimeConfig;
    if (!config?.enabled || this.stopping) return;
    this.buffer = "";

    const socket = config.useTls
      ? tls.connect({
          host: config.server,
          port: config.port,
          servername: config.server,
        })
      : net.connect({ host: config.server, port: config.port });
    this.socket = socket;
    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      this.reconnectAttempts = 0;
      this.register(config);
      console.log(`IRC connected to ${config.server}:${config.port}`);
    });
    socket.on("data", (chunk) => this.handleData(String(chunk)));
    socket.on("error", (err) => {
      console.warn(`IRC socket error: ${err.message}`);
    });
    socket.on("close", () => {
      this.socket = null;
      if (!this.stopping && this.started && config.reconnect) {
        this.scheduleReconnect();
      }
    });
  }

  private register(config: IrcRuntimeConfig): void {
    if (config.password) this.write(`PASS ${config.password}`);
    this.write(`NICK ${config.nick}`);
    this.write(`USER ${config.username} 0 * :${config.realname}`);
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      void this.handleLine(line).catch((err) => {
        console.warn(
          `IRC line handling failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  }

  private async handleLine(raw: string): Promise<void> {
    const config = this.runtimeConfig;
    if (!config) return;
    const message = parseIrcLine(raw);
    if (message.command === "PING") {
      this.write(`PONG :${message.trailing || message.params[0] || ""}`);
      return;
    }
    if (message.command === "001") {
      if (config.nickservPassword) {
        this.write(`PRIVMSG NickServ :IDENTIFY ${config.nickservPassword}`);
      }
      for (const channel of config.channels) {
        this.write(`JOIN ${channel}`);
      }
      return;
    }
    if (!shouldHandleIrcMessage(message, config)) return;
    await this.handlePrivmsg(message, config);
  }

  private async handlePrivmsg(
    message: IrcMessage,
    config: IrcRuntimeConfig,
  ): Promise<void> {
    const senderNick = nickFromPrefix(message.prefix);
    const target = message.params[0] || "";
    const replyTarget = isChannelTarget(target) ? target : senderNick;
    const prompt = normalizeIrcPrompt(
      message.trailing || "",
      config.nick,
      config.triggerPrefixes,
    );
    if (!prompt) return;

    const sessionId = ["irc", config.server, replyTarget, senderNick].join("_");
    const response = await collectAgentResponse(
      this.orchestrator,
      sessionId,
      prompt,
    );
    for (const part of splitOutboundMessage(response, IRC_LINE_LIMIT)) {
      this.write(`PRIVMSG ${replyTarget} :${part.replace(/\r?\n/g, " ")}`);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopping || !this.started) return;
    this.reconnectAttempts += 1;
    const delayMs = Math.min(60_000, 1_000 * 2 ** this.reconnectAttempts);
    console.log(
      `IRC reconnect attempt ${this.reconnectAttempts} in ${delayMs}ms`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
  }

  private write(line: string): void {
    const socket = this.socket;
    if (!socket || socket.destroyed) return;
    socket.write(`${line}\r\n`);
  }
}
