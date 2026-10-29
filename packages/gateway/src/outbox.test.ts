import Database from "better-sqlite3"
import { ChannelDeliveryStore, OutboxWorker, PermanentDeliveryError, type OutboxRow } from "./outbox.js"

function clock(start = Date.parse("2026-10-27T10:00:00.000Z")) {
  let t = start
  return { now: () => new Date(t).toISOString(), advance: (ms: number) => { t += ms } }
}

function setup(options: { ttlMs?: number } = {}) {
  const c = clock()
  const db = new Database(":memory:")
  const store = new ChannelDeliveryStore(db, { now: c.now, baseDelayMs: 2_000, maxDelayMs: 300_000, ttlMs: options.ttlMs ?? 24 * 60 * 60_000 })
  return { c, db, store }
}

describe("channel outbox", () => {
  it("queues a reply once: the same message id never creates a second copy", () => {
    const { store } = setup()
    expect(store.enqueue({ channel: "telegram", address: "1", chatMessageId: "a1", parts: ["hello"] })).toBe(1)
    expect(store.enqueue({ channel: "telegram", address: "1", chatMessageId: "a1", parts: ["hello"] })).toBe(0)
    expect(store.hasEntries("a1")).toBe(true)
    expect(store.hasEntries("other")).toBe(false)
  })

  it("keeps a failed send pending with a growing delay, then sends it later", () => {
    const { store, c } = setup()
    store.enqueue({ channel: "telegram", address: "1", chatMessageId: "a1", parts: ["hello"] })
    const [row] = store.nextDueRows()
    expect(store.markAttemptFailed(row, new Error("network down"))).toBe("pending")
    expect(store.nextDueRows()).toHaveLength(0) // waiting for the retry time
    c.advance(2_001)
    const [again] = store.nextDueRows()
    expect(again.attempts).toBe(1)
    store.markAttemptFailed(again, new Error("still down"))
    expect(store.backoffMs(2)).toBe(4_000)
    expect(store.backoffMs(30)).toBe(300_000) // capped at 5 minutes
    c.advance(4_001)
    const [third] = store.nextDueRows()
    store.markSent(third.id)
    expect(store.stats()).toMatchObject({ pending: 0, failed: 0 })
  })

  it("holds later parts of an address back until the earlier part is sent", () => {
    const { store, c } = setup()
    store.enqueue({ channel: "slack", address: "C1", chatMessageId: "a1", parts: ["part one", "part two"] })
    store.enqueue({ channel: "slack", address: "C2", chatMessageId: "b1", parts: ["other chat"] })
    const first = store.nextDueRows()
    expect(first.map((r) => r.body).sort()).toEqual(["other chat", "part one"])
    const partOne = first.find((r) => r.body === "part one") as OutboxRow
    store.markAttemptFailed(partOne, new Error("boom"))
    // "part two" must not jump ahead of the failed "part one".
    expect(store.nextDueRows().map((r) => r.body)).toEqual(["other chat"])
    c.advance(2_001)
    expect(store.nextDueRows().map((r) => r.body).sort()).toEqual(["other chat", "part one"])
  })

  it("gives up at once on a permanent error and after the time limit", () => {
    const { store, c } = setup({ ttlMs: 60_000 })
    store.enqueue({ channel: "telegram", address: "1", chatMessageId: "a1", parts: ["x"] })
    const [row] = store.nextDueRows()
    expect(store.markAttemptFailed(row, new PermanentDeliveryError("chat not found"))).toBe("failed")
    store.enqueue({ channel: "telegram", address: "2", chatMessageId: "a2", parts: ["y"] })
    c.advance(61_000)
    const [old] = store.nextDueRows()
    expect(store.markAttemptFailed(old, new Error("network"))).toBe("failed")
    expect(store.stats().failed).toBe(2)
  })

  it("records inbound events once and finds them by chat message id", () => {
    const { store } = setup()
    expect(store.recordInbound({ eventId: "telegram_5", channel: "telegram", address: "42", senderId: "7" })).toBe(true)
    expect(store.recordInbound({ eventId: "telegram_5", channel: "telegram", address: "42", senderId: "7" })).toBe(false)
    expect(store.inboundByChatMessage("telegram_5")).toMatchObject({ channel: "telegram", address: "42", status: "received" })
    store.markInbound("telegram_5", "replied")
    expect(store.inboundByEvent("telegram_5")?.status).toBe("replied")
  })

  it("worker retries a failed send after the network returns, with no duplicate", async () => {
    const { store, c } = setup()
    const sent: string[] = []
    let online = false
    const worker = new OutboxWorker({ store, log: () => undefined, send: async (row) => { if (!online) throw new Error("offline"); sent.push(row.body) } })
    store.enqueue({ channel: "telegram", address: "1", chatMessageId: "a1", parts: ["the answer"] })
    await worker.tick()
    expect(sent).toEqual([])
    expect(store.stats().pending).toBe(1)
    online = true
    c.advance(2_001)
    await worker.tick()
    await worker.tick()
    expect(sent).toEqual(["the answer"])
    expect(store.stats().pending).toBe(0)
    store.enqueue({ channel: "telegram", address: "1", chatMessageId: "a1", parts: ["the answer"] }) // queued again by a replay
    await worker.tick()
    expect(sent).toEqual(["the answer"])
  })
})
