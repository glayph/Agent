import { createHash } from "node:crypto"
import WebSocket from "ws"
import type Database from "better-sqlite3"
import type { ChatTurnRunner } from "./chat-turn-runner.js"

type RecordValue = Record<string, unknown>
type ChannelName = "telegram" | "discord" | "slack"
type ChannelSettings = {
  name: ChannelName
  enabled: boolean
  token: string
  appToken?: string
  allowFrom: string[]
}
type RuntimeSnapshot = {
  runtime_live: boolean
  connected: boolean
  enabled: boolean
  configured: boolean
  lastError?: string
  lastConnectedAt?: string
  lastEventAt?: string
}
type ManagedEntry = {
  signature: string
  controller: AbortController
  state: RuntimeSnapshot
  sockets: Set<WebSocket>
  worker: Promise<void>
}

const supportedChannels: readonly ChannelName[] = ["telegram", "discord", "slack"]
const isRecord = (value: unknown): value is RecordValue => Boolean(value && typeof value === "object" && !Array.isArray(value))
const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : ""
const identifierValue = (value: unknown): string => typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : ""
const safeError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/(?:xox[baprs]-|xapp-|[0-9]{6,}:[A-Za-z0-9_-]{20,})[A-Za-z0-9._-]*/g, "[redacted]").slice(0, 300)

export function parseAllowFrom(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[\s,;]+/) : []
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))]
}

export function isChannelSenderAllowed(allowFrom: readonly string[], senderId: string): boolean {
  return allowFrom.includes("*") || allowFrom.includes(senderId)
}

export function channelSettings(config: RecordValue, name: ChannelName): ChannelSettings {
  const channels = isRecord(config.channel_list) ? config.channel_list : {}
  const raw = isRecord(channels[name]) ? channels[name] : {}
  const settings = isRecord(raw.settings) ? raw.settings : {}
  const pick = (key: string) => stringValue(settings[key]) || stringValue(raw[key])
  return {
    name,
    // Channels are active by default; only an explicit `enabled: false` switches one off.
    enabled: raw.enabled !== false,
    token: name === "slack" ? pick("bot_token") : pick("token"),
    ...(name === "slack" ? { appToken: pick("app_token") } : {}),
    allowFrom: parseAllowFrom(raw.allow_from ?? settings.allow_from),
  }
}

function hashSignature(settings: ChannelSettings): string {
  return createHash("sha256").update(JSON.stringify(settings)).digest("hex")
}

function platformEventId(channel: ChannelName, id: string): string {
  return `${channel}_${id}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128)
}

function messageContext(channel: ChannelName, address: string, senderId: string): { sessionId: string; contextId: string } {
  const safeAddress = address.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)
  const safeSender = senderId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 100)
  return {
    sessionId: `channel-${channel}-${safeAddress}`,
    contextId: `channel:${channel}:address:${safeAddress}:peer:${safeSender}`,
  }
}

export interface ChannelRuntimeDependencies {
  db: Database.Database
  chatTurns: ChatTurnRunner
  getAppConfig: () => RecordValue
  log: (message: string) => void
  fetchImpl?: typeof fetch
  WebSocketImpl?: typeof WebSocket
  now?: () => string
}

/**
 * Owns the three external chat transports currently implemented by the gateway.
 * Unknown channels remain config-only and are never reported as live.
 */
export class ChannelRuntimeManager {
  private readonly entries = new Map<ChannelName, ManagedEntry>()
  private reconcilePromise: Promise<void> | undefined
  private readonly warnedSenders = new Set<string>()
  private timer: NodeJS.Timeout | undefined
  private readonly fetchImpl: typeof fetch
  private readonly WebSocketImpl: typeof WebSocket
  private readonly now: () => string

  constructor(private readonly deps: ChannelRuntimeDependencies) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.WebSocketImpl = deps.WebSocketImpl ?? WebSocket
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  start(): void {
    void this.reconcile().catch((error) => this.deps.log(`Channel runtime reconciliation failed: ${safeError(error)}`))
    this.timer = setInterval(() => {
      void this.reconcile().catch((error) => this.deps.log(`Channel runtime reconciliation failed: ${safeError(error)}`))
    }, 5_000)
    this.timer.unref?.()
  }

  async reconcile(config = this.deps.getAppConfig()): Promise<void> {
    if (this.reconcilePromise) return this.reconcilePromise
    const work = this.reconcileInternal(config)
    this.reconcilePromise = work
    try { await work } finally { if (this.reconcilePromise === work) this.reconcilePromise = undefined }
  }

  status(name: string): RuntimeSnapshot {
    const entry = this.entries.get(name as ChannelName)
    const cfg = supportedChannels.includes(name as ChannelName) ? channelSettings(this.deps.getAppConfig(), name as ChannelName) : undefined
    if (!cfg) return { runtime_live: false, connected: false, enabled: false, configured: false }
    const current = entry?.state
    const configured = cfg.enabled && Boolean(cfg.token) && (name !== "slack" || Boolean(cfg.appToken))
    return current ? { ...current, enabled: cfg.enabled, configured } : {
      runtime_live: false,
      connected: false,
      enabled: cfg.enabled,
      configured,
    }
  }

  /** Deliver an already-composed proactive notice only to explicit trusted recipients. */
  async sendProactiveNotice(text: string): Promise<void> {
    const message = text.trim()
    if (!message) return
    const config = this.deps.getAppConfig()
    for (const name of ["telegram", "discord"] as const) {
      const settings = channelSettings(config, name)
      if (!settings.enabled || !settings.token) continue
      // Wildcards intentionally authorize inbound traffic only; they are never destinations.
      const recipients = settings.allowFrom.filter((recipient) => recipient !== "*")
      for (const recipient of recipients) {
        try {
          if (name === "telegram") {
            await this.sendTelegram(settings.token, recipient, message)
          } else {
            const dm = await this.fetchImpl("https://discord.com/api/v10/users/@me/channels", {
              method: "POST",
              headers: { authorization: `Bot ${settings.token}`, "content-type": "application/json" },
              body: JSON.stringify({ recipient_id: recipient }),
              signal: AbortSignal.timeout(15_000),
            })
            const body = await dm.json().catch(() => ({})) as RecordValue
            const channelId = stringValue(body.id)
            if (!dm.ok || !channelId) throw new Error("Discord DM channel request failed")
            await this.sendDiscord(settings.token, channelId, message)
          }
        } catch {
          // Do not include exception text, recipient IDs, or message content in gateway logs.
          this.deps.log(`${name} proactive notice delivery failed; channel request was unsuccessful.`)
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    const entries = [...this.entries.entries()]
    this.entries.clear()
    for (const [, entry] of entries) {
      entry.controller.abort()
      for (const socket of entry.sockets) { try { socket.close(1001, "Miki gateway shutting down") } catch {} }
    }
    await Promise.allSettled(entries.map(([, entry]) => entry.worker))
  }

  private async reconcileInternal(config: RecordValue): Promise<void> {
    for (const name of supportedChannels) {
      const settings = channelSettings(config, name)
      // Credentials are enough to connect. An empty allow_from still ignores every sender (see dispatchMessage).
      const configured = settings.enabled && Boolean(settings.token) && (name !== "slack" || Boolean(settings.appToken))
      const signature = configured ? hashSignature(settings) : "disabled"
      const current = this.entries.get(name)
      if (current?.signature === signature && current.state.runtime_live) continue
      if (current) {
        this.entries.delete(name)
        current.controller.abort()
        for (const socket of current.sockets) { try { socket.close(1000, "Channel configuration changed") } catch {} }
      }
      if (!configured) continue
      const controller = new AbortController()
      const state: RuntimeSnapshot = { runtime_live: true, connected: false, enabled: true, configured: true }
      const entry: ManagedEntry = { signature, controller, state, sockets: new Set(), worker: Promise.resolve() }
      this.entries.set(name, entry)
      entry.worker = this.runTransport(settings, entry).catch((error) => {
        if (!controller.signal.aborted) {
          entry.state.connected = false
          entry.state.lastError = safeError(error)
          this.deps.log(`${name} channel runtime stopped: ${entry.state.lastError}`)
        }
      }).finally(() => {
        if (this.entries.get(name) === entry && !controller.signal.aborted) {
          entry.state.connected = false
          entry.state.runtime_live = false
        }
      })
    }
  }

  private async runTransport(settings: ChannelSettings, entry: ManagedEntry): Promise<void> {
    if (settings.name === "telegram") return this.runTelegram(settings, entry)
    if (settings.name === "discord") return this.runDiscord(settings, entry)
    return this.runSlack(settings, entry)
  }

  private async dispatchMessage(input: {
    channel: ChannelName
    address: string
    senderId: string
    senderName?: string
    eventId: string
    text: string
    allowFrom: string[]
    entry: ManagedEntry
    reply: (text: string) => Promise<void>
  }): Promise<void> {
    const text = input.text.trim()
    if (!text || !input.senderId) return
    if (!isChannelSenderAllowed(input.allowFrom, input.senderId)) {
      // Deny by default, but say so once per sender instead of dropping silently.
      const key = `${input.channel}:${input.senderId}`
      if (!this.warnedSenders.has(key) && this.warnedSenders.size < 200) {
        this.warnedSenders.add(key)
        this.deps.log(`${input.channel}: ignored a message from sender ${input.senderId}; add it (or *) to allow_from to let this sender talk to Miki.`)
      }
      return
    }
    const { sessionId, contextId } = messageContext(input.channel, input.address, input.senderId)
    const startMarker = this.now()
    const previous = this.deps.db.prepare("SELECT id FROM chat_messages WHERE context_id=? AND role='assistant' AND kind='normal' ORDER BY created_at DESC LIMIT 1").get(contextId) as { id?: string } | undefined
    const outcome = await this.deps.chatTurns.run({
      sessionId,
      contextId,
      peerId: input.senderId,
      trigger: { type: "user", mode: "send", content: text, attachments: [], clientMessageId: platformEventId(input.channel, input.eventId) },
    })
    input.entry.state.lastEventAt = this.now()
    if (outcome.status === "duplicate" || outcome.status === "rejected" || !outcome.runId) return
    if (outcome.status !== "completed" && outcome.status !== "completed_with_warning") return
    const row = this.deps.db.prepare("SELECT id,content FROM chat_messages WHERE context_id=? AND role='assistant' AND kind='normal' AND created_at>=? ORDER BY created_at DESC LIMIT 1").get(contextId, startMarker) as { id: string; content: string } | undefined
    if (!row || row.id === previous?.id || !row.content.trim()) return
    await input.reply(row.content.trim())
  }

  private async sendTelegram(token: string, chatId: string | number, text: string): Promise<void> {
    for (const chunk of splitMessage(text, 4000)) {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000),
      })
      const body = await response.json().catch(() => ({})) as RecordValue
      if (!response.ok || body.ok === false) throw new Error(`Telegram sendMessage failed with HTTP ${response.status}`)
    }
  }

  private async runTelegram(settings: ChannelSettings, entry: ManagedEntry): Promise<void> {
    let offset = 0
    let failures = 0
    while (!entry.controller.signal.aborted) {
      try {
        const response = await this.fetchImpl(`https://api.telegram.org/bot${settings.token}/getUpdates`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ offset, timeout: 25, allowed_updates: ["message"] }),
          signal: AbortSignal.any([entry.controller.signal, AbortSignal.timeout(35_000)]),
        })
        const body = await response.json().catch(() => ({})) as RecordValue
        if (!response.ok || body.ok === false || !Array.isArray(body.result)) throw new Error(`Telegram getUpdates failed with HTTP ${response.status}`)
        failures = 0
        entry.state.connected = true; entry.state.lastConnectedAt = this.now(); entry.state.lastError = undefined
        for (const update of body.result as RecordValue[]) {
          const updateId = Number(update.update_id)
          if (Number.isFinite(updateId)) offset = Math.max(offset, updateId + 1)
          const message = isRecord(update.message) ? update.message : undefined
          const sender = message && isRecord(message.from) ? message.from : undefined
          const chat = message && isRecord(message.chat) ? message.chat : undefined
          const text = stringValue(message?.text)
          // Telegram uses numeric IDs in its JSON payload; normalize only safe integer IDs.
          const senderId = identifierValue(sender?.id)
          const chatId = identifierValue(chat?.id)
          if (!text || !senderId || !chatId || sender?.is_bot === true || !Number.isFinite(updateId)) continue
          try {
            await this.dispatchMessage({ channel: "telegram", address: chatId, senderId, senderName: stringValue(sender?.username) || stringValue(sender?.first_name), eventId: String(updateId), text, allowFrom: settings.allowFrom, entry, reply: (value) => this.sendTelegram(settings.token, chatId, value) })
          } catch (error) { this.deps.log(`Telegram message handling failed: ${safeError(error)}`) }
        }
      } catch (error) {
        if (entry.controller.signal.aborted) break
        failures += 1; entry.state.connected = false; entry.state.lastError = safeError(error)
        this.deps.log(`Telegram transport error: ${entry.state.lastError}`)
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), entry.controller.signal)
      }
    }
    entry.state.connected = false
  }

  private async runDiscord(settings: ChannelSettings, entry: ManagedEntry): Promise<void> {
    let failures = 0
    while (!entry.controller.signal.aborted) {
      try {
        const response = await this.fetchImpl("https://discord.com/api/v10/gateway/bot", { headers: { authorization: `Bot ${settings.token}` }, signal: AbortSignal.timeout(15_000) })
        const body = await response.json().catch(() => ({})) as RecordValue
        const gateway = stringValue(body.url)
        if (!response.ok || !gateway) throw new Error(`Discord gateway discovery failed with HTTP ${response.status}`)
        await this.connectDiscord(settings, entry, `${gateway.replace(/\/$/, "")}/?v=10&encoding=json`)
        failures = 0
        if (!entry.controller.signal.aborted) await delay(1000, entry.controller.signal)
      } catch (error) {
        if (entry.controller.signal.aborted) break
        failures += 1; entry.state.connected = false; entry.state.lastError = safeError(error)
        this.deps.log(`Discord transport error: ${entry.state.lastError}`)
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), entry.controller.signal)
      }
    }
  }

  private connectDiscord(settings: ChannelSettings, entry: ManagedEntry, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(url)
      entry.sockets.add(ws)
      let settled = false
      let heartbeat: NodeJS.Timeout | undefined
      let seq: number | null = null
      let abortHandler: (() => void) | undefined
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (heartbeat) clearInterval(heartbeat)
        if (abortHandler) entry.controller.signal.removeEventListener("abort", abortHandler)
        entry.sockets.delete(ws)
        if (!entry.controller.signal.aborted) entry.state.connected = false
        error ? reject(error) : resolve()
      }
      const send = (value: RecordValue) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)) }
      abortHandler = () => { try { ws.close(1000, "shutdown") } catch {}; finish() }
      entry.controller.signal.addEventListener("abort", abortHandler, { once: true })
      ws.on("error", (error) => finish(error instanceof Error ? error : new Error("Discord WebSocket error")))
      ws.on("close", () => finish())
      ws.on("message", (raw) => {
        let packet: RecordValue
        try { packet = JSON.parse(raw.toString()) as RecordValue } catch { return }
        if (typeof packet.s === "number") seq = packet.s
        const op = Number(packet.op)
        if (op === 10 && isRecord(packet.d)) {
          const interval = Math.max(1000, Number(packet.d.heartbeat_interval) || 45_000)
          send({ op: 2, d: { token: settings.token, intents: (1 << 9) | (1 << 12) | (1 << 15), properties: { os: process.platform, browser: "miki", device: "miki" } } })
          heartbeat = setInterval(() => send({ op: 1, d: seq }), interval)
          heartbeat.unref?.()
        } else if (op === 1) send({ op: 1, d: seq })
        else if (op === 7 || op === 9) finish()
        else if (op === 0 && packet.t === "READY") {
          entry.state.connected = true; entry.state.lastConnectedAt = this.now(); entry.state.lastError = undefined
        } else if (op === 0 && packet.t === "MESSAGE_CREATE" && isRecord(packet.d)) {
          const message = packet.d
          const author = isRecord(message.author) ? message.author : {}
          const senderId = stringValue(author.id)
          const channelId = stringValue(message.channel_id)
          const text = stringValue(message.content)
          if (!text || !senderId || author.bot === true || !channelId || !stringValue(message.id)) return
          void this.dispatchMessage({ channel: "discord", address: channelId, senderId, senderName: stringValue(author.username), eventId: stringValue(message.id), text, allowFrom: settings.allowFrom, entry, reply: (value) => this.sendDiscord(settings.token, channelId, value) }).catch((error) => this.deps.log(`Discord message handling failed: ${safeError(error)}`))
        }
      })
    })
  }

  private async sendDiscord(token: string, channelId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text, 1900)) {
      const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST", headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: chunk, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`Discord message send failed with HTTP ${response.status}`)
    }
  }

  private async runSlack(settings: ChannelSettings, entry: ManagedEntry): Promise<void> {
    let failures = 0
    while (!entry.controller.signal.aborted) {
      try {
        const response = await this.fetchImpl("https://slack.com/api/apps.connections.open", {
          method: "POST", headers: { authorization: `Bearer ${settings.appToken}`, "content-type": "application/x-www-form-urlencoded" },
          body: "", signal: AbortSignal.timeout(15_000),
        })
        const body = await response.json().catch(() => ({})) as RecordValue
        const url = stringValue(body.url)
        if (!response.ok || body.ok !== true || !url) throw new Error(`Slack Socket Mode connection request failed${body.error ? ` (${String(body.error).slice(0, 100)})` : ` with HTTP ${response.status}`}`)
        await this.connectSlack(settings, entry, url)
        failures = 0
        if (!entry.controller.signal.aborted) await delay(1000, entry.controller.signal)
      } catch (error) {
        if (entry.controller.signal.aborted) break
        failures += 1; entry.state.connected = false; entry.state.lastError = safeError(error)
        this.deps.log(`Slack transport error: ${entry.state.lastError}`)
        await delay(Math.min(30_000, 1000 * 2 ** Math.min(failures, 5)), entry.controller.signal)
      }
    }
  }

  private connectSlack(settings: ChannelSettings, entry: ManagedEntry, url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new this.WebSocketImpl(url)
      entry.sockets.add(ws)
      let settled = false
      let abortHandler: (() => void) | undefined
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (abortHandler) entry.controller.signal.removeEventListener("abort", abortHandler)
        entry.sockets.delete(ws)
        if (!entry.controller.signal.aborted) entry.state.connected = false
        error ? reject(error) : resolve()
      }
      abortHandler = () => { try { ws.close(1000, "shutdown") } catch {}; finish() }
      entry.controller.signal.addEventListener("abort", abortHandler, { once: true })
      ws.on("error", (error) => finish(error instanceof Error ? error : new Error("Slack WebSocket error")))
      ws.on("close", () => finish())
      ws.on("open", () => { entry.state.connected = true; entry.state.lastConnectedAt = this.now(); entry.state.lastError = undefined })
      ws.on("message", (raw) => {
        let packet: RecordValue
        try { packet = JSON.parse(raw.toString()) as RecordValue } catch { return }
        const envelopeId = stringValue(packet.envelope_id)
        if (envelopeId && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ envelope_id: envelopeId }))
        if (packet.type === "disconnect") { finish(); try { ws.close() } catch {}; return }
        if (!isRecord(packet.payload)) return
        entry.state.lastEventAt = this.now()
        const event = packet.payload
        const inner = isRecord(event.event) ? event.event : {}
        if (inner.type !== "message" || inner.subtype || inner.bot_id || packet.type !== "events_api") return
        const senderId = stringValue(inner.user)
        const channelId = stringValue(inner.channel)
        const text = stringValue(inner.text)
        const eventId = stringValue(event.event_id) || envelopeId
        if (!senderId || !channelId || !text || !eventId) return
        void this.dispatchMessage({ channel: "slack", address: channelId, senderId, senderName: stringValue(inner.username), eventId, text, allowFrom: settings.allowFrom, entry, reply: (value) => this.sendSlack(settings.token, channelId, value) }).catch((error) => this.deps.log(`Slack message handling failed: ${safeError(error)}`))
      })
    })
  }

  private async sendSlack(token: string, channelId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text, 39000)) {
      const response = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: channelId, text: chunk, mrkdwn: false, link_names: false }), signal: AbortSignal.timeout(15_000),
      })
      const body = await response.json().catch(() => ({})) as RecordValue
      if (!response.ok || body.ok === false) throw new Error(`Slack chat.postMessage failed${body.error ? ` (${String(body.error).slice(0, 100)})` : ` with HTTP ${response.status}`}`)
    }
  }
}

function splitMessage(text: string, maxLength: number): string[] {
  const chunks: string[] = []
  let remaining = text
  while (remaining.length > maxLength) {
    let splitAt = remaining.lastIndexOf("\n", maxLength)
    if (splitAt < Math.floor(maxLength * 0.5)) splitAt = remaining.lastIndexOf(" ", maxLength)
    if (splitAt < Math.floor(maxLength * 0.5)) splitAt = maxLength
    chunks.push(remaining.slice(0, splitAt).trim())
    remaining = remaining.slice(splitAt).trim()
  }
  if (remaining) chunks.push(remaining)
  return chunks.length ? chunks : [""]
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done() { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
    signal.addEventListener("abort", done, { once: true })
  })
}
