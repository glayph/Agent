import { afterEach, beforeEach, describe, expect, it } from "@jest/globals"
import Database from "better-sqlite3"
import { ToolRegistry } from "@miki/core/engine"
import { createForegroundActionGuardedTools, ForegroundActionLedger, foregroundActionKey } from "./foreground-action-ledger.js"

describe("ForegroundActionLedger", () => {
  let db: Database.Database
  beforeEach(() => { db = new Database(":memory:") })
  afterEach(() => { db.close() })

  it("persists an intent before execution and reuses the completed result on replay", () => {
    const first = new ForegroundActionLedger(db, "runtime-a", () => "2026-11-01T10:00:00.000Z")
    const actionKey = foregroundActionKey("browser_click", '{"selector":"#submit"}', 0)
    const input = {
      scopeId: "user-message-1", actionKey, runId: "run-a", callId: "call-a",
      toolName: "browser_click", risk: "config_write", arguments: { selector: "#submit" },
    }
    expect(first.claim(input)).toEqual({ status: "execute" })
    first.complete(input.scopeId, actionKey, "Clicked #submit")

    const afterRestart = new ForegroundActionLedger(db, "runtime-b", () => "2026-11-01T10:01:00.000Z")
    expect(afterRestart.claim({ ...input, runId: "run-b", callId: "call-b" })).toEqual({ status: "completed", result: "Clicked #submit" })
    expect(afterRestart.list({ status: "completed" })).toMatchObject([{ scopeId: "user-message-1", toolName: "browser_click", status: "completed" }])
  })

  it("marks an in-flight action uncertain after a process restart and blocks replay", () => {
    const first = new ForegroundActionLedger(db, "runtime-a")
    const actionKey = foregroundActionKey("computer_click_at", '{"x":12,"y":20}', 0)
    const input = {
      scopeId: "message-2", actionKey, runId: "run-a", callId: "call-a",
      toolName: "computer_click_at", risk: "config_write", arguments: { x: 12, y: 20 },
    }
    first.claim(input)

    const restarted = new ForegroundActionLedger(db, "runtime-b")
    expect(restarted.list({ status: "uncertain" })).toHaveLength(1)
    expect(restarted.claim({ ...input, runId: "run-b", callId: "call-b" })).toMatchObject({ status: "needs_reconciliation" })
  })

  it("does not allow an owner to reconcile an action that is still actively running", () => {
    const ledger = new ForegroundActionLedger(db, "runtime-a")
    const actionKey = foregroundActionKey("browser_click", '{"selector":"#send"}', 0)
    ledger.claim({ scopeId: "message-active", actionKey, runId: "run-a", callId: "call-a", toolName: "browser_click", risk: "config_write", arguments: { selector: "#send" } })
    expect(() => ledger.reconcile({ scopeId: "message-active", actionKey, outcome: "not_applied", evidence: { currentState: "unchanged" } })).toThrow(/not found|no longer reconcilable/i)
  })

  it("requires evidence, and permits one retry only after not_applied reconciliation", () => {
    const ledger = new ForegroundActionLedger(db, "runtime-a")
    const actionKey = foregroundActionKey("browser_navigate", '{"url":"https://example.test"}', 0)
    const input = {
      scopeId: "message-3", actionKey, runId: "run-a", callId: "call-a",
      toolName: "browser_navigate", risk: "config_write", arguments: { url: "https://example.test" },
    }
    ledger.claim(input)
    ledger.markUncertain(input.scopeId, actionKey, "network dropped")
    expect(() => ledger.reconcile({ scopeId: input.scopeId, actionKey, outcome: "not_applied", evidence: {} })).toThrow(/evidence/i)
    ledger.reconcile({ scopeId: input.scopeId, actionKey, outcome: "not_applied", evidence: { currentUrl: "about:blank", checkedAt: "2026-11-01T10:00:00Z" } })
    expect(ledger.claim({ ...input, runId: "run-b", callId: "call-b" })).toEqual({ status: "execute" })
    expect(ledger.claim({ ...input, runId: "run-c", callId: "call-c" })).toMatchObject({ status: "needs_reconciliation" })
  })

  it("reconciles completed actions into a replay-safe result", () => {
    const ledger = new ForegroundActionLedger(db, "runtime-a")
    const actionKey = foregroundActionKey("computer_set_text", '{"text":"hello"}', 0)
    const input = {
      scopeId: "message-4", actionKey, runId: "run-a", callId: "call-a",
      toolName: "computer_set_text", risk: "config_write", arguments: { text: "hello" },
    }
    ledger.claim(input)
    ledger.reconcile({ scopeId: input.scopeId, actionKey, outcome: "completed", evidence: { visibleText: "hello" } })
    expect(ledger.claim({ ...input, runId: "run-b", callId: "call-b" })).toMatchObject({ status: "completed", result: { reconciled: true } })
  })

  it("stores only argument keys and redacts secrets from retained results", () => {
    const ledger = new ForegroundActionLedger(db, "runtime-a")
    const actionKey = foregroundActionKey("browser_type", '{"selector":"#user","text":"hidden"}', 0)
    const input = {
      scopeId: "message-5", actionKey, runId: "run-a", callId: "call-a",
      toolName: "browser_type", risk: "config_write", arguments: { selector: "#user", text: "not retained" },
    }
    ledger.claim(input)
    ledger.complete(input.scopeId, actionKey, { ok: true, password: "do-not-store", summary: "done" })
    const row = db.prepare("SELECT argument_keys_json,result_json FROM miki_foreground_action_ledger WHERE scope_id=? AND action_key=?").get(input.scopeId, actionKey) as { argument_keys_json: string; result_json: string }
    expect(row.argument_keys_json).toBe('["selector","text"]')
    expect(row.result_json).not.toContain("do-not-store")
    expect(row.result_json).toContain("[REDACTED]")
  })


  it("guards real Browser/Desktop tool wrappers and records intent before the tool body runs", async () => {
    const ledger = new ForegroundActionLedger(db, "runtime-a")
    const base = new ToolRegistry()
    const execute = jest.fn(async () => {
      expect(ledger.list({ status: "running" })).toHaveLength(1)
      return "clicked"
    })
    base.register({
      name: "browser_click", description: "click", risk: "config_write", approval: "required",
      parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
      execute,
    } as never)
    const context = { runId: "run-a", callId: "call-a", signal: new AbortController().signal } as never
    const guarded = createForegroundActionGuardedTools(base, ledger, "user-message-6")
    const result = await guarded.get("browser_click")!.execute({ selector: "#save" }, context)
    expect(result).toBe("clicked")
    expect(execute).toHaveBeenCalledTimes(1)

    const replay = createForegroundActionGuardedTools(base, ledger, "user-message-6")
    const replayed = await replay.get("browser_click")!.execute({ selector: "#save" }, { ...context, runId: "run-retry", callId: "call-retry" } as never)
    expect(replayed).toBe("clicked")
    expect(execute).toHaveBeenCalledTimes(1)
  })

  it("blocks a second external action after an uncertain result until the owner reconciles it", async () => {
    const ledger = new ForegroundActionLedger(db, "runtime-a")
    const base = new ToolRegistry()
    const execute = jest.fn(async () => { throw new Error("connection dropped after click") })
    base.register({
      name: "computer_click_at", description: "click", risk: "config_write", approval: "required",
      parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] },
      execute,
    } as never)
    const args = { x: 40, y: 60 }
    const first = createForegroundActionGuardedTools(base, ledger, "user-message-7")
    await expect(first.get("computer_click_at")!.execute(args, { runId: "run-a", callId: "call-a", signal: new AbortController().signal } as never)).rejects.toThrow(/reconciled/i)
    expect(ledger.list({ status: "uncertain" })).toHaveLength(1)

    const retry = createForegroundActionGuardedTools(base, ledger, "user-message-7")
    await expect(retry.get("computer_click_at")!.execute(args, { runId: "run-b", callId: "call-b", signal: new AbortController().signal } as never)).rejects.toThrow(/unconfirmed external outcome/i)
    expect(execute).toHaveBeenCalledTimes(1)

    const actionKey = foregroundActionKey("computer_click_at", '{"x":40,"y":60}', 0)
    ledger.reconcile({ scopeId: "user-message-7", actionKey, outcome: "not_applied", evidence: { desktopState: "target unchanged" } })
    const afterReconcile = createForegroundActionGuardedTools(base, ledger, "user-message-7")
    await expect(afterReconcile.get("computer_click_at")!.execute(args, { runId: "run-c", callId: "call-c", signal: new AbortController().signal } as never)).rejects.toThrow(/reconciled/i)
    expect(execute).toHaveBeenCalledTimes(2)
  })

  it("isolates identical operations belonging to different user messages", () => {
    const ledger = new ForegroundActionLedger(db, "runtime-a")
    const actionKey = foregroundActionKey("browser_click", '{"selector":"#save"}', 0)
    const base = { actionKey, runId: "run-a", callId: "call-a", toolName: "browser_click", risk: "config_write", arguments: { selector: "#save" } }
    expect(ledger.claim({ ...base, scopeId: "message-a" })).toEqual({ status: "execute" })
    expect(ledger.claim({ ...base, scopeId: "message-b" })).toEqual({ status: "execute" })
  })
})
