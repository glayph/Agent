import { createHash } from "node:crypto"
import type Database from "better-sqlite3"
import { redactSecrets, stableStringify, ToolRegistry } from "@miki/core/engine"

const MAX_RESULT_BYTES = 48 * 1024
const MAX_EVIDENCE_BYTES = 12 * 1024
const SECRET_KEY = /password|secret|token|api.?key|authorization|cookie|private.?key|credential/i

export type ForegroundActionStatus = "running" | "completed" | "uncertain" | "not_applied"

export interface ForegroundActionInput {
  scopeId: string
  actionKey: string
  runId: string
  callId: string
  toolName: string
  risk: string
  arguments: unknown
}

export type ForegroundActionClaim =
  | { status: "execute" }
  | { status: "completed"; result: unknown }
  | { status: "needs_reconciliation"; error?: string }

export interface ForegroundActionRecord {
  scopeId: string
  actionKey: string
  runId: string
  callId: string
  toolName: string
  risk: string
  argumentsHash: string
  argumentKeys: string[]
  status: ForegroundActionStatus
  error?: string
  evidence?: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

function safeJson(value: unknown, maxBytes: number): string {
  const seen = new WeakSet<object>()
  const scrub = (item: unknown, depth: number): unknown => {
    if (item === null || typeof item === "boolean" || typeof item === "number") return item
    if (typeof item === "string") return redactSecrets(item).slice(0, 16_000)
    if (typeof item !== "object") return String(item)
    if (depth > 16) return "[Max depth]"
    if (seen.has(item)) return "[Circular]"
    seen.add(item)
    let result: unknown
    if (Array.isArray(item)) result = item.slice(0, 200).map((child) => scrub(child, depth + 1))
    else result = Object.fromEntries(Object.entries(item as Record<string, unknown>).slice(0, 200).map(([key, child]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : scrub(child, depth + 1),
    ]))
    seen.delete(item)
    return result
  }
  const serialized = JSON.stringify(scrub(value, 0))
  if (Buffer.byteLength(serialized, "utf8") > maxBytes) throw new Error(`Serialized action data exceeds ${maxBytes} bytes.`)
  return serialized
}

function parseJson(value: string | null): unknown {
  if (!value) return null
  try { return JSON.parse(value) as unknown } catch { return null }
}

export class ForegroundActionLedger {
  constructor(
    private readonly db: Database.Database,
    private readonly runtimeId: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS miki_foreground_action_ledger (
        scope_id TEXT NOT NULL,
        action_key TEXT NOT NULL,
        runtime_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        risk TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        argument_keys_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','completed','uncertain','not_applied')),
        result_json TEXT,
        error_text TEXT,
        reconciliation_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(scope_id, action_key)
      );
      CREATE INDEX IF NOT EXISTS idx_miki_foreground_actions_status_updated
        ON miki_foreground_action_ledger(status, updated_at);
      CREATE INDEX IF NOT EXISTS idx_miki_foreground_actions_scope_updated
        ON miki_foreground_action_ledger(scope_id, updated_at);
    `)
    // A running record owned by a previous Gateway process means the external
    // call may have escaped before the process stopped. Never replay it blindly.
    this.db.prepare(`
      UPDATE miki_foreground_action_ledger
      SET status='uncertain', error_text=?, updated_at=?
      WHERE status='running' AND runtime_id<>?
    `).run("Gateway restarted before the external action outcome was confirmed; inspect external state before retrying.", this.now(), this.runtimeId)
  }

  claim(input: ForegroundActionInput): ForegroundActionClaim {
    if (!input.scopeId.trim() || !input.actionKey.trim() || !input.runId.trim() || !input.callId.trim()) {
      throw new Error("Foreground action identity is incomplete.")
    }
    const argumentText = safeJson(input.arguments, 32 * 1024)
    const argumentsHash = createHash("sha256").update(argumentText).digest("hex")
    const keys = input.arguments && typeof input.arguments === "object" && !Array.isArray(input.arguments)
      ? Object.keys(input.arguments as Record<string, unknown>).filter((key) => !SECRET_KEY.test(key)).slice(0, 64)
      : []
    const keysJson = JSON.stringify(keys)
    const timestamp = this.now()
    const claim = this.db.transaction((): ForegroundActionClaim => {
      const current = this.db.prepare(`SELECT status,result_json,error_text FROM miki_foreground_action_ledger
        WHERE scope_id=? AND action_key=?`).get(input.scopeId, input.actionKey) as { status: ForegroundActionStatus; result_json: string | null; error_text: string | null } | undefined
      if (current?.status === "completed") return { status: "completed", result: parseJson(current.result_json) }
      if (current?.status === "running" || current?.status === "uncertain") {
        return { status: "needs_reconciliation", ...(current.error_text ? { error: current.error_text } : {}) }
      }
      if (current?.status === "not_applied") {
        this.db.prepare(`UPDATE miki_foreground_action_ledger SET runtime_id=?,run_id=?,call_id=?,tool_name=?,risk=?,arguments_hash=?,argument_keys_json=?,status='running',result_json=NULL,error_text=NULL,updated_at=?
          WHERE scope_id=? AND action_key=? AND status='not_applied'`)
          .run(this.runtimeId, input.runId, input.callId, input.toolName, input.risk, argumentsHash, keysJson, timestamp, input.scopeId, input.actionKey)
        return { status: "execute" }
      }
      this.db.prepare(`INSERT INTO miki_foreground_action_ledger(
        scope_id,action_key,runtime_id,run_id,call_id,tool_name,risk,arguments_hash,argument_keys_json,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?,?,'running',?,?)`).run(
        input.scopeId, input.actionKey, this.runtimeId, input.runId, input.callId,
        input.toolName, input.risk, argumentsHash, keysJson, timestamp, timestamp,
      )
      return { status: "execute" }
    })
    return claim.immediate()
  }

  complete(scopeId: string, actionKey: string, result: unknown): void {
    let resultJson: string
    try {
      resultJson = safeJson(result ?? null, MAX_RESULT_BYTES)
    } catch {
      resultJson = JSON.stringify({
        ok: true,
        replayNote: "The external action completed, but its original result was too large to retain. Inspect the external state before continuing.",
      })
    }
    const updated = this.db.prepare(`UPDATE miki_foreground_action_ledger
      SET status='completed',result_json=?,error_text=NULL,updated_at=?
      WHERE scope_id=? AND action_key=? AND status='running' AND runtime_id=?`)
      .run(resultJson, this.now(), scopeId, actionKey, this.runtimeId)
    if (updated.changes !== 1) throw new Error("Foreground action completion was not recorded; its outcome must be reconciled.")
  }

  markUncertain(scopeId: string, actionKey: string, error: unknown): void {
    const message = redactSecrets(error instanceof Error ? error.message : String(error ?? "External action outcome is unknown.")).slice(0, 500)
    this.db.prepare(`UPDATE miki_foreground_action_ledger
      SET status='uncertain',error_text=?,updated_at=?
      WHERE scope_id=? AND action_key=? AND status='running' AND runtime_id=?`)
      .run(message || "External action outcome is unknown.", this.now(), scopeId, actionKey, this.runtimeId)
  }

  reconcile(input: {
    scopeId: string
    actionKey: string
    outcome: "completed" | "not_applied"
    evidence: Record<string, unknown>
    result?: unknown
  }): void {
    if (!input.evidence || typeof input.evidence !== "object" || Array.isArray(input.evidence) || Object.keys(input.evidence).length === 0) {
      throw new Error("Non-empty external-state evidence is required to reconcile an action.")
    }
    const evidenceJson = safeJson(input.evidence, MAX_EVIDENCE_BYTES)
    const resultJson = input.outcome === "completed"
      ? safeJson(input.result ?? { ok: true, reconciled: true, evidence: JSON.parse(evidenceJson) as unknown }, MAX_RESULT_BYTES)
      : null
    const status = input.outcome === "completed" ? "completed" : "not_applied"
    const update = this.db.prepare(`UPDATE miki_foreground_action_ledger
      SET status=?,result_json=?,error_text=NULL,reconciliation_json=?,updated_at=?
      WHERE scope_id=? AND action_key=? AND status='uncertain'`)
      .run(status, resultJson, evidenceJson, this.now(), input.scopeId, input.actionKey)
    if (update.changes !== 1) throw new Error("Uncertain foreground action was not found or is no longer reconcilable.")
  }

  list(options: { status?: ForegroundActionStatus; limit?: number } = {}): ForegroundActionRecord[] {
    const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 50)))
    const rows = options.status
      ? this.db.prepare(`SELECT * FROM miki_foreground_action_ledger WHERE status=? ORDER BY updated_at DESC LIMIT ?`).all(options.status, limit)
      : this.db.prepare(`SELECT * FROM miki_foreground_action_ledger ORDER BY updated_at DESC LIMIT ?`).all(limit)
    return (rows as Array<Record<string, unknown>>).map((row) => ({
      scopeId: String(row.scope_id),
      actionKey: String(row.action_key),
      runId: String(row.run_id),
      callId: String(row.call_id),
      toolName: String(row.tool_name),
      risk: String(row.risk),
      argumentsHash: String(row.arguments_hash),
      argumentKeys: Array.isArray(parseJson(String(row.argument_keys_json)) as unknown) ? parseJson(String(row.argument_keys_json)) as string[] : [],
      status: String(row.status) as ForegroundActionStatus,
      ...(typeof row.error_text === "string" && row.error_text ? { error: redactSecrets(row.error_text) } : {}),
      ...(row.reconciliation_json ? { evidence: parseJson(String(row.reconciliation_json)) as Record<string, unknown> } : {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }))
  }
}

/** Stable key for the nth occurrence of identical arguments within one user request. */
export function foregroundActionKey(toolName: string, argumentsJson: string, occurrence: number): string {
  return createHash("sha256").update(`${toolName}\0${argumentsJson}\0${occurrence}`).digest("hex")
}


/**
 * Wrap foreground Browser/Desktop mutations with durable intent/result recording.
 * A user-message scope is reused for retries, so a completed action is replayed
 * from its recorded result and an uncertain action fails closed until reconciled.
 */
export function createForegroundActionGuardedTools(
  baseTools: ToolRegistry,
  ledger: ForegroundActionLedger,
  scopeId: string,
  inspectExternalState?: (toolName: string) => Promise<unknown>,
): ToolRegistry {
  const guardedTools = new ToolRegistry()
  const occurrences = new Map<string, number>()
  let reconciliationRequired: string | undefined

  for (const tool of baseTools.list()) {
    const isInteractiveWrite = (tool.name.startsWith("browser_") || tool.name.startsWith("computer_")) && tool.risk !== "read"
    if (!isInteractiveWrite) {
      guardedTools.register(tool)
      continue
    }
    guardedTools.register({
      ...tool,
      async execute(args, context) {
        if (context.signal.aborted) throw new Error("Run was cancelled before the external action could start.")
        if (reconciliationRequired) throw new Error(reconciliationRequired)
        const serializedArgs = stableStringify(args)
        const occurrenceFingerprint = `${tool.name}:${serializedArgs}`
        const occurrence = occurrences.get(occurrenceFingerprint) ?? 0
        occurrences.set(occurrenceFingerprint, occurrence + 1)
        const actionKey = foregroundActionKey(tool.name, serializedArgs, occurrence)
        const claim = ledger.claim({
          scopeId,
          actionKey,
          runId: context.runId,
          callId: context.callId,
          toolName: tool.name,
          risk: tool.risk,
          arguments: args,
        })
        if (claim.status === "completed") return claim.result
        if (claim.status === "needs_reconciliation") {
          let observedState = ""
          try {
            const snapshot = await inspectExternalState?.(tool.name)
            if (snapshot !== undefined) observedState = ` Current read-only external-state snapshot: ${safeJson(snapshot, 6 * 1024)}.`
          } catch (error) {
            observedState = ` Automatic read-only inspection was unavailable: ${redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 240)}.`
          }
          reconciliationRequired = `${tool.name} has an unconfirmed external outcome. The current UI was re-observed where supported, but the action is still not automatically classified. Inspect the browser/desktop state and owner-reconcile action ${actionKey} before any further external action. ${claim.error ?? ""}${observedState}`.trim()
          throw new Error(reconciliationRequired)
        }
        try {
          const result = await tool.execute(args, context)
          ledger.complete(scopeId, actionKey, result)
          return result
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          ledger.markUncertain(scopeId, actionKey, reason)
          reconciliationRequired = `${tool.name} may have partially completed. External state must be checked and action ${actionKey} reconciled before retrying or performing another external action.`
          throw new Error(reconciliationRequired)
        }
      },
    })
  }
  return guardedTools
}
