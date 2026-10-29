import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import Database from "better-sqlite3"
import { DatabaseBackups, beginBoot, createRejectionGuard, ensureHealthyDatabase, installCrashHandlers, installRejectionGuard, listBackups, markCleanExit, noteCrashReason, recordCrash } from "./process-safety.js"

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "miki-safety-"))
function makeDb(file: string, rows: number) {
  const db = new Database(file)
  db.exec("CREATE TABLE t(v TEXT)")
  for (let i = 0; i < rows; i += 1) db.prepare("INSERT INTO t VALUES(?)").run(`row-${i}`)
  return db
}

describe("database safety", () => {
  it("backs up the database and keeps only the newest few", async () => {
    const dir = tmp(); const db = makeDb(path.join(dir, "d.sqlite"), 3)
    let t = Date.parse("2026-10-27T10:00:00Z")
    const backups = new DatabaseBackups(db, path.join(dir, "backups"), () => undefined, { keep: 2, now: () => new Date(t) })
    for (let i = 0; i < 4; i += 1) { await backups.backupNow(); t += 60_000 }
    expect(listBackups(path.join(dir, "backups"))).toHaveLength(2)
    db.close()
  })

  it("restores from the newest good backup when quick_check fails, keeping the damaged file", async () => {
    const dir = tmp(); const file = path.join(dir, "miki-runtime.sqlite"); const bdir = path.join(dir, "backups")
    const db = makeDb(file, 5)
    await new DatabaseBackups(db, bdir, () => undefined).backupNow()
    db.close()
    fs.writeFileSync(file, Buffer.from("this is not a sqlite database at all".repeat(50)))
    const logs: string[] = []
    const result = ensureHealthyDatabase(file, bdir, (m) => logs.push(m))
    expect(result.status).toBe("restored")
    expect(fs.existsSync(result.corruptMovedTo as string)).toBe(true)
    const restored = new Database(file)
    expect((restored.prepare("SELECT COUNT(*) n FROM t").get() as { n: number }).n).toBe(5)
    restored.close()
  })

  it("starts fresh, but keeps the damaged file, when there is no usable backup", () => {
    const dir = tmp(); const file = path.join(dir, "miki-runtime.sqlite")
    fs.writeFileSync(file, "garbage".repeat(100))
    const result = ensureHealthyDatabase(file, path.join(dir, "none"), () => undefined)
    expect(result.status).toBe("fresh")
    expect(fs.existsSync(file)).toBe(false)
    expect(fs.existsSync(result.corruptMovedTo as string)).toBe(true)
    expect(ensureHealthyDatabase(path.join(dir, "missing.sqlite"), dir, () => undefined).status).toBe("absent")
  })

  it("leaves a healthy database alone", () => {
    const dir = tmp(); const file = path.join(dir, "d.sqlite"); makeDb(file, 1).close()
    expect(ensureHealthyDatabase(file, dir, () => undefined).status).toBe("ok")
  })
})

describe("crash tracking", () => {
  it("records an unclean previous exit and detects a crash loop", () => {
    const dir = tmp(); const db = new Database(":memory:")
    expect(beginBoot(db, dir, () => undefined).previousUncleanExit).toBe(false) // first ever boot
    markCleanExit(dir)
    expect(beginBoot(db, dir, () => undefined).previousUncleanExit).toBe(false) // clean exit
    let info = beginBoot(db, dir, () => undefined) // the boot above never ended cleanly
    expect(info.previousUncleanExit).toBe(true)
    for (let i = 0; i < 4; i += 1) info = beginBoot(db, dir, () => undefined)
    expect(info.crashesInWindow).toBeGreaterThanOrEqual(5)
    expect(info.crashLoop).toBe(true)
  })

  it("carries the crash reason across the restart", () => {
    const dir = tmp(); const db = new Database(":memory:")
    beginBoot(db, dir, () => undefined)
    noteCrashReason(dir, "unhandled rejection: boom")
    const info = beginBoot(db, dir, () => undefined)
    expect(info.previousCrashReason).toBe("unhandled rejection: boom")
    expect((db.prepare("SELECT reason FROM recovery_incidents").get() as { reason: string }).reason).toBe("crash: unhandled rejection: boom")
    recordCrash(db, "x", new Date().toISOString())
  })

  it("an unhandled exception writes the reason, shuts down in a controlled way and exits 1", async () => {
    const dir = tmp(); const handlers: Record<string, (e: unknown) => void> = {}
    const exit = jest.fn(); const shutdown = jest.fn(async () => undefined)
    installCrashHandlers({ dataDir: dir, log: () => undefined, shutdown, proc: { on: ((e: string, h: (x: unknown) => void) => { handlers[e] = h }) as never, exit: exit as never } })
    handlers.uncaughtException(new Error("synthetic failure"))
    handlers.unhandledRejection(new Error("second one is ignored"))
    await new Promise((r) => setTimeout(r, 20))
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(JSON.parse(fs.readFileSync(path.join(dir, "gateway-boot.json"), "utf8")).crashReason).toContain("synthetic failure")
  })
})

describe("unhandled rejections", () => {
  it("keeps the gateway running for a few rejections and stops only when they keep coming", async () => {
    let now = 0
    const guard = createRejectionGuard(5, 10 * 60_000, () => now)
    const results: boolean[] = []
    for (let i = 0; i < 6; i += 1) results.push(guard())
    expect(results.slice(0, 5)).toEqual([false, false, false, false, false])
    expect(results[5]).toBe(true)
    // Old rejections fall out of the window, so a later, isolated rejection does not stop the process.
    now = 11 * 60_000
    expect(guard()).toBe(false)
  })

  it("the rejection guard logs and continues, and exits only past the limit", async () => {
    const dir = tmp(); const handlers: Record<string, (e: unknown) => void> = {}
    const exit = jest.fn(); const shutdown = jest.fn(async () => undefined); const logs: string[] = []
    installRejectionGuard({ dataDir: dir, log: (m) => logs.push(m), shutdown, proc: { on: ((e: string, h: (x: unknown) => void) => { handlers[e] = h }) as never, exit: exit as never } })
    for (let i = 0; i < 5; i += 1) handlers.unhandledRejection(new Error(`channel failure ${i}`))
    await new Promise((r) => setTimeout(r, 20))
    expect(shutdown).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    handlers.unhandledRejection(new Error("channel failure 5"))
    await new Promise((r) => setTimeout(r, 20))
    expect(shutdown).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(logs.some((line) => line.includes("keeps running"))).toBe(true)
  })
})
