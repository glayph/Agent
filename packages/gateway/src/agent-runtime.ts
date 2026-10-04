import express from "express"
import { randomUUID } from "node:crypto"
import type Database from "better-sqlite3"
import {
  AgentControlService,
  createControlRouter,
  createControlToolFactory,
  type LauncherAdminControllerLike,
} from "@miki/core/control"
import {
  AgentEngine,
  ApprovalStore,
  ToolRegistry,
  createControlTools,
  createFileManagementTools,
  createFetchLLMClient,
  createMemoryTools,
  createWorkspaceTools,
  describePlan,
  type EngineEvent,
  type EngineLLMClient,
  type EngineMessage,
  type EngineTool,
  type RunResult,
} from "@miki/core/engine"

type Json = Record<string, unknown>

export interface AgentRuntimeDeps {
  db: Database.Database
  dataRoot: string
  workspaceRoot: string
  getAppConfig(): Json
  setAppConfig(next: Json): void
  /** Stored model entries, default first. */
  storedModels(): Array<{ payload: Json; isDefault: boolean }>
  requireAuth: express.RequestHandler
  /** Runtime kill switch for script execution (dashboard and agent). */
  fileExecutionEnabled(): boolean
  recordFileRun(entry: { file: string; args: string[]; status: string; exitCode: number | null; durationMs: number; source: string }): void
  log?: (message: string, details?: Json) => void
}

const TOOL_GROUPS: Record<string, { label: string; defaultEnabled: boolean; names: (tool: string) => boolean }> = {
  filesystem: {
    label: "Workspace files",
    defaultEnabled: true,
    names: (n) => ["workspace_list", "file_read", "workspace_search", "file_write"].includes(n) || n.startsWith("file_"),
  },
  memory: { label: "Long-term memory", defaultEnabled: true, names: (n) => n.startsWith("memory_") },
  control: { label: "Agent control", defaultEnabled: true, names: (n) => n.startsWith("agent_control_") },
}

const isRecord = (value: unknown): value is Json =>
  Boolean(value && typeof value === "object" && !Array.isArray(value))

function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") continue
    out[key] = isRecord(value) && isRecord(out[key]) ? deepMerge(out[key] as Json, value) : value
  }
  return out
}

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]"
  } catch {
    return false
  }
}

export function createAgentRuntime(deps: AgentRuntimeDeps) {
  const { db } = deps
  const now = () => new Date().toISOString()

  // ---- model resolution ---------------------------------------------------
  const llmFor = (requested?: string): EngineLLMClient | undefined => {
    const stored = deps.storedModels()
    const entry = requested
      ? stored.find((item) => item.payload.model === requested || item.payload.model_name === requested)
      : stored.find((item) => item.isDefault) ?? stored[0]
    const payload = entry?.payload ?? {}
    const model = String(
      requested || payload.model || payload.model_name || process.env.MIKI_MODEL || process.env.OPENAI_MODEL || "",
    ).trim()
    if (!model) return undefined
    const apiKey = String(payload.api_key || process.env.OPENAI_API_KEY || "")
    const baseUrl = String(payload.api_base || process.env.OPENAI_API_BASE || "https://api.openai.com/v1")
    if (!apiKey && !isLocalUrl(baseUrl)) return undefined
    return createFetchLLMClient({ baseUrl, model, apiKey: apiKey || undefined })
  }

  // ---- tools --------------------------------------------------------------
  const memoryPort = {
    search(query: string, limit: number) {
      const needle = `%${query.replace(/[%_\\]/g, (c) => `\\${c}`).toLowerCase()}%`
      const rows = db
        .prepare(
          "SELECT id,content,region FROM memory_chunks WHERE lower(content) LIKE ? ESCAPE '\\' OR lower(summary) LIKE ? ESCAPE '\\' ORDER BY importance DESC, updated_at DESC LIMIT ?",
        )
        .all(needle, needle, limit) as Array<{ id: string; content: string; region: string }>
      return rows.map((row) => ({ id: row.id, text: row.content, region: row.region }))
    },
    add(entry: { content: string; summary?: string; region?: string }) {
      const id = randomUUID()
      const stamp = now()
      db.prepare(
        "INSERT INTO memory_chunks(id,region,content,summary,provenance,confidence,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(id, entry.region || "long_term", entry.content, entry.summary || entry.content.slice(0, 160), "agent", 1, 0.5, stamp, stamp)
      return { id }
    },
  }

  const registry = new ToolRegistry()
  const approvals = new ApprovalStore()

  // ---- control service ----------------------------------------------------
  const toolState = (): Record<string, boolean> => {
    const tools = deps.getAppConfig().tools
    const state = isRecord(tools) && isRecord(tools.tool_state) ? tools.tool_state : {}
    const out: Record<string, boolean> = {}
    for (const [name, group] of Object.entries(TOOL_GROUPS))
      out[name] = typeof state[name] === "boolean" ? (state[name] as boolean) : group.defaultEnabled
    for (const [name, value] of Object.entries(state)) if (typeof value === "boolean" && !(name in out)) out[name] = value
    return out
  }

  let allTools: EngineTool[] = []
  const syncTools = () => {
    const state = toolState()
    for (const name of registry.names()) registry.unregister(name)
    for (const tool of allTools) {
      const group = Object.entries(TOOL_GROUPS).find(([, g]) => g.names(tool.name))?.[0]
      if (!group || state[group]) registry.register(tool)
    }
  }

  const controller: LauncherAdminControllerLike = {
    getConfig: () => {
      const config = deps.getAppConfig()
      const tools = isRecord(config.tools) ? config.tools : {}
      return {
        ...config,
        tools: { ...tools, tool_state: toolState() },
        models: deps.storedModels().map((item) => ({ ...item.payload, is_default: item.isDefault })),
      }
    },
    validateConfig: (candidate) => validate(candidate),
    validatePatch: (patch) => validate(patch),
    async applyPatch(patch) {
      if (!validate(patch).valid) throw new Error("Configuration patch is not valid.")
      const { models: _models, ...storable } = patch
      deps.setAppConfig(deepMerge(deps.getAppConfig(), storable))
      syncTools()
      return { runtime_apply_status: "applied", gateway_restart_required: false }
    },
    async setToolState(name, enabled) {
      const config = deps.getAppConfig()
      const tools = isRecord(config.tools) ? config.tools : {}
      const state = isRecord(tools.tool_state) ? tools.tool_state : {}
      deps.setAppConfig({ ...config, tools: { ...tools, tool_state: { ...state, [name]: enabled } } })
      syncTools()
      return { runtime_apply_status: "applied", gateway_restart_required: false }
    },
  }

  function validate(value: Json): Json {
    const errors: string[] = []
    if (!isRecord(value)) errors.push("Configuration must be an object.")
    else {
      try {
        if (JSON.stringify(value).length > 64_000) errors.push("Configuration is larger than 64 KB.")
      } catch {
        errors.push("Configuration is not serializable.")
      }
      if ("factory_reset" in value) errors.push("factory_reset is not allowed.")
    }
    return { valid: errors.length === 0, errors }
  }

  const control = new AgentControlService({
    controller,
    runtimePaths: { dataDir: deps.dataRoot } as never,
    approvals,
    hooks: {
      reload: async () => ({ pendingRestart: false }),
      readToolState: toolState,
      readExtraState: () => ({
        engine: {
          tools: registry.names(),
          pending_approvals: approvals.pendingCount(),
          model: llmFor()?.model ?? null,
        },
      }),
    },
  })

  allTools = [
    ...createWorkspaceTools({ root: deps.workspaceRoot }),
    ...createFileManagementTools({
      root: deps.workspaceRoot,
      executionEnabled: deps.fileExecutionEnabled,
      onRun: (entry) => deps.recordFileRun({ file: entry.file, args: entry.args, status: entry.status, exitCode: entry.exitCode, durationMs: entry.durationMs, source: "agent" }),
    }),
    ...createMemoryTools(memoryPort),
    ...createControlTools(createControlToolFactory(control)),
  ]
  syncTools()

  const engine = new AgentEngine({
    llm: llmFor,
    tools: registry,
    approvals,
    logger: (message, details) => deps.log?.(message, details as Json),
    maxTurns: Number(process.env.MIKI_AGENT_MAX_TURNS || 12),
    maxToolCalls: Number(process.env.MIKI_AGENT_MAX_TOOL_CALLS || 40),
  })

  // ---- run tracking (cancel, one run per session) -------------------------
  const runs = new Map<string, { controller: AbortController; sessionId?: string; startedAt: string; source: string }>()
  const sessionRuns = new Map<string, string>()

  function cancelRun(runId: string): boolean {
    const run = runs.get(runId)
    if (!run) return false
    run.controller.abort()
    return true
  }

  async function startRun(input: {
    sessionId?: string
    history: EngineMessage[]
    model?: string
    allowTools?: boolean
    source: string
    runId?: string
    onEvent?: (event: EngineEvent) => void
    signal?: AbortSignal
  }): Promise<RunResult> {
    const runId = input.runId ?? `run_${randomUUID()}`
    if (input.sessionId && sessionRuns.has(input.sessionId))
      throw new Error("A run is already active for this session.")
    const controller = new AbortController()
    input.signal?.addEventListener("abort", () => controller.abort(), { once: true })
    runs.set(runId, { controller, sessionId: input.sessionId, startedAt: now(), source: input.source })
    if (input.sessionId) sessionRuns.set(input.sessionId, runId)
    try {
      return await engine.run({
        runId,
        sessionId: input.sessionId,
        history: input.history,
        model: input.model,
        allowTools: input.allowTools,
        signal: controller.signal,
        onEvent: input.onEvent,
      })
    } finally {
      runs.delete(runId)
      if (input.sessionId && sessionRuns.get(input.sessionId) === runId) sessionRuns.delete(input.sessionId)
    }
  }

  // ---- HTTP routes --------------------------------------------------------
  function mount(app: express.Express) {
    // Auth covers everything under /api/control, including the approval
    // endpoints, so an unauthenticated visitor can never approve a request.
    app.use("/api/control", deps.requireAuth)

    // Approval queue (dashboard-facing). Mounted before the typed control router.
    app.get("/api/control/approvals", (_req, res) => res.json({ requests: approvals.list() }))
    app.post("/api/control/approvals/:id/approve", (req, res) => {
      const decidedBy = typeof req.body?.decidedBy === "string" ? req.body.decidedBy : "dashboard-operator"
      const record = approvals.approve(req.params.id, decidedBy)
      if (!record) return res.status(404).json({ error: "Approval request not found" })
      if (record.status !== "approved") return res.status(409).json({ error: `Request is already ${record.status}`, request: record })
      return res.json({ request: record })
    })
    app.post("/api/control/approvals/:id/deny", (req, res) => {
      const decidedBy = typeof req.body?.decidedBy === "string" ? req.body.decidedBy : "dashboard-operator"
      const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined
      const record = approvals.deny(req.params.id, decidedBy, reason)
      if (!record) return res.status(404).json({ error: "Approval request not found" })
      if (record.status !== "denied") return res.status(409).json({ error: `Request is already ${record.status}`, request: record })
      return res.json({ request: record })
    })

    // capabilities, state, operations, plan, execute: core's typed control router.
    app.use("/api/control", createControlRouter(() => control))

    // Task handles used by the dashboard's stop button.
    app.get("/api/tasks/:id", deps.requireAuth, (req, res) => {
      const run = runs.get(req.params.id)
      if (!run) return res.status(404).json({ error: "Task not found or already finished" })
      return res.json({ id: req.params.id, status: "running", sessionId: run.sessionId, startedAt: run.startedAt })
    })
    app.delete("/api/tasks/:id", deps.requireAuth, (req, res) => {
      if (!cancelRun(req.params.id)) return res.status(404).json({ error: "Task not found or already finished" })
      return res.json({ status: "cancelling", id: req.params.id })
    })

    // Engine self-test. GET never calls a model; POST runs one real agent turn.
    app.get("/api/test", deps.requireAuth, (_req, res) => {
      const llm = llmFor()
      const checks = [
        { name: "model", ok: Boolean(llm), detail: llm ? `Resolved model ${llm.model}.` : "No model with credentials is configured." },
        { name: "tools", ok: registry.size > 0, detail: `${registry.size} tool(s): ${registry.names().join(", ")}` },
        { name: "control_service", ok: control.listCapabilities().length > 0, detail: `${control.listCapabilities().length} capability(ies).` },
        { name: "approvals", ok: true, detail: `${approvals.pendingCount()} pending.` },
        { name: "database", ok: Boolean(db.prepare("SELECT 1 AS ok").get()), detail: "SQLite reachable." },
        { name: "workspace", ok: true, detail: deps.workspaceRoot },
      ]
      res.json({ ok: checks.every((c) => c.ok), engine: "agent-engine", checks, activeRuns: runs.size, checkedAt: now() })
    })
    app.post("/api/test", deps.requireAuth, async (req, res) => {
      const prompt = typeof req.body?.prompt === "string" ? req.body.prompt.trim() : ""
      if (!prompt) return res.status(400).json({ error: "prompt is required" })
      const model = typeof req.body?.model === "string" && req.body.model.trim() ? req.body.model.trim() : undefined
      const events: Array<{ type: string; detail?: unknown }> = []
      try {
        const result = await startRun({
          history: [{ role: "user", content: prompt }],
          model,
          allowTools: req.body?.tools === true,
          source: "api-test",
          onEvent: (event) => {
            if (event.type === "tool.call") events.push({ type: event.type, detail: { name: event.call.name, status: event.call.status } })
            else if (event.type !== "message.final") events.push({ type: event.type })
          },
        })
        return res.status(result.status === "failed" ? 502 : 200).json({
          ok: result.status === "completed",
          status: result.status,
          model: result.model,
          answer: result.finalText,
          error: result.error,
          turns: result.turns,
          toolCalls: result.toolCalls.map((c) => ({ id: c.id, name: c.name, status: c.status, error: c.error })),
          plan: result.plan,
          usage: result.usage,
          events,
        })
      } catch (error) {
        return res.status(500).json({ ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
  }

  return { engine, control, approvals, registry, llmFor, mount, startRun, cancelRun, syncTools, describePlan, activeRunCount: () => runs.size }
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>

/** Map engine events onto the dashboard's WebSocket protocol. */
export function createWsEventMapper(send: (type: string, payload: Json) => void, model?: string) {
  const toolMessageId = (callId: string) => `tool-${callId}`
  const created = new Set<string>()
  /** Id of the final assistant message, so the caller can persist it under the same id. */
  const finalId = randomUUID()
  const handle = (event: EngineEvent) => {
    const runId = event.runId
    switch (event.type) {
      case "run.started":
        send("node.run_start", { run_id: runId, status: "running" })
        send("typing.start", { run_id: runId })
        break
      case "plan.created":
        send("message.create", {
          message_id: `plan-${event.plan.id}`,
          content: describePlan(event.plan),
          kind: "thought",
          thought_category: "Plan",
          run_id: runId,
        })
        break
      case "thought":
        send("message.create", {
          message_id: `thought-${runId}-${event.turn}`,
          content: event.content,
          kind: "thought",
          thought_category: "Thought",
          run_id: runId,
        })
        break
      case "tool.call": {
        const call = event.call
        const id = toolMessageId(call.id)
        const payload = {
          message_id: id,
          content: "",
          kind: "tool_calls",
          run_id: runId,
          tool_calls: [
            {
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: call.arguments },
              extra_content: {
                tool_feedback_explanation: call.error ? `${call.status}: ${call.error}` : call.status,
              },
            },
          ],
        }
        send(created.has(id) ? "message.update" : "message.create", payload)
        created.add(id)
        break
      }
      case "message.final":
        send("message.create", {
          message_id: finalId,
          content: event.content,
          kind: "normal",
          run_id: runId,
          ...(model ? { model_name: model } : {}),
        })
        break
      case "run.finished":
        send("typing.stop", { run_id: runId })
        send("node.run_end", {
          run_id: runId,
          status: event.status === "completed" ? "completed" : event.status === "cancelled" ? "cancelled" : "failed",
          ...(event.error ? { error: event.error } : {}),
        })
        break
      default:
        break
    }
  }
  return { handle, finalId }
}
