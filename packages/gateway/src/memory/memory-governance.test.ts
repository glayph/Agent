import Database from "better-sqlite3"
import { MemoryGovernanceStore } from "./memory-governance.js"

describe("MemoryGovernanceStore", () => {
  let db: Database.Database
  let store: MemoryGovernanceStore
  const scope = { agentId: "miki", ownerId: "owner-a", workspaceId: "workspace-a" }

  beforeEach(() => {
    db = new Database(":memory:")
    store = new MemoryGovernanceStore(db)
  })

  afterEach(() => db.close())

  it("isolates records by owner and workspace scope", () => {
    store.record({ scope, kind: "fact", content: "The project uses TypeScript", sourceType: "owner_explicit" })
    expect(store.list({ ...scope, workspaceId: "workspace-b" })).toHaveLength(0)
    expect(store.list({ ...scope, ownerId: "owner-b" })).toHaveLength(0)
  })

  it("puts contradictory preference candidates into review instead of silently choosing one", () => {
    store.recordPreference({ scope, content: "Always use bullet points in answers" })
    const second = store.recordPreference({ scope, content: "Never use bullet points in answers" })
    expect(second.conflict).toBe(true)
    expect(second.record.status).toBe("review")
    expect(store.listPreferenceConflicts(scope, second.record.conflictKey || "")).toHaveLength(2)
    expect(store.search(scope, "bullet points in answers")).toHaveLength(0)
  })

  it("allows an explicit owner supersession to resolve one reviewed preference", () => {
    const first = store.recordPreference({ scope, content: "Always use bullet points in answers" })
    store.recordPreference({ scope, content: "Never use bullet points in answers" })
    const replacement = store.recordPreference({ scope, content: "Use concise bullet points in answers", supersedesId: first.record.id })
    expect(replacement.record.status).toBe("active")
    expect(replacement.record.supersedesId).toBe(first.record.id)
    expect(store.get(scope, first.record.id)?.status).toBe("superseded")
  })

  it("keeps procedural learning in draft until explicit owner approval", () => {
    const candidate = store.createProcedureCandidate({
      scope,
      runId: "run-1",
      steps: [
        { name: "browser_navigate", arguments: '{"url":"https://example.test"}', result: "page loaded", status: "succeeded" },
        { name: "browser_click", arguments: '{"selector":"#submit"}', result: "clicked", status: "succeeded" },
      ],
      platform: "linux",
    })
    expect(candidate?.status).toBe("draft")
    expect(store.search(scope, "browser navigate")).toHaveLength(0)
    const approved = store.approveProcedure(scope, candidate!.id, "owner-a")
    expect(approved?.status).toBe("active")
    expect(approved?.provenance).toBe("owner")
    expect(store.search(scope, "browser navigate").length).toBeGreaterThan(0)
  })

  it("merges repeated workflow evidence without activating the procedure", () => {
    const steps = [
      { name: "browser_navigate", status: "succeeded" },
      { name: "browser_click", status: "succeeded" },
    ]
    const first = store.createProcedureCandidate({ scope, runId: "run-a", steps, platform: "win32" })
    const second = store.createProcedureCandidate({ scope, runId: "run-b", steps, platform: "win32" })
    expect(second?.id).toBe(first?.id)
    expect(second?.evidenceIds).toEqual(expect.arrayContaining(["run-a", "run-b"]))
    expect(second?.status).toBe("draft")
  })


  it("resolves every reviewed member when the owner explicitly supersedes a conflict group", () => {
    const first = store.recordPreference({ scope, content: "Always use bullet points in answers" })
    const second = store.recordPreference({ scope, content: "Never use bullet points in answers" })
    const replacement = store.recordPreference({ scope, content: "Use concise bullet points in answers", supersedesId: first.record.id })
    expect(replacement.record.status).toBe("active")
    expect(store.get(scope, first.record.id)?.status).toBe("superseded")
    expect(store.get(scope, second.record.id)?.status).toBe("superseded")
    expect(store.listUnresolvedConflicts(scope)).toHaveLength(0)
  })

  it("lets an explicit reaffirmation resolve a reviewed preference conflict", () => {
    const first = store.recordPreference({ scope, content: "Use bullet points in answers" })
    const second = store.recordPreference({ scope, content: "Do not use bullet points in answers" })
    expect(second.record.status).toBe("review")
    const reaffirmed = store.recordPreference({ scope, content: "Use bullet points in answers" })
    expect(reaffirmed.record.status).toBe("active")
    expect(store.get(scope, second.record.id)?.status).toBe("superseded")
    expect(store.listUnresolvedConflicts(scope)).toHaveLength(0)
  })

  it("redacts secrets inside JSON-serialized procedure arguments", () => {
    const candidate = store.createProcedureCandidate({
      scope,
      runId: "run-secret",
      steps: [
        { name: "browser_navigate", arguments: JSON.stringify({ api_key: "sk-super-secret-value-that-must-not-persist" }), result: "page loaded", status: "succeeded" },
        { name: "browser_click", arguments: "{}", result: "clicked", status: "succeeded" },
      ],
      platform: "linux",
    })
    const stored = JSON.stringify(candidate?.metadata)
    expect(stored).not.toContain("sk-super-secret-value-that-must-not-persist")
    expect(stored).toContain("[REDACTED]")
  })

  it("deletes all records for a root memory file kind without crossing scopes", () => {
    store.recordPreference({ scope, content: "Use concise answers" })
    store.record({ scope, kind: "fact", content: "The app uses SQLite", sourceType: "owner_explicit" })
    store.recordPreference({ scope: { ...scope, workspaceId: "workspace-b" }, content: "Use concise answers" })
    expect(store.deleteByKind(scope, "preference")).toBe(1)
    expect(store.list(scope, { kind: "preference" })).toHaveLength(0)
    expect(store.list(scope, { kind: "fact" })).toHaveLength(1)
    expect(store.list({ ...scope, workspaceId: "workspace-b" }, { kind: "preference" })).toHaveLength(1)
  })

  it("hides expired active records from both memory lists and search", () => {
    store.record({
      scope,
      kind: "fact",
      content: "This verified fact is no longer current",
      sourceType: "owner_explicit",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
    expect(store.list(scope, { status: "active" })).toHaveLength(0)
    expect(store.search(scope, "verified fact current")).toHaveLength(0)
  })

  it("redacts secrets and purges expired records", () => {
    const created = store.record({
      scope,
      kind: "temporary",
      content: "api_key=sk-this-is-a-long-secret-value that should not persist",
      sourceType: "owner_explicit",
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    })
    expect(created.record.content).not.toContain("sk-this-is-a-long-secret-value")
    expect(store.purgeExpired(scope)).toBe(1)
    expect(store.get(scope, created.record.id)).toBeNull()
  })
})
