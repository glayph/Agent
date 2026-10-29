import fs from "node:fs"
import path from "node:path"
import Database from "better-sqlite3"
import { ensureRecoverySchema } from "./recovery-manager.js"

/**
 * Process- and database-level safety.
 *  - a database that fails `PRAGMA quick_check` at startup is set aside and the newest good backup is restored;
 *  - the database is backed up on a timer (online backup, newest few kept);
 *  - an unhandled exception / rejection is written down and the process stops in a controlled way, so the supervisor
 *    restarts it and the reason is not lost;
 *  - a boot marker shows whether the previous process ended cleanly, and a crash loop is detected from the incidents.
 */

type Log = (message: string) => void

export interface DatabaseCheckResult {
  status: "absent" | "ok" | "restored" | "fresh"
  restoredFrom?: string
  corruptMovedTo?: string
  reason?: string
}

function quickCheck(file: string): { ok: boolean; reason?: string } {
  let db: Database.Database | undefined
  try {
    db = new Database(file, { readonly: false, fileMustExist: true })
    const rows = db.prepare("PRAGMA quick_check").all() as Array<Record<string, string>>
    const first = rows.length > 0 ? Object.values(rows[0])[0] : "no result"
    return first === "ok" ? { ok: true } : { ok: false, reason: String(first).slice(0, 200) }
  } catch (error) {
    return { ok: false, reason: (error instanceof Error ? error.message : String(error)).slice(0, 200) }
  } finally {
    try { db?.close() } catch { /* nothing to close */ }
  }
}

export function listBackups(backupDir: string): string[] {
  try {
    return fs.readdirSync(backupDir).filter((name) => /^miki-runtime-.*\.sqlite$/.test(name)).sort().reverse().map((name) => path.join(backupDir, name))
  } catch { return [] }
}

/** Run BEFORE the database is opened. Never throws. */
export function ensureHealthyDatabase(dbPath: string, backupDir: string, log: Log, now: () => Date = () => new Date()): DatabaseCheckResult {
  if (!fs.existsSync(dbPath)) return { status: "absent" }
  const check = quickCheck(dbPath)
  if (check.ok) return { status: "ok" }
  const stamp = now().toISOString().replace(/[:.]/g, "-")
  const aside = `${dbPath}.corrupt-${stamp}`
  log(`Database integrity check failed (${check.reason}). Setting the damaged file aside as ${path.basename(aside)}.`)
  try {
    fs.renameSync(dbPath, aside)
    for (const suffix of ["-wal", "-shm"]) if (fs.existsSync(dbPath + suffix)) fs.renameSync(dbPath + suffix, aside + suffix)
  } catch (error) {
    log(`Could not move the damaged database aside: ${error instanceof Error ? error.message : String(error)}`)
    return { status: "ok", reason: "damaged database could not be moved; continuing with it" }
  }
  for (const backup of listBackups(backupDir)) {
    if (!quickCheck(backup).ok) continue
    try {
      fs.copyFileSync(backup, dbPath)
      log(`Restored the database from backup ${path.basename(backup)}.`)
      return { status: "restored", restoredFrom: backup, corruptMovedTo: aside, reason: check.reason }
    } catch (error) {
      log(`Could not restore ${path.basename(backup)}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  log("No usable backup was found; starting with a new database. The damaged file was kept.")
  return { status: "fresh", corruptMovedTo: aside, reason: check.reason }
}

export class DatabaseBackups {
  private timer: NodeJS.Timeout | undefined
  constructor(private readonly db: Database.Database, private readonly dir: string, private readonly log: Log, private readonly options: { keep?: number; intervalMs?: number; now?: () => Date } = {}) {}

  start(): void {
    const hours = Number(process.env.MIKI_DB_BACKUP_HOURS)
    const interval = this.options.intervalMs ?? (Number.isFinite(hours) && hours > 0 ? hours * 3_600_000 : 6 * 3_600_000)
    this.timer = setInterval(() => { void this.backupNow().catch(() => undefined) }, interval)
    this.timer.unref?.()
  }

  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }

  async backupNow(): Promise<string | undefined> {
    fs.mkdirSync(this.dir, { recursive: true })
    const stamp = (this.options.now?.() ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")
    const target = path.join(this.dir, `miki-runtime-${stamp}.sqlite`)
    try {
      await this.db.backup(target)
      if (!quickCheck(target).ok) { fs.rmSync(target, { force: true }); this.log("A database backup failed its integrity check and was discarded."); return undefined }
    } catch (error) {
      this.log(`Database backup failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const keep = Math.max(1, this.options.keep ?? (Number(process.env.MIKI_DB_BACKUP_KEEP) || 5))
    for (const old of listBackups(this.dir).slice(keep)) fs.rmSync(old, { force: true })
    return target
  }
}

// ---- boot marker and crash incidents --------------------------------------------------------------------------

export interface BootInfo {
  /** The previous process did not end with a clean shutdown (crash, kill, out of memory, watchdog restart). */
  previousUncleanExit: boolean
  /** Reason written by the crash handler of the previous process, when there was one. */
  previousCrashReason?: string
  crashesInWindow: number
  crashLoop: boolean
}

const markerPath = (dataDir: string) => path.join(dataDir, "gateway-boot.json")

function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}

export function recordCrash(db: Database.Database, reason: string, at: string): void {
  ensureRecoverySchema(db)
  db.prepare("INSERT INTO recovery_incidents(started_at,ended_at,reason,remedy) VALUES(?,?,?,?)").run(at, at, `crash: ${reason}`.slice(0, 300), "process restarted")
}

export function recentCrashCount(db: Database.Database, windowMs: number, nowMs = Date.now()): number {
  ensureRecoverySchema(db)
  const since = new Date(nowMs - windowMs).toISOString()
  return (db.prepare("SELECT COUNT(*) AS n FROM recovery_incidents WHERE reason LIKE 'crash:%' AND started_at>=?").get(since) as { n: number }).n
}

/** Reads the previous process's marker, records a crash incident when it did not end cleanly, and writes a new marker. */
export function beginBoot(db: Database.Database, dataDir: string, log: Log, now: () => Date = () => new Date()): BootInfo {
  const windowMs = (Number(process.env.MIKI_CRASH_LOOP_WINDOW_MINUTES) || 10) * 60_000
  const limit = Math.max(2, Number(process.env.MIKI_CRASH_LOOP_LIMIT) || 5)
  let previous: { cleanExit?: boolean; crashReason?: string } | undefined
  try { previous = JSON.parse(fs.readFileSync(markerPath(dataDir), "utf8")) } catch { previous = undefined }
  const unclean = Boolean(previous && previous.cleanExit !== true)
  if (unclean) {
    const reason = previous?.crashReason || "the process ended without a clean shutdown"
    try { recordCrash(db, reason, now().toISOString()) } catch { /* incident recording is best effort */ }
    log(`The previous gateway process did not shut down cleanly (${reason}).`)
  }
  const count = (() => { try { return recentCrashCount(db, windowMs, now().getTime()) } catch { return 0 } })()
  try { writeAtomic(markerPath(dataDir), { startedAt: now().toISOString(), pid: process.pid, cleanExit: false }) } catch { /* ignore */ }
  return { previousUncleanExit: unclean, previousCrashReason: previous?.crashReason, crashesInWindow: count, crashLoop: count >= limit }
}

export function markCleanExit(dataDir: string): void {
  try {
    const current = JSON.parse(fs.readFileSync(markerPath(dataDir), "utf8")) as Record<string, unknown>
    writeAtomic(markerPath(dataDir), { ...current, cleanExit: true, endedAt: new Date().toISOString() })
  } catch { /* nothing to mark */ }
}

/** Notes why the process is stopping, so the next boot can record it even if the database is the problem. */
export function noteCrashReason(dataDir: string, reason: string): void {
  try {
    let current: Record<string, unknown> = {}
    try { current = JSON.parse(fs.readFileSync(markerPath(dataDir), "utf8")) } catch { /* new marker */ }
    writeAtomic(markerPath(dataDir), { ...current, cleanExit: false, crashReason: reason.slice(0, 300) })
  } catch { /* last-gasp write; nothing more to do */ }
}

// An unhandled rejection is usually one failed channel or network call. It is logged and the gateway keeps running;
// the process stops only when rejections keep coming (more than REJECTION_EXIT_LIMIT within REJECTION_WINDOW_MS).
export const REJECTION_EXIT_LIMIT = 5
export const REJECTION_WINDOW_MS = 10 * 60_000

/** Sliding-window counter. Returns true once more than `limit` rejections fall inside `windowMs`. */
export function createRejectionGuard(limit = REJECTION_EXIT_LIMIT, windowMs = REJECTION_WINDOW_MS, now: () => number = Date.now): () => boolean {
  const times: number[] = []
  return () => {
    const at = now()
    times.push(at)
    while (times.length > 0 && times[0] <= at - windowMs) times.shift()
    return times.length > limit
  }
}

interface CrashOptions {
  dataDir: string
  log: Log
  shutdown: () => Promise<void> | void
  proc?: Pick<NodeJS.Process, "on" | "exit">
}

type StopWithReason = (kind: string, text: string) => void

function describeFailure(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function stackOf(error: unknown): string {
  return error instanceof Error && error.stack ? `\n${error.stack}` : ""
}

/** Controlled stop: record the reason, close what can be closed (never waiting longer than 5 s), then exit 1. */
function controlledStop(options: CrashOptions, proc: Pick<NodeJS.Process, "on" | "exit">): StopWithReason {
  let stopping = false
  return (kind, text) => {
    if (stopping) return
    stopping = true
    noteCrashReason(options.dataDir, `${kind}: ${text}`)
    const deadline = setTimeout(() => proc.exit(1), 5_000)
    deadline.unref?.()
    Promise.resolve().then(() => options.shutdown()).catch(() => undefined).finally(() => proc.exit(1))
  }
}

function registerRejectionGuard(options: CrashOptions, proc: Pick<NodeJS.Process, "on" | "exit">, stop: StopWithReason): void {
  const guard = createRejectionGuard()
  proc.on("unhandledRejection", (error: unknown) => {
    const text = describeFailure(error)
    options.log(`unhandled rejection (gateway keeps running): ${text}${stackOf(error)}`)
    if (!guard()) return
    options.log(`more than ${REJECTION_EXIT_LIMIT} unhandled rejections in ${REJECTION_WINDOW_MS / 60_000} minutes; stopping so the supervisor can restart the gateway.`)
    stop("unhandled rejection", text)
  })
}

/** Rejections only (used when the full recovery mode is off). An uncaught exception still ends the process. */
export function installRejectionGuard(options: CrashOptions): void {
  const proc = options.proc ?? process
  registerRejectionGuard(options, proc, controlledStop(options, proc))
}

/** Full crash handling (recovery mode): an uncaught exception stops the process in a controlled way; rejections follow the guard. */
export function installCrashHandlers(options: CrashOptions): void {
  const proc = options.proc ?? process
  const stop = controlledStop(options, proc)
  proc.on("uncaughtException", (error: unknown) => {
    const text = describeFailure(error)
    options.log(`uncaught exception: ${text}${stackOf(error)}`)
    stop("uncaught exception", text)
  })
  registerRejectionGuard(options, proc, stop)
}

/** Records that the database was found damaged and what was done about it. */
export function recordDatabaseIncident(db: Database.Database, result: DatabaseCheckResult, at: string): void {
  if (result.status !== "restored" && result.status !== "fresh") return
  ensureRecoverySchema(db)
  const remedy = result.status === "restored" ? `restored from backup ${path.basename(result.restoredFrom ?? "")}; damaged file kept` : "started a new database; damaged file kept"
  db.prepare("INSERT INTO recovery_incidents(started_at,ended_at,reason,remedy) VALUES(?,?,?,?)").run(at, at, `database: integrity check failed (${result.reason ?? "unknown"})`.slice(0, 300), remedy)
}
