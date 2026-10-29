import type Database from "better-sqlite3"

/**
 * Durable delivery state for external chat channels (Telegram / Discord / Slack).
 *
 * - `channel_inbox`  : one row per inbound platform message, so a restart can find which channel/address a saved
 *                      chat message came from and whether it was answered.
 * - `channel_outbox` : one row per outbound message part. A reply is written here first and sent by the worker, so a
 *                      failed send is retried later instead of being lost. Delivery is at-least-once; the unique
 *                      idempotency key (`reply:<chat_message_id>:<part>`) stops the same part being queued twice.
 */

export type OutboxStatus = "pending" | "sent" | "failed"
export type OutboxKind = "reply" | "notice" | "expired" | "quarantined"

export interface OutboxRow {
  id: number
  idempotency_key: string
  channel: string
  address: string
  chat_message_id: string | null
  part_index: number
  body: string
  kind: OutboxKind
  status: OutboxStatus
  attempts: number
  next_attempt_at: string
  last_error: string | null
  created_at: string
  sent_at: string | null
}

export interface InboxRow {
  platform_event_id: string
  channel: string
  address: string
  sender_id: string
  sender_name: string | null
  chat_message_id: string | null
  status: "received" | "replied" | "noticed"
  created_at: string
  replied_at: string | null
}

export interface OutboxStats {
  pending: number
  failed: number
  oldestPendingAgeMs: number
}

/** A send that will never succeed (blocked bot, unknown chat): the row is marked failed instead of retried. */
export class PermanentDeliveryError extends Error {
  readonly permanent = true
  constructor(message: string) {
    super(message)
    this.name = "PermanentDeliveryError"
  }
}

export interface OutboxOptions {
  now?: () => string
  /** First retry delay. Doubles with every attempt. Default 2 seconds. */
  baseDelayMs?: number
  /** Longest retry delay. Default 5 minutes. */
  maxDelayMs?: number
  /** A row older than this is given up on (marked failed). Default 24 hours; 0 keeps rows for ever. */
  ttlMs?: number
}

const DEFAULT_BASE_DELAY_MS = 2_000
const DEFAULT_MAX_DELAY_MS = 5 * 60_000
const DEFAULT_TTL_MS = 24 * 60 * 60_000

function envNumber(name: string): number | undefined {
  const raw = process.env[name]
  if (raw === undefined || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

/** Delivery limits are settings, not fixed rules: environment variables override the defaults. */
export function outboxOptionsFromEnv(): Pick<OutboxOptions, "baseDelayMs" | "maxDelayMs" | "ttlMs"> {
  const ttlHours = envNumber("MIKI_OUTBOX_TTL_HOURS")
  const maxSeconds = envNumber("MIKI_OUTBOX_MAX_DELAY_SECONDS")
  const baseSeconds = envNumber("MIKI_OUTBOX_BASE_DELAY_SECONDS")
  return {
    ...(ttlHours !== undefined ? { ttlMs: ttlHours * 60 * 60_000 } : {}),
    ...(maxSeconds !== undefined ? { maxDelayMs: maxSeconds * 1000 } : {}),
    ...(baseSeconds !== undefined ? { baseDelayMs: baseSeconds * 1000 } : {}),
  }
}

export function ensureChannelDeliverySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS channel_inbox (
      platform_event_id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      address TEXT NOT NULL,
      sender_id TEXT NOT NULL,
      sender_name TEXT,
      chat_message_id TEXT,
      status TEXT NOT NULL DEFAULT 'received',
      created_at TEXT NOT NULL,
      replied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_channel_inbox_chat_message ON channel_inbox(chat_message_id);
    CREATE TABLE IF NOT EXISTS channel_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idempotency_key TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL,
      address TEXT NOT NULL,
      chat_message_id TEXT,
      part_index INTEGER NOT NULL DEFAULT 0,
      body TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'reply',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_channel_outbox_due ON channel_outbox(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_channel_outbox_message ON channel_outbox(chat_message_id);
    CREATE TABLE IF NOT EXISTS channel_cursors (
      channel TEXT NOT NULL,
      address TEXT NOT NULL,
      last_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(channel, address)
    );
  `)
}

export class ChannelDeliveryStore {
  private readonly now: () => string
  private readonly baseDelayMs: number
  private readonly maxDelayMs: number
  private readonly ttlMs: number

  constructor(private readonly db: Database.Database, options: OutboxOptions = {}) {
    ensureChannelDeliverySchema(db)
    const env = outboxOptionsFromEnv()
    this.now = options.now ?? (() => new Date().toISOString())
    this.baseDelayMs = options.baseDelayMs ?? env.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
    this.maxDelayMs = options.maxDelayMs ?? env.maxDelayMs ?? DEFAULT_MAX_DELAY_MS
    this.ttlMs = options.ttlMs ?? env.ttlMs ?? DEFAULT_TTL_MS
  }

  // ---- inbox -------------------------------------------------------------------------------------------------

  /** Returns false when this platform event was already recorded (a duplicate delivery from the platform). */
  recordInbound(input: { eventId: string; channel: string; address: string; senderId: string; senderName?: string; chatMessageId?: string }): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO channel_inbox(platform_event_id,channel,address,sender_id,sender_name,chat_message_id,status,created_at) VALUES(?,?,?,?,?,?,'received',?)")
      .run(input.eventId, input.channel, input.address, input.senderId, input.senderName ?? null, input.chatMessageId ?? input.eventId, this.now())
    return result.changes === 1
  }

  inboundByEvent(eventId: string): InboxRow | undefined {
    return this.db.prepare("SELECT * FROM channel_inbox WHERE platform_event_id=?").get(eventId) as InboxRow | undefined
  }

  inboundByChatMessage(chatMessageId: string): InboxRow | undefined {
    return this.db.prepare("SELECT * FROM channel_inbox WHERE chat_message_id=? ORDER BY created_at DESC LIMIT 1").get(chatMessageId) as InboxRow | undefined
  }

  markInbound(eventId: string, status: "replied" | "noticed"): void {
    this.db.prepare("UPDATE channel_inbox SET status=?, replied_at=? WHERE platform_event_id=?").run(status, this.now(), eventId)
  }

  // ---- catch-up cursors -----------------------------------------------------------------------------------------
  // The last message seen in each conversation. After a disconnect the channel is asked for everything newer.

  /** Remembers the newest message seen at an address. `isNewer` decides whether `id` replaces the stored one. */
  setCursor(channel: string, address: string, id: string, isNewer: (candidate: string, stored: string) => boolean = (a, b) => a > b): void {
    const stored = this.getCursor(channel, address)
    if (stored !== undefined && !isNewer(id, stored)) return
    this.db.prepare("INSERT INTO channel_cursors(channel,address,last_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(channel,address) DO UPDATE SET last_id=excluded.last_id, updated_at=excluded.updated_at").run(channel, address, id, this.now())
  }

  getCursor(channel: string, address: string): string | undefined {
    return (this.db.prepare("SELECT last_id FROM channel_cursors WHERE channel=? AND address=?").get(channel, address) as { last_id?: string } | undefined)?.last_id
  }

  cursors(channel: string): Array<{ address: string; last_id: string }> {
    return this.db.prepare("SELECT address,last_id FROM channel_cursors WHERE channel=? ORDER BY updated_at DESC LIMIT 50").all(channel) as Array<{ address: string; last_id: string }>
  }

  // ---- outbox ------------------------------------------------------------------------------------------------

  /**
   * Queues the parts of one message. Parts whose idempotency key already exists are skipped, so calling this twice
   * for the same message never creates a second copy. Returns how many new rows were written.
   */
  enqueue(input: { channel: string; address: string; chatMessageId: string; kind?: OutboxKind; parts: string[] }): number {
    const kind = input.kind ?? "reply"
    const insert = this.db.prepare("INSERT OR IGNORE INTO channel_outbox(idempotency_key,channel,address,chat_message_id,part_index,body,kind,status,attempts,next_attempt_at,created_at) VALUES(?,?,?,?,?,?,?,'pending',0,?,?)")
    const stamp = this.now()
    let written = 0
    const run = this.db.transaction(() => {
      input.parts.forEach((body, index) => {
        if (!body.trim()) return
        const key = `${kind}:${input.chatMessageId}:${index}`
        written += insert.run(key, input.channel, input.address, input.chatMessageId, index, body, kind, stamp, stamp).changes
      })
    })
    run()
    return written
  }

  /** True when any part of this message was ever queued (pending, sent or failed). */
  hasEntries(chatMessageId: string, kind: OutboxKind = "reply"): boolean {
    const row = this.db.prepare("SELECT 1 AS found FROM channel_outbox WHERE chat_message_id=? AND kind=? LIMIT 1").get(chatMessageId, kind) as { found?: number } | undefined
    return Boolean(row?.found)
  }

  /**
   * The next sendable row per (channel, address). Rows of one address are sent strictly in queue order, so a part or
   * message that is waiting for a retry holds back the ones queued after it.
   */
  nextDueRows(limit = 20): OutboxRow[] {
    const nowIso = this.now()
    const pending = this.db.prepare("SELECT * FROM channel_outbox WHERE status='pending' ORDER BY id ASC LIMIT 500").all() as OutboxRow[]
    const seen = new Set<string>()
    const due: OutboxRow[] = []
    for (const row of pending) {
      const lane = `${row.channel}\u0000${row.address}`
      if (seen.has(lane)) continue
      seen.add(lane)
      if (row.next_attempt_at <= nowIso) due.push(row)
      if (due.length >= limit) break
    }
    return due
  }

  markSent(id: number): void {
    this.db.prepare("UPDATE channel_outbox SET status='sent', sent_at=?, last_error=NULL WHERE id=?").run(this.now(), id)
  }

  /** Records a failed attempt. Returns the new status: `pending` (retry scheduled) or `failed` (given up). */
  markAttemptFailed(row: OutboxRow, error: unknown): OutboxStatus {
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 300)
    const permanent = Boolean(error && typeof error === "object" && (error as { permanent?: boolean }).permanent)
    const expired = this.ttlMs > 0 && Date.parse(this.now()) - Date.parse(row.created_at) > this.ttlMs
    if (permanent || expired) {
      this.db.prepare("UPDATE channel_outbox SET status='failed', attempts=attempts+1, last_error=? WHERE id=?").run(expired && !permanent ? `Gave up: older than the delivery time limit. ${message}` : message, row.id)
      return "failed"
    }
    const attempts = row.attempts + 1
    const delay = this.backoffMs(attempts)
    const next = new Date(Date.parse(this.now()) + delay).toISOString()
    this.db.prepare("UPDATE channel_outbox SET attempts=?, next_attempt_at=?, last_error=? WHERE id=?").run(attempts, next, message, row.id)
    return "pending"
  }

  backoffMs(attempts: number): number {
    return Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** Math.max(0, attempts - 1))
  }

  /** Makes every pending row due now (used when connectivity returns). */
  releaseBackoff(): number {
    return this.db.prepare("UPDATE channel_outbox SET next_attempt_at=? WHERE status='pending' AND next_attempt_at>?").run(this.now(), this.now()).changes
  }

  stats(): OutboxStats {
    const pending = this.db.prepare("SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM channel_outbox WHERE status='pending'").get() as { n: number; oldest: string | null }
    const failed = this.db.prepare("SELECT COUNT(*) AS n FROM channel_outbox WHERE status='failed'").get() as { n: number }
    return {
      pending: pending.n,
      failed: failed.n,
      oldestPendingAgeMs: pending.oldest ? Math.max(0, Date.parse(this.now()) - Date.parse(pending.oldest)) : 0,
    }
  }

  /** Drops delivered rows older than `olderThanMs` (default 7 days). */
  prune(olderThanMs = 7 * 24 * 60 * 60_000): number {
    const cutoff = new Date(Date.parse(this.now()) - olderThanMs).toISOString()
    return this.db.prepare("DELETE FROM channel_outbox WHERE status='sent' AND sent_at<?").run(cutoff).changes
  }
}

export interface OutboxWorkerDeps {
  store: ChannelDeliveryStore
  /** Sends one already-split part. Throw to schedule a retry; throw a PermanentDeliveryError to give up. */
  send: (row: OutboxRow) => Promise<void>
  log: (message: string) => void
  intervalMs?: number
}

/** Sends queued rows, retrying with backoff. One tick runs at a time; addresses are sent in parallel, rows of one address in order. */
export class OutboxWorker {
  private timer: NodeJS.Timeout | undefined
  private running: Promise<void> | undefined
  private stopped = false
  private rerun = false

  constructor(private readonly deps: OutboxWorkerDeps) {}

  start(): void {
    this.stopped = false
    this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? 2_000)
    this.timer.unref?.()
    void this.tick()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.running?.catch(() => undefined)
  }

  /** Ask for a delivery pass now (after something was queued). */
  kick(): void { void this.tick() }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.running) { this.rerun = true; return this.running }
    const work = this.drain().finally(() => {
      if (this.running === work) this.running = undefined
      // Something was queued while this pass was finishing: run once more so it is not left waiting for the timer.
      if (this.rerun && !this.stopped) { this.rerun = false; void this.tick() }
    })
    this.running = work
    return work
  }

  private async drain(): Promise<void> {
    // Each pass sends the first due row of every address. A sent part makes the next one due, so keep going until
    // nothing is due (failed rows get a future retry time and are not returned again until then).
    for (let pass = 0; pass < 200 && !this.stopped; pass += 1) {
      let rows: OutboxRow[] = []
      try { rows = this.deps.store.nextDueRows() } catch (error) { this.deps.log(`Outbox read failed: ${error instanceof Error ? error.message : String(error)}`); return }
      if (rows.length === 0) return
      await Promise.all(rows.map((row) => this.deliver(row)))
    }
  }

  private async deliver(row: OutboxRow): Promise<void> {
    try {
      await this.deps.send(row)
      this.deps.store.markSent(row.id)
    } catch (error) {
      const status = this.deps.store.markAttemptFailed(row, error)
      // Never log message text or tokens; only the channel, attempt count and a short error.
      const text = error instanceof Error ? error.message : String(error)
      this.deps.log(`${row.channel} delivery ${status === "failed" ? "gave up" : "will retry"} (attempt ${row.attempts + 1}): ${text.slice(0, 200)}`)
    }
  }
}
