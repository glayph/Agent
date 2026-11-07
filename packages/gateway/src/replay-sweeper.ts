import * as os from "node:os"
import type Database from "better-sqlite3"
import type { ChatTurnOutcome } from "./chat-turn-runner.js"

/**
 * Finds user messages that never got an answer and runs them again, in order, once the system is healthy.
 *
 * Replayed: messages still `queued`/`processing`/`retrying` that no running turn owns (the process died), and
 * messages that `failed` for a temporary reason (network, timeout, rate limit, overloaded provider).
 * Replay age and attempt count are unbounded by default. Explicit constructor options are
 * available to tests/administrators; legacy environment variables cannot reactivate old caps.
 * Order is preserved within one conversation and concurrency remains resource-controlled.
 */

function structuredReplayFailureKind(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const value = error as { status?: unknown; code?: unknown; retryable?: unknown; category?: unknown; name?: unknown }
  const category = typeof value.category === "string" ? value.category : ""
  if (category === "provider_rate_limit") return "rate_limit"
  if (category === "provider_network") return "network"
  if (category === "provider_unavailable" || category === "local_model_unavailable") return "provider_unavailable"
  const status = typeof value.status === "number" ? value.status : 0
  if (status === 429) return "rate_limit"
  if (status === 408) return "network"
  if (status >= 500) return "provider_unavailable"
  const code = typeof value.code === "string" ? value.code.toUpperCase() : ""
  if (["ECONNRESET", "ECONNREFUSED", "ECONNUNREACH", "EHOSTUNREACH", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return "network"
  if (value.retryable === true) return "transient"
  return undefined
}

export interface ReplayCandidate {
  id: string
  session_id: string
  context_id: string | null
  status: string
  status_detail: string | null
  failure_kind?: string | null
  created_at: string
  replay_attempts: number
}

export interface ReplaySweeperDeps {
  db: Database.Database
  /** Runs one saved message again (a `carryover` turn). Must resolve when the turn ends. */
  replay: (message: ReplayCandidate) => Promise<ChatTurnOutcome>
  isContextActive: (contextId: string) => boolean
  /** Called when a message is given up on, so the user can be told on the channel it came from. */
  onGivenUp?: (message: ReplayCandidate, why: "expired" | "quarantined") => void
  log: (message: string) => void
  now?: () => number
  ttlMs?: number
  maxAttempts?: number
  concurrency?: number
}

export function ensureReplayColumns(db: Database.Database): void {
  const columns = db.prepare("PRAGMA table_info(chat_messages)").all() as Array<{ name: string }>
  if (!columns.some((c) => c.name === "replay_attempts")) db.exec("ALTER TABLE chat_messages ADD COLUMN replay_attempts INTEGER NOT NULL DEFAULT 0")
  if (!columns.some((c) => c.name === "replay_state")) db.exec("ALTER TABLE chat_messages ADD COLUMN replay_state TEXT")
  if (!columns.some((c) => c.name === "failure_kind")) db.exec("ALTER TABLE chat_messages ADD COLUMN failure_kind TEXT")
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name]
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

export function replayLimitsFromEnv(): { concurrency?: number } {
  // Replay TTL/attempt environment variables were legacy termination knobs.
  // Retain only the concurrency resource preference.
  const concurrency = numberFromEnv("MIKI_REPLAY_CONCURRENCY")
  return concurrency !== undefined && concurrency >= 1 ? { concurrency: Math.floor(concurrency) } : {}
}

export interface SweepResult { replayed: number; expired: number; quarantined: number; skipped: number }

export class ReplaySweeper {
  private sweeping: Promise<SweepResult> | undefined
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly maxAttempts: number
  private readonly concurrency: number

  constructor(private readonly deps: ReplaySweeperDeps) {
    ensureReplayColumns(deps.db)
    const env = replayLimitsFromEnv()
    this.now = deps.now ?? (() => Date.now())
    this.ttlMs = deps.ttlMs ?? 0
    this.maxAttempts = deps.maxAttempts ?? Number.POSITIVE_INFINITY
    this.concurrency = Math.max(1, deps.concurrency ?? env.concurrency ?? os.availableParallelism())
  }

  /** One sweep. A sweep that is already running is joined, not duplicated. */
  sweep(reason: string): Promise<SweepResult> {
    if (this.sweeping) return this.sweeping
    const work = this.run(reason).finally(() => { if (this.sweeping === work) this.sweeping = undefined })
    this.sweeping = work
    return work
  }

  private candidates(): ReplayCandidate[] {
    return this.deps.db.prepare(
      "SELECT id,session_id,context_id,status,status_detail,failure_kind,created_at,replay_attempts FROM chat_messages WHERE role='user' AND replay_state IS NULL AND status IN ('queued','processing','retrying','failed') ORDER BY created_at ASC LIMIT 500",
    ).all() as ReplayCandidate[]
  }

  private async run(reason: string): Promise<SweepResult> {
    const result: SweepResult = { replayed: 0, expired: 0, quarantined: 0, skipped: 0 }
    const byContext = new Map<string, ReplayCandidate[]>()
    for (const message of this.candidates()) {
      const context = message.context_id || message.session_id
      // A message that a running turn still owns is not abandoned: the engine is retrying it in place.
      if (this.deps.isContextActive(context)) { result.skipped += 1; continue }
      // Only structured provider failure categories are replayable. Unknown/legacy prose is
      // not parsed as control flow, so a real refusal or malformed request stays failed.
      const retryableFailure = new Set(["transient", "rate_limit", "network", "provider_unavailable"]).has(message.failure_kind || "")
      if (message.status === "failed" && !retryableFailure) { result.skipped += 1; continue }
      if (this.ttlMs > 0 && this.now() - Date.parse(message.created_at) > this.ttlMs) {
        this.giveUp(message, "expired", "Too old to replay.")
        result.expired += 1
        continue
      }
      if (Number.isFinite(this.maxAttempts) && this.maxAttempts > 0 && message.replay_attempts >= this.maxAttempts) {
        this.giveUp(message, "quarantined", `Replay limit of ${this.maxAttempts} reached; set aside so it cannot keep failing.`)
        result.quarantined += 1
        continue
      }
      const list = byContext.get(context) ?? []
      list.push(message)
      byContext.set(context, list)
    }
    if (byContext.size === 0) return result
    this.deps.log(`Replay (${reason}): ${[...byContext.values()].reduce((n, l) => n + l.length, 0)} unanswered message(s) in ${byContext.size} conversation(s).`)
    const queue = [...byContext.values()]
    const worker = async () => {
      for (let list = queue.shift(); list; list = queue.shift()) {
        // Inside one conversation the order of the user's messages is kept.
        for (const message of list) {
          if (await this.replayOne(message)) result.replayed += 1
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker))
    return result
  }

  private async replayOne(message: ReplayCandidate): Promise<boolean> {
    const db = this.deps.db
    // Counted BEFORE the run: a message that crashes the process still has its attempt on record after the restart.
    const claimed = db.prepare("UPDATE chat_messages SET replay_attempts=replay_attempts+1, status='queued', status_detail='Replaying after recovery.', failure_kind=NULL WHERE id=? AND role='user' AND status IN ('queued','processing','retrying','failed') AND replay_attempts=?").run(message.id, message.replay_attempts)
    if (claimed.changes !== 1) return false
    try {
      const outcome = await this.deps.replay({ ...message, status: "queued", replay_attempts: message.replay_attempts + 1 })
      return outcome.status !== "rejected" && outcome.status !== "duplicate"
    } catch (error) {
      this.deps.log(`Replay of message ${message.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      db.prepare("UPDATE chat_messages SET status='failed', status_detail=?, failure_kind=? WHERE id=? AND status IN ('queued','processing','retrying')").run(`Replay failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`, structuredReplayFailureKind(error) ?? message.failure_kind ?? null, message.id)
      return false
    }
  }

  private giveUp(message: ReplayCandidate, why: "expired" | "quarantined", detail: string): void {
    this.deps.db.prepare("UPDATE chat_messages SET status='failed', status_detail=?, replay_state=? WHERE id=?").run(detail, why, message.id)
    try { this.deps.onGivenUp?.(message, why) } catch { /* notice problems never stop a sweep */ }
  }
}
