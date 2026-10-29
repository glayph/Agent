import type Database from "better-sqlite3"
import type { RecoveryIncident } from "./recovery-manager.js"

/**
 * Self-learning for recovery. Every closed incident is written to the learning store and to the identity memory
 * (what failed, how long it lasted, what fixed it), and the one setting this module may change on its own, how many
 * good checks are needed before recovery is declared, is adjusted inside fixed bounds. Each adjustment is logged
 * and stored with its reason; nothing is changed silently.
 */

export type IncidentKind = "model" | "network" | "database" | "crash" | "other"

export function classifyIncident(reason: string): IncidentKind {
  if (/^crash:/i.test(reason)) return "crash"
  if (/database/i.test(reason)) return "database"
  if (/cannot reach|network|dns|offline/i.test(reason)) return "network"
  if (/model/i.test(reason)) return "model"
  return "other"
}

export interface RecoveryLearningDeps {
  db: Database.Database
  /** Writes one experience to the learning store. */
  record: (input: { runId: string; sessionId: string; taskClass: string; context: string; actionKey: string; outcome: "success" | "failure"; rewardInput: Record<string, unknown>; metadata: Record<string, unknown> }) => void
  /** Appends one line to the identity memory notes (a no-op when there is no identity folder). */
  remember: (line: string) => void
  log: (message: string) => void
  now?: () => Date
  /** An incident that starts within this long of the previous one ending is a flap. Default 2 minutes. */
  flapWindowMs?: number
  minGreen?: number
  maxGreen?: number
  /** Quiet incidents in a row before the requirement is lowered again. Default 5. */
  calmBeforeRelax?: number
}

export function ensureTuningSchema(db: Database.Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS recovery_tuning (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, reason TEXT)")
}

export class RecoveryLearning {
  private readonly minGreen: number
  private readonly maxGreen: number
  private readonly flapWindowMs: number
  private readonly calmBeforeRelax: number
  private readonly now: () => Date

  constructor(private readonly deps: RecoveryLearningDeps) {
    ensureTuningSchema(deps.db)
    this.now = deps.now ?? (() => new Date())
    this.minGreen = Math.max(1, deps.minGreen ?? (Number(process.env.MIKI_RECOVERY_GREEN_MIN) || 3))
    this.maxGreen = Math.max(this.minGreen, deps.maxGreen ?? (Number(process.env.MIKI_RECOVERY_GREEN_MAX) || 6))
    this.flapWindowMs = deps.flapWindowMs ?? 120_000
    this.calmBeforeRelax = Math.max(1, deps.calmBeforeRelax ?? 5)
  }

  private get(key: string): string | undefined {
    return (this.deps.db.prepare("SELECT value FROM recovery_tuning WHERE key=?").get(key) as { value?: string } | undefined)?.value
  }

  private set(key: string, value: string, reason: string): void {
    this.deps.db.prepare("INSERT INTO recovery_tuning(key,value,updated_at,reason) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, reason=excluded.reason").run(key, value, this.now().toISOString(), reason)
  }

  /** How many consecutive good checks to require now (always between the minimum and maximum). */
  requiredGreen(): number {
    const stored = Number(this.get("required_green"))
    return Number.isFinite(stored) ? Math.min(this.maxGreen, Math.max(this.minGreen, stored)) : this.minGreen
  }

  onIncidentClosed(incident: RecoveryIncident): void {
    const kind = classifyIncident(incident.reason)
    const started = Date.parse(incident.started_at)
    const ended = Date.parse(incident.ended_at ?? incident.started_at)
    const previous = this.deps.db.prepare("SELECT ended_at FROM recovery_incidents WHERE id<? AND ended_at IS NOT NULL ORDER BY id DESC LIMIT 1").get(incident.id) as { ended_at: string } | undefined
    const flapped = Boolean(previous && started - Date.parse(previous.ended_at) < this.flapWindowMs && started >= Date.parse(previous.ended_at))
    const green = this.requiredGreen()
    const minutes = Math.max(0, Math.round((ended - started) / 60_000))

    this.deps.record({
      runId: `recovery:${incident.id}`,
      sessionId: "recovery",
      taskClass: "recovery",
      context: `${kind} incident: ${incident.reason}`,
      actionKey: `recovery:${kind}:green-${green}`,
      outcome: flapped ? "failure" : "success",
      rewardInput: { outcome: flapped ? "failure" : "success", completionQuality: flapped ? 0.3 : 1, taskSuccess: flapped ? 0 : 1, verificationSuccess: flapped ? 0 : 1, retryCount: incident.checks_failed, latencyScore: Math.max(0, Math.min(1, 1 - minutes / 60)) },
      metadata: { kind, flapped, checksFailed: incident.checks_failed, replayed: incident.replayed, requiredGreen: green },
    })
    this.deps.remember(`${this.now().toISOString().slice(0, 16)}Z recovery: ${kind} outage "${incident.reason.slice(0, 120)}" lasted about ${minutes} min; ${incident.replayed} unanswered message(s) replayed${flapped ? "; it flapped (came back soon after the previous one)" : ""}.`)
    this.tune(incident, kind, flapped, green)
  }

  private tune(incident: RecoveryIncident, kind: IncidentKind, flapped: boolean, green: number): void {
    if (flapped) {
      this.set("calm_streak", "0", "reset by a flapping incident")
      const next = Math.min(this.maxGreen, green + 1)
      if (next !== green) {
        this.set("required_green", String(next), `incident ${incident.id} (${kind}) flapped`)
        this.deps.log(`Recovery tuning: required green checks ${green} -> ${next} because incident ${incident.id} (${kind}) came back soon after the previous one. Limits ${this.minGreen}-${this.maxGreen}.`)
      }
      return
    }
    const calm = (Number(this.get("calm_streak")) || 0) + 1
    if (calm >= this.calmBeforeRelax && green > this.minGreen) {
      this.set("required_green", String(green - 1), `${calm} calm incidents in a row`)
      this.set("calm_streak", "0", "relaxed")
      this.deps.log(`Recovery tuning: required green checks ${green} -> ${green - 1} after ${calm} incidents without a flap. Limits ${this.minGreen}-${this.maxGreen}.`)
    } else {
      this.set("calm_streak", String(calm), "no flap")
    }
  }
}
