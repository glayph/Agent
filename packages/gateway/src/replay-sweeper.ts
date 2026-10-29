import type Database from "better-sqlite3"
import type { ChatTurnOutcome } from "./chat-turn-runner.js"

/**
 * Finds user messages that never got an answer and runs them again, in order, once the system is healthy.
 *
 * Replayed: messages still `queued`/`processing`/`retrying` that no running turn owns (the process died), and
 * messages that `failed` for a temporary reason (network, timeout, rate limit, overloaded provider).
 * Limits (each one a setting): at most `maxAttempts` replays per message (poison-pill protection), only messages
 * younger than `ttlMs`, order kept inside one conversation, at most `concurrency` conversations at once.
 */

export const REPLAY_TRANSIENT_ERROR = /timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|network|\b(?:429|500|502|503|504)\b|rate.?limit|overloaded|temporarily|interrupted by a gateway restart|unable to reach|replay failed, will retry/i

export interface ReplayCandidate {
  id: string
  session_id: string
  context_id: string | null
  status: string
  status_detail: string | null
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
}

function numberFromEnv(name: string): number | undefined {
  const raw = process.env[name]
  const value = raw === undefined || raw.trim() === "" ? NaN : Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : undefined
}

export function replayLimitsFromEnv(): { ttlMs?: number; maxAttempts?: number; concurrency?: number } {
  const ttlHours = numberFromEnv("MIKI_REPLAY_TTL_HOURS")
  const attempts = numberFromEnv("MIKI_REPLAY_MAX_ATTEMPTS")
  const concurrency = numberFromEnv("MIKI_REPLAY_CONCURRENCY")
  return {
    ...(ttlHours !== undefined ? { ttlMs: ttlHours * 3_600_000 } : {}),
    ...(attempts !== undefined ? { maxAttempts: Math.floor(attempts) } : {}),
    ...(concurrency !== undefined && concurrency >= 1 ? { concurrency: Math.floor(concurrency) } : {}),
  }
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
    this.ttlMs = deps.ttlMs ?? env.ttlMs ?? 24 * 3_600_000
    this.maxAttempts = deps.maxAttempts ?? env.maxAttempts ?? 3
    this.concurrency = Math.max(1, deps.concurrency ?? env.concurrency ?? 2)
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
      "SELECT id,session_id,context_id,status,status_detail,created_at,replay_attempts FROM chat_messages WHERE role='user' AND replay_state IS NULL AND status IN ('queued','processing','retrying','failed') ORDER BY created_at ASC LIMIT 500",
    ).all() as ReplayCandidate[]
  }

  private async run(reason: string): Promise<SweepResult> {
    const result: SweepResult = { replayed: 0, expired: 0, quarantined: 0, skipped: 0 }
    const byContext = new Map<string, ReplayCandidate[]>()
    for (const message of this.candidates()) {
      const context = message.context_id || message.session_id
      // A message that a running turn still owns is not abandoned: the engine is retrying it in place.
      if (this.deps.isContextActive(context)) { result.skipped += 1; continue }
      // A failed message is replayed only for a temporary reason; a real refusal or a user error stays failed.
      if (message.status === "failed" && !REPLAY_TRANSIENT_ERROR.test(message.status_detail || "")) { result.skipped += 1; continue }
      if (this.ttlMs > 0 && this.now() - Date.parse(message.created_at) > this.ttlMs) {
        this.giveUp(message, "expired", "Too old to replay.")
        result.expired += 1
        continue
      }
      if (message.replay_attempts >= this.maxAttempts) {
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
    const claimed = db.prepare("UPDATE chat_messages SET replay_attempts=replay_attempts+1, status='queued', status_detail='Replaying after recovery.' WHERE id=? AND role='user' AND status IN ('queued','processing','retrying','failed') AND replay_attempts=?").run(message.id, message.replay_attempts)
    if (claimed.changes !== 1) return false
    try {
      const outcome = await this.deps.replay({ ...message, status: "queued", replay_attempts: message.replay_attempts + 1 })
      return outcome.status !== "rejected" && outcome.status !== "duplicate"
    } catch (error) {
      this.deps.log(`Replay of message ${message.id} failed: ${error instanceof Error ? error.message : String(error)}`)
      db.prepare("UPDATE chat_messages SET status='failed', status_detail=? WHERE id=? AND status IN ('queued','processing','retrying')").run(`Replay failed, will retry: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`, message.id)
      return false
    }
  }

  private giveUp(message: ReplayCandidate, why: "expired" | "quarantined", detail: string): void {
    this.deps.db.prepare("UPDATE chat_messages SET status='failed', status_detail=?, replay_state=? WHERE id=?").run(detail, why, message.id)
    try { this.deps.onGivenUp?.(message, why) } catch { /* notice problems never stop a sweep */ }
  }
}
