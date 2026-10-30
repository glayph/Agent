import { createHash } from "node:crypto"
import WebSocket from "ws"
import type Database from "better-sqlite3"
import type { ChatTurnOutcome, ChatTurnRunner } from "./chat-turn-runner.js"
import { ChannelDeliveryStore, OutboxWorker, PermanentDeliveryError, type OutboxKind, type OutboxRow, type OutboxStats } from "./outbox.js"
import { factualNoticeFromEvent } from "./notice-fallback.js"

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
  /** Discord session kept across reconnects so a dropped connection can RESUME instead of losing messages. */
  discord?: { sessionId?: string; resumeUrl?: string; seq: number | null }
}

const supportedChannels: readonly ChannelName[] = ["telegram", "discord", "slack"]
// A channel message that joined a running task waits for that task to finish. Long tasks are allowed to take hours.
const CHANNEL_STEER_WAIT_MS = 6 * 60 * 60_000
const isRecord = (value: unknown): value is RecordValue => Boolean(value && typeof value === "object" && !Array.isArray(value))
const stringValue = (value: unknown): string => typeof value === "string" ? value.trim() : ""
const identifierValue = (value: unknown): string => typeof value === "string" ? value.trim() : typeof value === "number" && Number.isSafeInteger(value) ? String(value) : ""
const safeError = (error: unknown): string => (error instanceof Error ? error.message : String(error)).replace(/(?:xox[baprs]-|xapp-|[0-9]{6,}:[A-Za-z0-9_-]{20,})[A-Za-z0-9._-]*/g, "[redacted]").slice(0, 300)

/** Per-message size limit of each platform; a longer reply is queued as several ordered parts. */
const CHANNEL_PART_LIMIT: Record<ChannelName, number> = { telegram: 4000, discord: 1900, slack: 39000 }

/** HTTP 400/403 from a platform means this message can never be delivered (blocked bot, bad request); other failures are retried. */
function deliveryFailure(message: string, status: number, permanentStatuses: readonly number[] = [400, 403]): Error {
  return permanentStatuses.includes(status) ? new PermanentDeliveryError(message) : new Error(message)
}

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
  /** Durable inbox/outbox. Created on first use from `db` when not supplied. */
  delivery?: ChannelDeliveryStore
  /** A connection that stays silent this long is treated as dead and replaced. Default 90 s (MIKI_CHANNEL_STALE_MS). */
  staleMs?: number
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
  private deliveryStore: ChannelDeliveryStore | undefined
  private deliveryWorker: OutboxWorker | undefined

  constructor(private readonly deps: ChannelRuntimeDependencies) {
    this.fetchImpl = deps.fetchImpl ?? fetch
    this.WebSocketImpl = deps.WebSocketImpl ?? WebSocket
    this.now = deps.now ?? (() => new Date().toISOString())
  }

  start(): void {
    // Replies queued before a restart are sent as soon as the gateway is back.
    this.ensureDelivery()
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

  /**
   * Explicitly gated single-recipient delivery used by authenticated E2E sign-off.
   * Only an idempotency key and provider acknowledgement metadata are persisted; message text and tokens are never stored.
   */
  async sendTestMessage(name: string, recipient: string, text: string, idempotencyKey: string): Promise<{ status: "sent" | "duplicate"; channel: string; recipientHash: string; providerAckId: string; idempotencyKey: string }> {
    if (!supportedChannels.includes(name as ChannelName)) throw new Error("channel_test_not_supported")
    const channel = name as ChannelName
    if (!recipient || recipient.length > 200 || recipient === "*") throw new Error("channel_test_recipient_invalid")
    if (!/^MIKI-E2E:[A-Za-z0-9._:-]{8,120}$/.test(text) || text.length > 200) throw new Error("channel_test_marker_invalid")
    if (!/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) throw new Error("channel_test_idempotency_key_invalid")
    this.deps.db.exec(`CREATE TABLE IF NOT EXISTS channel_test_deliveries (
      idempotency_key TEXT PRIMARY KEY, channel TEXT NOT NULL, recipient_hash TEXT NOT NULL,
      status TEXT NOT NULL, provider_ack_id TEXT, error_code TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS idx_channel_test_deliveries_channel_at ON channel_test_deliveries(channel, created_at DESC);`)
    const recipientHash = createHash("sha256").update(recipient).digest("hex")
    const existing = this.deps.db.prepare("SELECT channel,recipient_hash,status,provider_ack_id,error_code FROM channel_test_deliveries WHERE idempotency_key=?").get(idempotencyKey) as { channel: string; recipient_hash: string; status: string; provider_ack_id?: string; error_code?: string } | undefined
    if (existing) {
      if (existing.channel !== channel || existing.recipient_hash !== recipientHash) throw new Error("channel_test_idempotency_key_conflict")
      if (existing.status === "sent" && existing.provider_ack_id) return { status: "duplicate", channel, recipientHash, providerAckId: existing.provider_ack_id, idempotencyKey }
      throw new Error(existing.status === "sending" ? "channel_test_delivery_in_progress" : existing.error_code || "channel_test_delivery_already_failed")
    }
    const insertedAt = this.now()
    const insert = this.deps.db.prepare("INSERT INTO channel_test_deliveries(idempotency_key,channel,recipient_hash,status,created_at,updated_at) VALUES(?,?,?,'sending',?,?)")
    try { insert.run(idempotencyKey, channel, recipientHash, insertedAt, insertedAt) }
    catch { throw new Error("channel_test_delivery_in_progress") }

    try {
      const settings = channelSettings(this.deps.getAppConfig(), channel)
      if (!settings.enabled || !settings.token || (channel === "slack" && !settings.appToken)) throw new Error("channel_test_channel_not_configured")
      let providerAckId = ""
      if (channel === "telegram") {
        const response = await this.fetchImpl(`https://api.telegram.org/bot${settings.token}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: recipient, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000),
        })
        const body = await response.json().catch(() => ({})) as RecordValue
        const result = isRecord(body.result) ? body.result : {}
        if (!response.ok || body.ok !== true || result.message_id == null) throw new Error(response.status === 401 || response.status === 403 ? "channel_test_auth_rejected" : "channel_test_provider_rejected")
        providerAckId = String(result.message_id)
      } else if (channel === "discord") {
        const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(recipient)}/messages`, {
          method: "POST", headers: { authorization: `Bot ${settings.token}`, "content-type": "application/json" },
          body: JSON.stringify({ content: text, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15_000),
        })
        const body = await response.json().catch(() => ({})) as RecordValue
        if (!response.ok || typeof body.id !== "string") throw new Error(response.status === 401 || response.status === 403 ? "channel_test_auth_rejected" : "channel_test_provider_rejected")
        providerAckId = body.id
      } else {
        const response = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
          method: "POST", headers: { authorization: `Bearer ${settings.token}`, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ channel: recipient, text, mrkdwn: false, link_names: false }), signal: AbortSignal.timeout(15_000),
        })
        const body = await response.json().catch(() => ({})) as RecordValue
        if (!response.ok || body.ok !== true || typeof body.ts !== "string") throw new Error(response.status === 401 || response.status === 403 ? "channel_test_auth_rejected" : "channel_test_provider_rejected")
        providerAckId = body.ts
      }
      if (!providerAckId || providerAckId.length > 200) throw new Error("channel_test_ack_missing")
      this.deps.db.prepare("UPDATE channel_test_deliveries SET status='sent',provider_ack_id=?,updated_at=? WHERE idempotency_key=?").run(providerAckId, this.now(), idempotencyKey)
      return { status: "sent", channel, recipientHash, providerAckId, idempotencyKey }
    } catch (error) {
      const code = error instanceof Error && /^[a-z0-9_:-]{1,100}$/i.test(error.message) ? error.message : "channel_test_provider_unavailable"
      this.deps.db.prepare("UPDATE channel_test_deliveries SET status='failed',error_code=?,updated_at=? WHERE idempotency_key=?").run(code, this.now(), idempotencyKey)
      throw new Error(code)
    }
  }

  /** Deliver an already-composed proactive notice only to explicit trusted recipients. */
  async sendProactiveNotice(text: string): Promise<void> {
    const message = text.trim()
    if (!message) return
    const config = this.deps.getAppConfig()
    for (const name of ["telegram", "discord", "slack"] as const) {
      const settings = channelSettings(config, name)
      if (!settings.enabled || !settings.token) continue
      // Wildcards intentionally authorize inbound traffic only; they are never destinations.
      const recipients = settings.allowFrom.filter((recipient) => recipient !== "*")
      for (const recipient of recipients) {
        try {
          if (name === "telegram") {
            await this.sendTelegram(settings.token, recipient, message)
          } else if (name === "slack") {
            // A Slack user ID as the channel posts into that user's DM with the app.
            await this.sendSlack(settings.token, recipient, message)
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
    await this.deliveryWorker?.stop()
    this.deliveryWorker = undefined
  }

  /** Durable inbox/outbox, created on first use. The outbox worker starts with it. */
  private ensureDelivery(): ChannelDeliveryStore {
    if (!this.deliveryStore) {
      this.deliveryStore = this.deps.delivery ?? new ChannelDeliveryStore(this.deps.db, { now: this.now })
    }
    if (!this.deliveryWorker) {
      this.deliveryWorker = new OutboxWorker({ store: this.deliveryStore, send: (row) => this.sendOutboxRow(row), log: this.deps.log })
      this.deliveryWorker.start()
    }
    return this.deliveryStore
  }

  /** Counts for the health report: queued replies, given-up replies and how long the oldest one has waited. */
  deliveryStats(): OutboxStats {
    return this.ensureDelivery().stats()
  }

  /** Makes every waiting reply due now and sends it (called when the network is back). */
  flushOutbox(): void {
    const store = this.ensureDelivery()
    store.releaseBackoff()
    this.deliveryWorker?.kick()
  }

  /** Channel and address a saved chat message came from, when it arrived on an external channel. */
  inboundFor(chatMessageId: string): { channel: string; address: string } | undefined {
    const row = this.ensureDelivery().inboundByChatMessage(chatMessageId)
    return row ? { channel: row.channel, address: row.address } : undefined
  }

  /** Tells the user, on the channel their message came from, that Miki gave up replaying it. Sent once per message. */
  noticeForMessage(chatMessageId: string, why: "expired" | "quarantined"): void {
    const inbound = this.ensureDelivery().inboundByChatMessage(chatMessageId)
    if (!inbound) return
    const detail = why === "expired" ? "The request was too old to answer after the outage." : "The request kept failing and was set aside; send it again if you still need it."
    this.queueOutbound({ channel: inbound.channel as ChannelName, address: inbound.address, chatMessageId, kind: why, text: factualNoticeFromEvent({ type: why === "expired" ? "request_expired" : "request_set_aside", detail }) })
  }

  private async sendOutboxRow(row: OutboxRow): Promise<void> {
    const name = row.channel as ChannelName
    if (!supportedChannels.includes(name)) throw new PermanentDeliveryError(`Unknown channel ${row.channel}`)
    const settings = channelSettings(this.deps.getAppConfig(), name)
    // Not configured right now: keep the reply and try again, since the settings may come back.
    if (!settings.enabled || !settings.token) throw new Error(`${name} channel is not configured`)
    if (name === "telegram") return this.sendTelegram(settings.token, row.address, row.body)
    if (name === "discord") return this.sendDiscord(settings.token, row.address, row.body)
    return this.sendSlack(settings.token, row.address, row.body)
  }

  /** Writes a reply (or notice) to the outbox, split into ordered parts, and asks the worker to send it. */
  private queueOutbound(input: { channel: ChannelName; address: string; chatMessageId: string; text: string; kind?: OutboxKind }): void {
    const store = this.ensureDelivery()
    store.enqueue({ channel: input.channel, address: input.address, chatMessageId: input.chatMessageId, kind: input.kind, parts: splitMessage(input.text, CHANNEL_PART_LIMIT[input.channel]) })
    this.deliveryWorker?.kick()
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
    /** Position of this message in its conversation, for catch-up after a disconnect (Discord message id, Slack ts). */
    cursor?: string
  }): Promise<void> {
    const text = input.text.trim()
    if (input.cursor && (input.channel === "discord" || input.channel === "slack")) {
      try { this.ensureDelivery().setCursor(input.channel, input.address, input.cursor, input.channel === "discord" ? (a, b) => BigInt(a) > BigInt(b) : (a, b) => Number(a) > Number(b)) } catch { /* a bad cursor never blocks the message */ }
    }
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
    const eventKey = platformEventId(input.channel, input.eventId)
    // Remember where this message came from before anything can fail, so a restart can still answer it.
    this.ensureDelivery().recordInbound({ eventId: eventKey, channel: input.channel, address: input.address, senderId: input.senderId, senderName: input.senderName })
    await this.runAndSettle(eventKey, contextId, () => this.deps.chatTurns.run({
      sessionId,
      contextId,
      peerId: input.senderId,
      trigger: { type: "user", mode: "send", content: text, attachments: [], clientMessageId: eventKey },
    }))
    input.entry.state.lastEventAt = this.now()
  }

  /**
   * Resumes a saved message after a restart or a replay and sends its answer through the outbox. A message that did
   * not arrive on an external channel is simply run, as before.
   */
  async resumeInbound(chatMessageId: string, run: () => Promise<ChatTurnOutcome>): Promise<ChatTurnOutcome> {
    const inbound = this.ensureDelivery().inboundByChatMessage(chatMessageId)
    if (!inbound) return run()
    const owner = this.deps.db.prepare("SELECT context_id FROM chat_messages WHERE id=?").get(chatMessageId) as { context_id?: string | null } | undefined
    const contextId = owner?.context_id || messageContext(inbound.channel as ChannelName, inbound.address, inbound.sender_id).contextId
    return this.runAndSettle(inbound.platform_event_id, contextId, run)
  }

  /** Runs a turn, then queues its answer (or a failure notice) for the channel the message came from. */
  private async runAndSettle(eventKey: string, contextId: string, run: () => Promise<ChatTurnOutcome>): Promise<ChatTurnOutcome> {
    const startMarker = this.now()
    const previous = this.deps.db.prepare("SELECT id FROM chat_messages WHERE context_id=? AND role='assistant' AND kind='normal' ORDER BY created_at DESC, rowid DESC LIMIT 1").get(contextId) as { id?: string } | undefined
    const outcome = await run()
    try {
      await this.settleInbound(eventKey, contextId, outcome, startMarker, previous?.id)
    } catch (error) {
      this.deps.log(`Could not queue the channel reply for ${eventKey}: ${safeError(error)}`)
    }
    return outcome
  }

  private async settleInbound(eventKey: string, contextId: string, outcome: ChatTurnOutcome, startMarker: string, previousReplyId?: string): Promise<void> {
    const store = this.ensureDelivery()
    const inbound = store.inboundByEvent(eventKey)
    if (!inbound || inbound.status === "replied") return
    const channel = inbound.channel as ChannelName
    if (outcome.status === "duplicate") {
      // The platform delivered this event again. Do not just drop it: if its answer exists but was never queued, queue it now.
      this.queueSavedReply(inbound.platform_event_id, channel, inbound.address)
      return
    }
    if (outcome.status === "rejected" || !outcome.runId) return
    // A message that joined a run still working (possibly one started on another surface) is answered by that run's
    // final reply, so wait for the run to end before replying on this channel.
    const finalStatus = outcome.status === "steered"
      ? await this.deps.chatTurns.waitForRun(outcome.runId, CHANNEL_STEER_WAIT_MS)
      : outcome.status
    if (finalStatus === "failed") {
      // A failed turn must not leave the user in silence. The notice is built from the recorded failure only.
      const failed = this.deps.db.prepare("SELECT status_detail FROM chat_messages WHERE id=?").get(eventKey) as { status_detail?: string | null } | undefined
      const detail = safeError(failed?.status_detail || "the request could not be completed")
      this.queueOutbound({ channel, address: inbound.address, chatMessageId: eventKey, kind: "notice", text: factualNoticeFromEvent({ type: "request_failed", detail }) })
      store.markInbound(eventKey, "noticed")
      return
    }
    if (finalStatus !== "completed" && finalStatus !== "completed_with_warning") return
    const row = this.deps.db.prepare("SELECT id,content FROM chat_messages WHERE context_id=? AND role='assistant' AND kind='normal' AND created_at>=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(contextId, startMarker) as { id: string; content: string } | undefined
    if (!row || row.id === previousReplyId || !row.content.trim()) return
    this.queueOutbound({ channel, address: inbound.address, chatMessageId: row.id, text: row.content.trim() })
    store.markInbound(eventKey, "replied")
  }

  /**
   * For a message that finished earlier: finds its saved answer and queues it unless it was queued before.
   * Returns true when something was newly queued.
   */
  private queueSavedReply(eventKey: string, channel: ChannelName, address: string): boolean {
    const user = this.deps.db.prepare("SELECT status,created_at,context_id FROM chat_messages WHERE id=?").get(eventKey) as { status?: string; created_at?: string; context_id?: string } | undefined
    if (!user || user.status !== "completed" || !user.created_at || !user.context_id) return false
    const reply = this.deps.db.prepare("SELECT id,content FROM chat_messages WHERE context_id=? AND role='assistant' AND kind='normal' AND created_at>=? ORDER BY created_at ASC, rowid ASC LIMIT 1").get(user.context_id, user.created_at) as { id: string; content: string } | undefined
    if (!reply || !reply.content.trim()) return false
    const store = this.ensureDelivery()
    if (store.hasEntries(reply.id)) { store.markInbound(eventKey, "replied"); return false }
    this.queueOutbound({ channel, address, chatMessageId: reply.id, text: reply.content.trim() })
    store.markInbound(eventKey, "replied")
    return true
  }

  private async sendTelegram(token: string, chatId: string | number, text: string): Promise<void> {
    for (const chunk of splitMessage(text, 4000)) {
      const response = await this.fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: chunk, disable_web_page_preview: true }), signal: AbortSignal.timeout(15_000),
      })
      const body = await response.json().catch(() => ({})) as RecordValue
      if (!response.ok || body.ok === false) throw deliveryFailure(`Telegram sendMessage failed with HTTP ${response.status}`, response.status)
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
            // Not awaited: a long run must not stop the poll loop, or messages sent meanwhile could never reach the run.
            void this.dispatchMessage({ channel: "telegram", address: chatId, senderId, senderName: stringValue(sender?.username) || stringValue(sender?.first_name), eventId: String(updateId), text, allowFrom: settings.allowFrom, entry }).catch((error) => this.deps.log(`Telegram message handling failed: ${safeError(error)}`))
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
        // A saved session reconnects straight to its resume address; otherwise ask Discord where to connect.
        let gateway = entry.discord?.sessionId ? entry.discord.resumeUrl ?? "" : ""
        if (!gateway) {
          const response = await this.fetchImpl("https://discord.com/api/v10/gateway/bot", { headers: { authorization: `Bot ${settings.token}` }, signal: AbortSignal.timeout(15_000) })
          const body = await response.json().catch(() => ({})) as RecordValue
          gateway = stringValue(body.url)
          if (!response.ok || !gateway) throw new Error(`Discord gateway discovery failed with HTTP ${response.status}`)
        }
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
      const session = (entry.discord ??= { seq: null })
      const ws = new this.WebSocketImpl(url)
      entry.sockets.add(ws)
      let settled = false
      let heartbeat: NodeJS.Timeout | undefined
      let acknowledged = true
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
        if (typeof packet.s === "number") session.seq = packet.s
        const op = Number(packet.op)
        if (op === 10 && isRecord(packet.d)) {
          const interval = Math.max(1000, Number(packet.d.heartbeat_interval) || 45_000)
          // A saved session is resumed (Discord replays what was missed); otherwise a fresh identify is sent.
          if (session.sessionId) send({ op: 6, d: { token: settings.token, session_id: session.sessionId, seq: session.seq } })
          else send({ op: 2, d: { token: settings.token, intents: (1 << 9) | (1 << 12) | (1 << 15), properties: { os: process.platform, browser: "miki", device: "miki" } } })
          acknowledged = true
          heartbeat = setInterval(() => {
            if (!acknowledged) {
              // The last heartbeat was never acknowledged: the connection is half-open. Replace it (the session is kept for RESUME).
              this.deps.log("Discord: heartbeat was not acknowledged; reconnecting.")
              try { (ws as unknown as { terminate?: () => void }).terminate?.() } catch {}
              finish()
              return
            }
            acknowledged = false
            send({ op: 1, d: session.seq })
          }, interval)
          heartbeat.unref?.()
        } else if (op === 11) acknowledged = true
        else if (op === 1) send({ op: 1, d: session.seq })
        else if (op === 7) finish()
        else if (op === 9) {
          // Not resumable: forget the session so the next connection identifies again, then catch up from the saved cursors.
          if (packet.d !== true) { session.sessionId = undefined; session.resumeUrl = undefined; session.seq = null }
          finish()
        } else if (op === 0 && packet.t === "READY") {
          entry.state.connected = true; entry.state.lastConnectedAt = this.now(); entry.state.lastError = undefined
          if (isRecord(packet.d)) { session.sessionId = stringValue(packet.d.session_id) || undefined; session.resumeUrl = stringValue(packet.d.resume_gateway_url) || undefined }
          // A fresh session does not replay anything, so ask for the messages that arrived while Miki was away.
          void this.catchUpDiscord(settings, entry).catch((error) => this.deps.log(`Discord catch-up failed: ${safeError(error)}`))
        } else if (op === 0 && packet.t === "RESUMED") {
          entry.state.connected = true; entry.state.lastConnectedAt = this.now(); entry.state.lastError = undefined
        } else if (op === 0 && packet.t === "MESSAGE_CREATE" && isRecord(packet.d)) {
          const message = packet.d
          const author = isRecord(message.author) ? message.author : {}
          const senderId = stringValue(author.id)
          const channelId = stringValue(message.channel_id)
          const text = stringValue(message.content)
          if (!text || !senderId || author.bot === true || !channelId || !stringValue(message.id)) return
          void this.dispatchMessage({ channel: "discord", address: channelId, senderId, senderName: stringValue(author.username), eventId: stringValue(message.id), cursor: stringValue(message.id), text, allowFrom: settings.allowFrom, entry }).catch((error) => this.deps.log(`Discord message handling failed: ${safeError(error)}`))
        }
      })
    })
  }

  /** Fetches what arrived in each known Discord conversation after the last message seen, and handles it in order. */
  private async catchUpDiscord(settings: ChannelSettings, entry: ManagedEntry): Promise<void> {
    for (const { address, last_id } of this.ensureDelivery().cursors("discord")) {
      let after = last_id
      for (let page = 0; page < 5 && !entry.controller.signal.aborted; page += 1) {
        const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(address)}/messages?after=${encodeURIComponent(after)}&limit=50`, { headers: { authorization: `Bot ${settings.token}` }, signal: AbortSignal.timeout(15_000) })
        if (!response.ok) { this.deps.log(`Discord catch-up for one conversation failed with HTTP ${response.status}.`); break }
        const messages = (await response.json().catch(() => [])) as RecordValue[]
        if (!Array.isArray(messages) || messages.length === 0) break
        // Discord returns newest first; answer oldest first.
        const ordered = [...messages].filter(isRecord).sort((a, b) => (BigInt(stringValue(a.id) || "0") < BigInt(stringValue(b.id) || "0") ? -1 : 1))
        for (const message of ordered) {
          const author = isRecord(message.author) ? message.author : {}
          const id = stringValue(message.id)
          after = id || after
          const text = stringValue(message.content)
          if (!id || !text || author.bot === true || !stringValue(author.id)) { if (id) this.ensureDelivery().setCursor("discord", address, id, (x, y) => BigInt(x) > BigInt(y)); continue }
          void this.dispatchMessage({ channel: "discord", address, senderId: stringValue(author.id), senderName: stringValue(author.username), eventId: id, cursor: id, text, allowFrom: settings.allowFrom, entry }).catch((error) => this.deps.log(`Discord message handling failed: ${safeError(error)}`))
        }
        if (messages.length < 50) break
      }
    }
  }

  private async sendDiscord(token: string, channelId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text, 1900)) {
      const response = await this.fetchImpl(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages`, {
        method: "POST", headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ content: chunk, allowed_mentions: { parse: [] } }), signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw deliveryFailure(`Discord message send failed with HTTP ${response.status}`, response.status, [400, 403, 404])
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
      const staleMs = Math.max(3_000, this.deps.staleMs ?? (Number(process.env.MIKI_CHANNEL_STALE_MS) || 90_000))
      let settled = false
      let lastActivity = Date.now()
      let watchdog: NodeJS.Timeout | undefined
      let abortHandler: (() => void) | undefined
      const finish = (error?: Error) => {
        if (settled) return
        settled = true
        if (watchdog) clearInterval(watchdog)
        if (abortHandler) entry.controller.signal.removeEventListener("abort", abortHandler)
        entry.sockets.delete(ws)
        if (!entry.controller.signal.aborted) entry.state.connected = false
        error ? reject(error) : resolve()
      }
      abortHandler = () => { try { ws.close(1000, "shutdown") } catch {}; finish() }
      entry.controller.signal.addEventListener("abort", abortHandler, { once: true })
      ws.on("error", (error) => finish(error instanceof Error ? error : new Error("Slack WebSocket error")))
      ws.on("close", () => finish())
      ws.on("ping", () => { lastActivity = Date.now() })
      ws.on("pong", () => { lastActivity = Date.now() })
      ws.on("open", () => {
        lastActivity = Date.now()
        entry.state.connected = true; entry.state.lastConnectedAt = this.now(); entry.state.lastError = undefined
        // Slack does not replay events that arrived while the socket was down, so ask for them.
        void this.catchUpSlack(settings, entry).catch((error) => this.deps.log(`Slack catch-up failed: ${safeError(error)}`))
        // A connection that has gone silent (no event, ping or pong) is dead even though no "close" ever arrived.
        watchdog = setInterval(() => {
          if (Date.now() - lastActivity > staleMs) {
            this.deps.log("Slack: connection went silent; reconnecting.")
            try { (ws as unknown as { terminate?: () => void }).terminate?.() } catch {}
            finish()
            return
          }
          try { ws.ping?.() } catch { /* the next check will notice */ }
        }, Math.max(1_000, Math.floor(staleMs / 3)))
        watchdog.unref?.()
      })
      ws.on("message", (raw) => {
        lastActivity = Date.now()
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
        const ts = stringValue(inner.ts)
        // The channel + message timestamp names a message the same way live and during catch-up, so it is never handled twice.
        const eventId = ts && channelId ? `${channelId}_${ts}` : stringValue(event.event_id) || envelopeId
        if (!senderId || !channelId || !text || !eventId) return
        void this.dispatchMessage({ channel: "slack", address: channelId, senderId, senderName: stringValue(inner.username), eventId, cursor: ts || undefined, text, allowFrom: settings.allowFrom, entry }).catch((error) => this.deps.log(`Slack message handling failed: ${safeError(error)}`))
      })
    })
  }

  /** Fetches the messages that arrived in each known Slack conversation after the last one seen, and handles them oldest first. */
  private async catchUpSlack(settings: ChannelSettings, entry: ManagedEntry): Promise<void> {
    for (const { address, last_id } of this.ensureDelivery().cursors("slack")) {
      const response = await this.fetchImpl(`https://slack.com/api/conversations.history?channel=${encodeURIComponent(address)}&oldest=${encodeURIComponent(last_id)}&limit=50`, { headers: { authorization: `Bearer ${settings.token}` }, signal: AbortSignal.timeout(15_000) })
      const body = await response.json().catch(() => ({})) as RecordValue
      if (!response.ok || body.ok !== true || !Array.isArray(body.messages)) { this.deps.log(`Slack catch-up for one conversation failed${body.error ? ` (${String(body.error).slice(0, 80)})` : ` with HTTP ${response.status}`}.`); continue }
      const ordered = (body.messages as RecordValue[]).filter(isRecord).sort((a, b) => Number(stringValue(a.ts)) - Number(stringValue(b.ts)))
      for (const message of ordered) {
        const ts = stringValue(message.ts)
        const senderId = stringValue(message.user)
        const text = stringValue(message.text)
        if (!ts || message.subtype || message.bot_id || !senderId || !text) { if (ts) this.ensureDelivery().setCursor("slack", address, ts, (x, y) => Number(x) > Number(y)); continue }
        void this.dispatchMessage({ channel: "slack", address, senderId, eventId: `${address}_${ts}`, cursor: ts, text, allowFrom: settings.allowFrom, entry }).catch((error) => this.deps.log(`Slack message handling failed: ${safeError(error)}`))
      }
    }
  }

  private async sendSlack(token: string, channelId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text, 39000)) {
      const response = await this.fetchImpl("https://slack.com/api/chat.postMessage", {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify({ channel: channelId, text: chunk, mrkdwn: false, link_names: false }), signal: AbortSignal.timeout(15_000),
      })
      const body = await response.json().catch(() => ({})) as RecordValue
      if (!response.ok || body.ok === false) {
        const reason = `Slack chat.postMessage failed${body.error ? ` (${String(body.error).slice(0, 100)})` : ` with HTTP ${response.status}`}`
        // Slack answers HTTP 200 with ok:false for most errors; these ones can never succeed for this message.
        throw ["channel_not_found", "is_archived", "not_in_channel", "msg_too_long", "no_text"].includes(String(body.error)) ? new PermanentDeliveryError(reason) : deliveryFailure(reason, response.status)
      }
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
