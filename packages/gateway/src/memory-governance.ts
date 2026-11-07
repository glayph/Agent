import { createHash, randomUUID } from "node:crypto"
import type Database from "better-sqlite3"

type MemoryKind = "preference" | "fact" | "episode" | "procedure" | "recommendation" | "temporary" | "observation" | "feedback"
type MemorySource = "owner_explicit" | "verified_outcome" | "user_feedback" | "agent_inference" | "untrusted_observation"
type MemoryStatus = "active" | "draft" | "review" | "superseded"
type MemoryProvenance = "owner" | "agent" | "untrusted"

export interface MemoryScope {
  agentId: string
  ownerId: string
  workspaceId: string
}

export interface MemoryGovernanceRecord {
  id: string
  scope: MemoryScope
  kind: MemoryKind
  content: string
  provenance: MemoryProvenance
  sourceType: MemorySource
  sourceReference: string | null
  confidence: number
  status: MemoryStatus
  conflictKey: string | null
  supersedesId: string | null
  evidenceIds: string[]
  createdAt: string
  updatedAt: string
  expiresAt: string | null
  metadata: Record<string, unknown>
}

export interface MemoryRecordInput {
  scope: MemoryScope
  kind: MemoryKind
  content: string
  sourceType: MemorySource
  sourceReference?: string
  confidence?: number
  conflictKey?: string
  supersedesId?: string
  evidenceIds?: string[]
  expiresAt?: string | null
  metadata?: Record<string, unknown>
  verified?: boolean
}

const KINDS = new Set<MemoryKind>(["preference", "fact", "episode", "procedure", "recommendation", "temporary", "observation", "feedback"])
const SOURCES = new Set<MemorySource>(["owner_explicit", "verified_outcome", "user_feedback", "agent_inference", "untrusted_observation"])
const RETRIEVABLE_KINDS = new Set<MemoryKind>(["preference", "fact", "recommendation", "procedure"])
const MIN_RETRIEVAL_CONFIDENCE = 0.6
const MAX_CONTENT = 4_000
const MAX_EVIDENCE = 32
const STOP_WORDS = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "do", "for", "from", "i", "in", "is", "it", "me", "my", "of", "on", "or", "please", "the", "this", "to", "use", "want", "always", "never", "no", "not", "without", "dont", "don't", "do not", "prefer", "preference", "remember", "remember this", "keep", "make", "answer", "respond", "write", "use"])

function safeText(value: unknown, max = MAX_CONTENT): string {
  return String(value ?? "")
    .replace(/\b(gh[pousr]_[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AQ\.[A-Za-z0-9_-]{20,})\b/g, "[REDACTED_TOKEN]")
    .replace(/(["']?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credential|authorization|cookie)["']?\s*:\s*["']?)([^"'\\\s,;}{]{6,})(["']?)/gi, "$1[REDACTED]$3")
    .replace(/\b((?:api[-_]?key|access[-_]?token|refresh[-_]?token|token|secret|password|credential|authorization|cookie)\s*[=:]\s*)[^\s,;]{6,}/gi, "$1[REDACTED]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
}

function safeJson(value: unknown): string {
  try {
    const redact = (item: unknown, depth = 0): unknown => {
      if (depth > 6) return "[TRUNCATED]"
      if (typeof item === "string") return safeText(item, 1_000)
      if (Array.isArray(item)) return item.slice(0, 32).map((child) => redact(child, depth + 1))
      if (item && typeof item === "object") {
        const out: Record<string, unknown> = {}
        for (const [key, child] of Object.entries(item).slice(0, 64)) {
          out[key] = /api[_-]?key|token|secret|password|credential|authorization|cookie/i.test(key)
            ? "[REDACTED]" : redact(child, depth + 1)
        }
        return out
      }
      return item
    }
    return JSON.stringify(redact(value ?? {}))
  } catch {
    return "{}"
  }
}

function parseJson(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(value ?? "{}"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch { return {} }
}

function scopeKey(scope: MemoryScope): string {
  return [scope.agentId, scope.ownerId, scope.workspaceId].map((item) => encodeURIComponent(String(item || "").trim())).join(":")
}

function normalizeScope(scope: MemoryScope): MemoryScope {
  return {
    agentId: String(scope.agentId || "miki").trim() || "miki",
    ownerId: String(scope.ownerId || "default-owner").trim() || "default-owner",
    workspaceId: String(scope.workspaceId || "default-workspace").trim() || "default-workspace",
  }
}

function rowToRecord(row: Record<string, unknown>): MemoryGovernanceRecord {
  return {
    id: String(row.id),
    scope: { agentId: String(row.agent_id), ownerId: String(row.owner_id), workspaceId: String(row.workspace_id) },
    kind: row.kind as MemoryKind,
    content: String(row.content),
    provenance: row.provenance as MemoryProvenance,
    sourceType: row.source_type as MemorySource,
    sourceReference: row.source_reference == null ? null : String(row.source_reference),
    confidence: Number(row.confidence),
    status: row.status as MemoryStatus,
    conflictKey: row.conflict_key == null ? null : String(row.conflict_key),
    supersedesId: row.supersedes_id == null ? null : String(row.supersedes_id),
    evidenceIds: (() => { try { const v = JSON.parse(String(row.evidence_ids_json || "[]")); return Array.isArray(v) ? v.map(String) : [] } catch { return [] } })(),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    metadata: parseJson(row.metadata_json),
  }
}

function terms(text: string): string[] {
  const values = text.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) ?? []
  return [...new Set(values.filter((item) => item.length > 1 && !STOP_WORDS.has(item)))].slice(0, 32)
}

/** A stable, deliberately conservative key for obvious same-topic preference conflicts. */
export function preferenceConflictKey(text: string): string | undefined {
  const cleaned = text.normalize("NFKC").toLocaleLowerCase()
    .replace(/please remember|my preference is|from now on|i prefer|i always want|always use|never use|don't ever|do not ever|do not use|don't use|do not|don't|মনে রাখবে/g, " ")
  const words = terms(cleaned).sort()
  if (words.length === 0) return undefined
  return `preference:${createHash("sha256").update(words.join(" ")).digest("hex").slice(0, 24)}`
}

/**
 * Scoped metadata and lifecycle store for durable memories. Markdown remains the human-readable archive;
 * this table is the governed retrieval/lineage layer and can be rebuilt without trusting free-form notes.
 */
export class MemoryGovernanceStore {
  constructor(private readonly db: Database.Database) {
    this.ensureSchema()
  }

  ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_governance_records (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        content TEXT NOT NULL,
        provenance TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_reference TEXT,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        conflict_key TEXT,
        supersedes_id TEXT,
        evidence_ids_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_memory_governance_scope_status
        ON memory_governance_records(scope_key,status,kind,updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_governance_conflicts
        ON memory_governance_records(scope_key,kind,conflict_key,status);
      CREATE INDEX IF NOT EXISTS idx_memory_governance_expiry
        ON memory_governance_records(scope_key,expires_at);
    `)
  }

  record(input: MemoryRecordInput): { record: MemoryGovernanceRecord; stored: boolean; conflict: boolean } {
    const scope = normalizeScope(input.scope)
    if (!KINDS.has(input.kind) || !SOURCES.has(input.sourceType)) throw new Error("Unsupported memory kind or source type.")
    const content = safeText(input.content)
    if (!content) throw new Error("Memory content is empty after validation.")
    const now = new Date().toISOString()
    const key = scopeKey(scope)
    const confidence = Math.max(0, Math.min(1, Number.isFinite(Number(input.confidence)) ? Number(input.confidence) : 0.5))
    const evidenceIds = [...new Set((input.evidenceIds ?? []).map((item) => safeText(item, 160)).filter(Boolean))].slice(0, MAX_EVIDENCE)
    const verified = input.sourceType === "verified_outcome" && input.verified === true && evidenceIds.length > 0
    let provenance: MemoryProvenance = input.sourceType === "owner_explicit" || input.sourceType === "user_feedback" ? "owner"
      : input.sourceType === "verified_outcome" && verified ? "agent" : input.sourceType === "untrusted_observation" ? "untrusted" : "agent"
    let status: MemoryStatus = input.kind === "procedure" ? "draft"
      : input.sourceType === "owner_explicit" || input.sourceType === "user_feedback" || verified ? "active"
      : "draft"
    if (input.sourceType === "untrusted_observation") status = "review"
    if (input.sourceType === "verified_outcome" && !verified) status = "review"
    const id = randomUUID()
    let conflictKey = safeText(input.conflictKey ?? (input.kind === "preference" ? preferenceConflictKey(content) : ""), 256) || null
    const expiresAt = input.expiresAt ? new Date(input.expiresAt).toISOString() : null
    const metadataJson = safeJson(input.metadata ?? {})

    const transaction = this.db.transaction(() => {
      // De-duplicate identical content within an owner/workspace scope.
      const prior = this.db.prepare("SELECT * FROM memory_governance_records WHERE scope_key=? AND kind=? AND lower(content)=lower(?) AND status!='superseded' LIMIT 1")
        .get(key, input.kind, content) as Record<string, unknown> | undefined
      if (prior) {
        // Explicit owner confirmation can promote a formerly inferred/review item.
        // For a preference, reaffirmation also resolves the whole same-topic conflict set.
        if ((input.sourceType === "owner_explicit" || input.sourceType === "user_feedback") && input.kind !== "procedure") {
          const existing = rowToRecord(prior)
          if (input.kind === "preference" && existing.conflictKey) {
            this.db.prepare("UPDATE memory_governance_records SET status='superseded',updated_at=? WHERE scope_key=? AND kind='preference' AND conflict_key=? AND status='review' AND id<>?")
              .run(now, key, existing.conflictKey, existing.id)
          }
          this.db.prepare("UPDATE memory_governance_records SET provenance='owner',source_type=?,confidence=1,status='active',source_reference=COALESCE(?,source_reference),updated_at=? WHERE scope_key=? AND id=?")
            .run(input.sourceType, input.sourceReference ? safeText(input.sourceReference, 256) : null, now, key, existing.id)
          const updated = this.db.prepare("SELECT * FROM memory_governance_records WHERE scope_key=? AND id=?").get(key, existing.id) as Record<string, unknown>
          return { record: rowToRecord(updated), stored: false, conflict: false }
        }
        // A repeated procedural workflow adds another evidence run to the same draft
        // rather than silently discarding the new observation.
        if (input.kind === "procedure") {
          const existing = rowToRecord(prior)
          const mergedEvidence = [...new Set([...existing.evidenceIds, ...evidenceIds])].slice(0, MAX_EVIDENCE)
          const metadata = { ...existing.metadata, lastObservedAt: now, observedRuns: [...new Set([...(Array.isArray(existing.metadata.observedRuns) ? existing.metadata.observedRuns.map(String) : []), ...evidenceIds])].slice(-MAX_EVIDENCE) }
          this.db.prepare("UPDATE memory_governance_records SET evidence_ids_json=?,updated_at=?,metadata_json=? WHERE scope_key=? AND id=?")
            .run(JSON.stringify(mergedEvidence), now, safeJson(metadata), key, existing.id)
          const updated = this.db.prepare("SELECT * FROM memory_governance_records WHERE scope_key=? AND id=?").get(key, existing.id) as Record<string, unknown>
          return { record: rowToRecord(updated), stored: false, conflict: false }
        }
        return { record: rowToRecord(prior), stored: false, conflict: false }
      }

      let conflict = false
      if (input.supersedesId) {
        const old = this.db.prepare("SELECT * FROM memory_governance_records WHERE scope_key=? AND id=? AND kind=? AND status IN ('active','review')")
          .get(key, input.supersedesId, input.kind) as Record<string, unknown> | undefined
        if (!old) throw new Error("The memory selected for superseding is not active in this owner/workspace scope.")
        // Keep the same conflict lineage when an owner replaces a preference.
        if (old.conflict_key != null) {
          conflictKey = String(old.conflict_key)
          // An explicit owner replacement resolves every reviewed alternative in this conflict group.
          this.db.prepare("UPDATE memory_governance_records SET status='superseded',updated_at=? WHERE scope_key=? AND kind=? AND conflict_key=? AND status='review'")
            .run(now, key, input.kind, conflictKey)
        }
        this.db.prepare("UPDATE memory_governance_records SET status='superseded',updated_at=? WHERE scope_key=? AND id=?")
          .run(now, key, input.supersedesId)
      } else if (input.kind === "preference" && conflictKey) {
        const existing = this.db.prepare("SELECT id FROM memory_governance_records WHERE scope_key=? AND kind='preference' AND conflict_key=? AND status IN ('active','review')")
          .all(key, conflictKey) as Array<{ id: string }>
        if (existing.length > 0) {
          conflict = true
          this.db.prepare("UPDATE memory_governance_records SET status='review',updated_at=? WHERE scope_key=? AND kind='preference' AND conflict_key=? AND status='active'")
            .run(now, key, conflictKey)
          status = "review"
        }
      }
      this.db.prepare(`INSERT INTO memory_governance_records
        (id,agent_id,owner_id,workspace_id,scope_key,kind,content,provenance,source_type,source_reference,confidence,status,conflict_key,supersedes_id,evidence_ids_json,created_at,updated_at,expires_at,metadata_json)
        VALUES (@id,@agentId,@ownerId,@workspaceId,@scopeKey,@kind,@content,@provenance,@sourceType,@sourceReference,@confidence,@status,@conflictKey,@supersedesId,@evidenceIds,@createdAt,@updatedAt,@expiresAt,@metadata)`)
        .run({ id, agentId: scope.agentId, ownerId: scope.ownerId, workspaceId: scope.workspaceId, scopeKey: key, kind: input.kind, content,
          provenance, sourceType: input.sourceType, sourceReference: input.sourceReference ? safeText(input.sourceReference, 256) : null,
          confidence, status, conflictKey, supersedesId: input.supersedesId ?? null, evidenceIds: JSON.stringify(evidenceIds),
          createdAt: now, updatedAt: now, expiresAt, metadata: metadataJson })
      const row = this.db.prepare("SELECT * FROM memory_governance_records WHERE id=?").get(id) as Record<string, unknown>
      return { record: rowToRecord(row), stored: true, conflict }
    })
    return transaction()
  }

  recordPreference(input: {
    scope: MemoryScope
    content: string
    sourceReference?: string
    supersedesId?: string
  }): { record: MemoryGovernanceRecord; stored: boolean; conflict: boolean } {
    return this.record({
      scope: input.scope,
      kind: "preference",
      content: input.content,
      sourceType: "owner_explicit",
      sourceReference: input.sourceReference,
      confidence: 1,
      conflictKey: preferenceConflictKey(input.content),
      supersedesId: input.supersedesId,
      metadata: { capture: "explicit_user_preference", version: 1 },
    })
  }

  createProcedureCandidate(input: {
    scope: MemoryScope
    runId: string
    messageId?: string
    steps: Array<{ name: string; arguments?: string; result?: string; status?: string; durationMs?: number }>
    platform: string
  }): MemoryGovernanceRecord | null {
    const steps = input.steps.slice(0, 12).map((step) => ({
      tool: safeText(step.name, 120),
      arguments: safeText(step.arguments ?? "", 700),
      result: safeText(step.result ?? "", 240),
      status: step.status === "succeeded" ? "succeeded" : "failed",
      durationMs: Number.isFinite(Number(step.durationMs)) ? Math.max(0, Math.min(3_600_000, Number(step.durationMs))) : undefined,
    })).filter((step) => step.tool)
    if (steps.length < 2 || steps.filter((step) => step.status === "succeeded").length < 2) return null
    const tools = [...new Set(steps.map((step) => step.tool))]
    const content = `Candidate workflow: ${tools.join(" → ")}`
    return this.record({
      scope: input.scope,
      kind: "procedure",
      content,
      sourceType: "agent_inference",
      sourceReference: input.messageId || input.runId,
      confidence: 0.5,
      evidenceIds: [input.runId],
      metadata: {
        title: content,
        preconditions: [],
        steps,
        expectedOutput: "The originating chat run completed successfully; this workflow remains a draft until owner review.",
        failureHandling: "Stop on failed tool result; re-check current state before retrying side effects.",
        platform: safeText(input.platform, 40),
        toolRequirements: tools,
        originatingRunId: safeText(input.runId, 160),
        verification: "run_completed_not_independently_verified",
      },
    }).record
  }

  approveProcedure(scopeInput: MemoryScope, id: string, approvedBy: string): MemoryGovernanceRecord | null {
    const scope = normalizeScope(scopeInput)
    const key = scopeKey(scope)
    const row = this.db.prepare("SELECT * FROM memory_governance_records WHERE scope_key=? AND id=? AND kind='procedure' AND status IN ('draft','review')")
      .get(key, id) as Record<string, unknown> | undefined
    if (!row) return null
    const evidence = (() => { try { const value = JSON.parse(String(row.evidence_ids_json || "[]")); return Array.isArray(value) ? value : [] } catch { return [] } })()
    if (evidence.length < 1) throw new Error("A procedure needs at least one originating run evidence reference before owner review.")
    const metadata = { ...parseJson(row.metadata_json), ownerApprovedBy: safeText(approvedBy, 120), ownerApprovedAt: new Date().toISOString(), verification: "owner_reviewed_not_model_self_approved" }
    this.db.prepare("UPDATE memory_governance_records SET status='active',provenance='owner',source_type='owner_explicit',confidence=0.95,updated_at=?,metadata_json=? WHERE scope_key=? AND id=?")
      .run(new Date().toISOString(), safeJson(metadata), key, id)
    return this.get(scope, id)
  }

  listPreferenceConflicts(scopeInput: MemoryScope, conflictKey: string): MemoryGovernanceRecord[] {
    const scope = normalizeScope(scopeInput)
    return (this.db.prepare("SELECT * FROM memory_governance_records WHERE scope_key=? AND kind='preference' AND conflict_key=? AND status='review' ORDER BY updated_at DESC")
      .all(scopeKey(scope), conflictKey) as Array<Record<string, unknown>>).map(rowToRecord)
  }

  listUnresolvedConflicts(scopeInput: MemoryScope, limit = 50): MemoryGovernanceRecord[] {
    const scope = normalizeScope(scopeInput)
    return (this.db.prepare("SELECT * FROM memory_governance_records WHERE scope_key=? AND kind='preference' AND status='review' ORDER BY updated_at DESC LIMIT ?")
      .all(scopeKey(scope), Math.max(1, Math.min(200, Math.floor(limit)))) as Array<Record<string, unknown>>).map(rowToRecord)
  }

  get(scopeInput: MemoryScope, id: string): MemoryGovernanceRecord | null {
    const scope = normalizeScope(scopeInput)
    const row = this.db.prepare("SELECT * FROM memory_governance_records WHERE scope_key=? AND id=?").get(scopeKey(scope), id) as Record<string, unknown> | undefined
    return row ? rowToRecord(row) : null
  }

  list(scopeInput: MemoryScope, options: { kind?: MemoryKind; status?: MemoryStatus; limit?: number } = {}): MemoryGovernanceRecord[] {
    const scope = normalizeScope(scopeInput)
    const clauses = ["scope_key=?"]
    const params: unknown[] = [scopeKey(scope)]
    if (options.kind && KINDS.has(options.kind)) { clauses.push("kind=?"); params.push(options.kind) }
    if (options.status && ["active", "draft", "review", "superseded"].includes(options.status)) { clauses.push("status=?"); params.push(options.status) }
    params.push(Math.max(1, Math.min(200, Math.floor(options.limit ?? 50))))
    return (this.db.prepare(`SELECT * FROM memory_governance_records WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params) as Array<Record<string, unknown>>).map(rowToRecord)
  }

  search(scopeInput: MemoryScope, query: string, limit = 5, now = new Date()): Array<MemoryGovernanceRecord & { score: number }> {
    const scope = normalizeScope(scopeInput)
    const queryTerms = terms(query)
    if (queryTerms.length === 0) return []
    const rows = this.db.prepare(`SELECT * FROM memory_governance_records WHERE scope_key=? AND status='active'
      AND provenance IN ('owner','agent') AND kind IN ('preference','fact','recommendation','procedure')
      AND confidence>=? AND (expires_at IS NULL OR expires_at>?) ORDER BY updated_at DESC LIMIT 300`)
      .all(scopeKey(scope), MIN_RETRIEVAL_CONFIDENCE, now.toISOString()) as Array<Record<string, unknown>>
    const ranked = rows.map((row) => {
      const record = rowToRecord(row)
      // Keep long procedure metadata from diluting a direct content match. Metadata is
      // useful as a secondary recall path, but its many step/output tokens must not
      // swamp the title/content signal used for normal owner facts and preferences.
      const contentTerms = new Set(terms(record.content))
      const metadataTerms = new Set(terms(JSON.stringify(record.metadata)))
      const contentOverlap = queryTerms.filter((item) => contentTerms.has(item)).length
      const metadataOverlap = queryTerms.filter((item) => metadataTerms.has(item)).length
      const contentScore = contentOverlap / Math.max(1, queryTerms.length)
      const metadataScore = (metadataOverlap / Math.max(1, queryTerms.length)) * 0.65
      const score = Math.max(contentScore, metadataScore)
      return { ...record, score }
    }).filter((item) => item.score >= 0.2)
      .sort((a, b) => b.score - a.score || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    return ranked.slice(0, Math.max(1, Math.min(10, Math.floor(limit))))
  }

  delete(scopeInput: MemoryScope, id: string): boolean {
    const scope = normalizeScope(scopeInput)
    return this.db.prepare("DELETE FROM memory_governance_records WHERE scope_key=? AND id=?").run(scopeKey(scope), id).changes > 0
  }

  deleteByKind(scopeInput: MemoryScope, kind: MemoryKind): number {
    const scope = normalizeScope(scopeInput)
    if (!KINDS.has(kind)) throw new Error("Unsupported memory kind.")
    return this.db.prepare("DELETE FROM memory_governance_records WHERE scope_key=? AND kind=?").run(scopeKey(scope), kind).changes
  }

  purgeExpired(scopeInput?: MemoryScope, now = new Date()): number {
    if (!scopeInput) return this.db.prepare("DELETE FROM memory_governance_records WHERE expires_at IS NOT NULL AND expires_at<=?").run(now.toISOString()).changes
    const scope = normalizeScope(scopeInput)
    return this.db.prepare("DELETE FROM memory_governance_records WHERE scope_key=? AND expires_at IS NOT NULL AND expires_at<=?").run(scopeKey(scope), now.toISOString()).changes
  }
}
