import { resolveContextWindowTokens, resolveMaxToolIterations, resolveMaxWallTimeMs } from "./runtime-settings.js";
import { createTerminalTools } from "./terminal-tool.js";
import { ProcessManager } from "./process-manager.js";
import { resolveModel } from "./model-resolution.js";
import { buildIdentityContext } from "./identity-prompt.js";
import express from "express"
import { randomUUID } from "node:crypto"
import path from "node:path"
import fs from "node:fs"
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
  DurableTaskStore,
  ToolRegistry,
  buildSkillsContext,
  createControlTools,
  createFileManagementTools,
  createFetchLLMClient,
  createRegistryLLMClient,
  createMemoryTools,
  createSkillTools,
  createWorkspaceTools,
  describePlan,
  DEFAULT_SYSTEM_PROMPT,
  type EngineEvent,
  type EngineLLMClient,
  type EngineMessage,
  type EngineTool,
  type RunResult,
  type AgentPlan,
  type ToolApprovalPolicy,
} from "@miki/core/engine"
import type { SkillRegistryClient, SkillStore } from "@miki/core/skills"
import { searchWeb } from "@miki/core/web-search-service"
import { BrowserTool, ComputerAgent } from "@miki/core/plugins"
import { createGoalTools, GoalStore } from "@miki/core/api/goals"
import { planAdaptiveOutput, type AdaptiveMessagingConfig } from "@miki/core"
import { providerRegistry } from "@miki/core/llm/provider"
import { getLifecycleBus } from "@miki/core/hooks"
import type { FileMemoryService } from "@miki/core/memory-files"
import { createAttachmentCollector, type AttachmentContext, type ChatAttachmentPayload } from "./chat-attachments.js"
import type { GlobalMemory } from "@miki/core/memory"

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
  /** Skills the agent can discover, read, run, install and delete. */
  skills: { store: SkillStore; registry: SkillRegistryClient }
  /** Canonical Markdown memory, indexed by the gateway's SQLite adapter. */
  fileMemory?: FileMemoryService
  /** One memory shared by every channel (owner-only, see @miki/core/memory). */
  globalMemory?: GlobalMemory
  memoryContextPolicy?: () => Promise<{ user: boolean; memory: boolean }>
  externalRunActive?: (runId: string) => boolean
  externalCancelRun?: (runId: string) => boolean
  log?: (message: string, details?: Json) => void
}

const TOOL_GROUPS: Record<string, { label: string; defaultEnabled: boolean; names: (tool: string) => boolean }> = {
  filesystem: {
    label: "Workspace files",
    defaultEnabled: true,
    names: (n) => ["workspace_list", "file_read", "workspace_search", "file_write"].includes(n) || n.startsWith("file_"),
  },
  memory: { label: "Long-term memory", defaultEnabled: true, names: (n) => n.startsWith("memory_") },
  skills: { label: "Skills", defaultEnabled: true, names: (n) => n.startsWith("skill_") },
  control: { label: "Agent control", defaultEnabled: true, names: (n) => n.startsWith("agent_control_") },
  goals: { label: "Persistent goals", defaultEnabled: true, names: (n) => n.startsWith("goal_") },
  web_search: { label: "Web search", defaultEnabled: true, names: (n) => n === "web_search" },
  browser: { label: "Browser automation", defaultEnabled: true, names: (n) => n.startsWith("browser_") },
  terminal: { label: "Terminal", defaultEnabled: true, names: (n) => n.startsWith("terminal_") },
  computer: { label: "Computer use", defaultEnabled: false, names: (n) => n.startsWith("computer_") },
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

export function createAgentRuntime(deps: AgentRuntimeDeps) {
  const { db } = deps
  const now = () => new Date().toISOString()
  const taskStore = new DurableTaskStore(db, now)

  // ---- model resolution ---------------------------------------------------
  // Commands started by the agent. A slow command is never killed by a timeout: it keeps running,
  // the agent re-checks it (about every 60s) and is told the moment it exits.
  const processes = new ProcessManager()
  const noticedRuns = new Set<string>()
  // Single source of truth shared with the Models page and health endpoints
  // (see model-resolution.ts). An unknown requested name falls back to the
  // default model instead of building a ghost client, and keys are validated
  // structurally (not just for presence) before a model counts as configured.
  const resolveCurrentModel = (requested?: string) => resolveModel(deps.storedModels(), requested)
  const llmFor = (requested?: string): EngineLLMClient | undefined => {
    const resolved = resolveCurrentModel(requested)
    if (!resolved.configured) return undefined
    const payload = resolved.entry?.payload ?? {}
    const extraBody: Record<string, unknown> = isRecord(payload.extra_body) ? { ...payload.extra_body } : {};
    const configuredThinking = String(payload.thinking_level || "").trim();
    if (configuredThinking && extraBody.thinking_level === undefined) {
      extraBody.thinking_level = configuredThinking;
    }
    const providerPlugin = providerRegistry.getPluginRegistry().get(resolved.provider)
    if (providerPlugin) {
      return createRegistryLLMClient(providerRegistry, resolved.model, {
        providerId: resolved.provider,
        baseUrl: resolved.baseUrl,
        credentials: resolved.apiKey ? { apiKey: resolved.apiKey } : {},
        ...(Object.keys(extraBody).length ? { extra: extraBody } : {}),
      })
    }
    return createFetchLLMClient({ baseUrl: resolved.baseUrl, model: resolved.model, apiKey: resolved.apiKey || undefined, ...(Object.keys(extraBody).length ? { extraBody } : {}) })
  }

  // ---- tools --------------------------------------------------------------
  const memoryPort = {
    async search(query: string, limit: number, context?: { runId: string; sessionId?: string }) {
      const fileHits = deps.fileMemory?.isEnabled()
        ? await deps.fileMemory.search(query, limit)
        : []
      // Graph + semantic recall from the one global memory (owner-only). Ranking
      // comes from the memory engine, never from matching words in a SQL LIKE.
      const origin = context ? runOrigins.get(context.runId) : undefined
      const graphHits = origin && deps.globalMemory ? deps.globalMemory.search(query, origin, limit) : []
      const fileResults = fileHits.map((hit) => ({
        id: `file:${hit.path}:${hit.startLine}`,
        text: hit.snippet,
        region: hit.path,
        score: hit.score,
      }))
      const seen = new Set<string>()
      return [...fileResults, ...graphHits].filter((hit) => {
        const key = hit.text.trim().toLocaleLowerCase()
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      }).slice(0, limit)
    },
    async add(entry: { content: string; summary?: string; region?: string; supersedes?: string }) {
      if (entry.region === "untrusted") {
        const id = randomUUID()
        const stamp = now()
        db.prepare(
          "INSERT INTO memory_chunks(id,region,content,summary,provenance,confidence,importance,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(id, "untrusted", entry.content, entry.summary || entry.content.slice(0, 160), "untrusted", 0.5, 0.25, stamp, stamp)
        return { id }
      }
      if (deps.fileMemory?.isEnabled()) {
        const scope = entry.region === "daily" ? "daily" : entry.region === "user" ? "user" : "long_term"
        const saved = await deps.fileMemory.note(entry.content, scope, entry.supersedes)
        return { id: `file:${saved.path}` }
      }
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
  const browser = new BrowserTool(true, deps.dataRoot)
  const effectiveWorkspaceRoot = () => {
    const configured = (deps.getAppConfig() as any)?.agents?.defaults?.workspace
    if (typeof configured !== "string" || !configured.trim()) return deps.workspaceRoot
    const candidate = path.resolve(configured)
    // Ignore stale absolute paths from a different installation/user.
    return fs.existsSync(candidate) ? candidate : deps.workspaceRoot
  }
  browser.setWorkspaceDir(effectiveWorkspaceRoot())
  const computer = new ComputerAgent()

  // ---- control service ----------------------------------------------------
  const toolState = (): Record<string, boolean> => {
    const config = deps.getAppConfig()
    const tools = config.tools
    const state = isRecord(tools) && isRecord(tools.tool_state) ? tools.tool_state : {}
    const autonomy = config.autonomy
    const toolPolicy = isRecord(autonomy) && isRecord(autonomy.tool_policy) ? autonomy.tool_policy : {}
    const computerAllowed = toolPolicy.allow_computer_use === true
    const out: Record<string, boolean> = {}
    for (const [name, group] of Object.entries(TOOL_GROUPS)) {
      const enabledByDefault = name === "computer" ? computerAllowed : group.defaultEnabled
      out[name] = typeof state[name] === "boolean" ? (state[name] as boolean) : enabledByDefault
    }
    for (const [name, value] of Object.entries(state)) if (typeof value === "boolean" && !(name in out)) out[name] = value
    return out
  }

  let allTools: EngineTool[] = []
  const syncTools = () => {
    const autonomy = deps.getAppConfig().autonomy
    const autonomyConfig = isRecord(autonomy) ? autonomy : {}
    const toolPolicy = isRecord(autonomyConfig.tool_policy) ? autonomyConfig.tool_policy : {}
    const allowedDomains = Array.isArray(toolPolicy.browser_allowed_domains)
      ? toolPolicy.browser_allowed_domains.filter((value): value is string => typeof value === "string")
      : []
    const bypassRestrictions = (deps.getAppConfig() as any)?.agent?.security?.bypass_restrictions === true
    browser.setBypassRestrictions(bypassRestrictions)
    browser.setAllowedDomains(bypassRestrictions ? [] : allowedDomains)
    browser.setWorkspaceDir(effectiveWorkspaceRoot())
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
        models: deps.storedModels().map((item) => {
          const publicModel = isRecord(item.payload) ? { ...item.payload } : {}
          delete publicModel.api_key
          delete publicModel.api_key_ref
          return { ...publicModel, is_default: item.isDefault }
        }),
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
    ...createGoalTools(new GoalStore(db)),
    ...createWorkspaceTools({
      root: effectiveWorkspaceRoot,
      restrictToWorkspace: () => (deps.getAppConfig() as any)?.agents?.defaults?.restrict_to_workspace !== false,
    }).filter((tool) => tool.name !== "file_read"),
    ...createFileManagementTools({
      root: effectiveWorkspaceRoot,
      restrictToWorkspace: () => (deps.getAppConfig() as any)?.agents?.defaults?.restrict_to_workspace !== false,
      executionEnabled: deps.fileExecutionEnabled,
      onRun: (entry) => deps.recordFileRun({ file: entry.file, args: entry.args, status: entry.status, exitCode: entry.exitCode, durationMs: entry.durationMs, source: "agent" }),
    }),
    ...createMemoryTools(memoryPort),
    ...createSkillTools({
      store: deps.skills.store,
      registry: deps.skills.registry,
      workspaceRoot: effectiveWorkspaceRoot,
      executionEnabled: deps.fileExecutionEnabled,
      allowedSkills: () => {
        const profile = (deps.getAppConfig() as any)?.agents?.defaults?.turn_profile;
        if (!profile || profile.enabled !== true) return undefined;
        const skills = profile.skills || {};
        if (String(skills.mode || "default") === "off") return [];
        if (String(skills.mode || "default") !== "custom") return undefined;
        return Array.isArray(skills.allow) ? skills.allow.filter((value: unknown): value is string => typeof value === "string") : [];
      },
      onRun: (entry) => deps.recordFileRun({ file: `${entry.skill}/${entry.script}`, args: entry.args, status: entry.status, exitCode: entry.exitCode, durationMs: entry.durationMs, source: `skill:${entry.skill}` }),
    }),
    ...createControlTools(createControlToolFactory(control)),
    ...createTerminalTools({
      root: effectiveWorkspaceRoot,
      restrictToWorkspace: () => (deps.getAppConfig() as any)?.agents?.defaults?.restrict_to_workspace !== false,
      processes,
    }),
    {
      name: "browser_navigate",
      description: "Open an HTTP or HTTPS page in the headless browser.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { url: { type: "string", description: "HTTP(S) URL to open." } }, required: ["url"], additionalProperties: false },
      async execute(input) { return browser.navigate(String(input.url || "")) },
    },
    {
      name: "browser_click",
      description: "Click a visible element by a Playwright selector on the current page.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"], additionalProperties: false },
      async execute(input) { return browser.click(String(input.selector || "")) },
    },
    {
      name: "browser_type",
      description: "Type text into a browser selector.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { selector: { type: "string" }, text: { type: "string", maxLength: 4000 } }, required: ["selector", "text"], additionalProperties: false },
      async execute(input) { return browser.type(String(input.selector || ""), String(input.text || "")) },
    },
    {
      name: "browser_extract",
      description: "Extract visible text from the current browser page or a CSS selector. Read-only.",
      risk: "read",
      approval: "auto",
      parameters: { type: "object", properties: { selector: { type: "string" } }, additionalProperties: false },
      async execute(input) { return browser.extract(typeof input.selector === "string" ? input.selector : undefined) },
    },
    {
      name: "browser_screenshot",
      description: "Capture a screenshot of the current browser page and return its saved path.",
      risk: "read",
      approval: "auto",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() { return browser.screenshot() },
    },
    {
      name: "web_search",
      description: "Search the web and return ranked results with citations.",
      risk: "read",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query." },
          max_results: { type: "integer", minimum: 1, maximum: 10, description: "Maximum number of results." },
          mode: { type: "string", enum: ["local", "cloud", "auto"], description: "Search execution mode." },
          provider: { type: "string", description: "Optional provider override." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      async execute(input) {
        const query = typeof input.query === "string" ? input.query : ""
        const config = deps.getAppConfig().web_search
        const webSearchConfig = isRecord(config) ? config : {}
        return searchWeb(path.join(deps.workspaceRoot, "config"), webSearchConfig, query, {
          maxResults: input.max_results,
          mode: input.mode,
          provider: input.provider,
        })
      },
    },
    {
      name: "computer_observe",
      description: "Observe available desktop windows and UI metadata; element-level automation depends on the platform.",
      risk: "read",
      approval: "auto",
      parameters: { type: "object", properties: { active_only: { type: "boolean" }, max_elements: { type: "integer", minimum: 1, maximum: 300 }, query: { type: "string" }, window_title: { type: "string" }, process_name: { type: "string" }, window_handle: { type: "integer" } }, additionalProperties: false },
      async execute(input) { return computer.observe(input) },
    },
    {
      name: "computer_focus",
      description: "Focus a native desktop window.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { window_title: { type: "string" }, process_name: { type: "string" }, window_handle: { type: "integer" } }, additionalProperties: false },
      async execute(input) { return computer.focus(input) },
    },
    {
      name: "computer_invoke",
      description: "Invoke an accessible desktop UI element observed by computer_observe.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { element_id: { type: "string" }, name: { type: "string" }, automation_id: { type: "string" }, control_type: { type: "string" }, window_title: { type: "string" }, process_name: { type: "string" }, window_handle: { type: "integer" } }, additionalProperties: false },
      async execute(input) { return computer.invoke(input) },
    },
    {
      name: "computer_set_text",
      description: "Set text in an accessible native UI field.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { element_id: { type: "string" }, name: { type: "string" }, automation_id: { type: "string" }, control_type: { type: "string" }, text: { type: "string", maxLength: 4000 }, window_title: { type: "string" }, process_name: { type: "string" }, window_handle: { type: "integer" } }, required: ["text"], additionalProperties: false },
      async execute(input) { return computer.setText(input) },
    },
    {
      name: "computer_hotkey",
      description: "Send a deterministic keyboard shortcut to the focused desktop window.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { keys: { type: "string" }, window_title: { type: "string" }, process_name: { type: "string" }, window_handle: { type: "integer" } }, required: ["keys"], additionalProperties: false },
      async execute(input) { return computer.hotkey(input) },
    },
    {
      name: "computer_clipboard",
      description: "Read, set, or clear the system clipboard.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { action: { type: "string", enum: ["get", "set", "clear"] }, text: { type: "string", maxLength: 10000 } }, additionalProperties: false },
      async execute(input) { return computer.clipboard(input) },
    },
    {
      name: "computer_launch",
      description: "Launch a local application without shell command interpretation.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { command: { type: "string" }, args: { type: "array", items: { type: "string" } }, working_dir: { type: "string" } }, required: ["command"], additionalProperties: false },
      async execute(input) { return computer.launch(input) },
    },
    {
      name: "computer_verify",
      description: "Verify that native desktop UI contains or does not contain expected text.",
      risk: "read",
      approval: "auto",
      parameters: { type: "object", properties: { contains: { type: "string" }, not_contains: { type: "string" }, window_title: { type: "string" }, process_name: { type: "string" }, window_handle: { type: "integer" }, max_elements: { type: "integer", minimum: 1, maximum: 300 } }, additionalProperties: false },
      async execute(input) { return computer.verify(input) },
    },
    {
      name: "computer_screenshot",
      description: "Capture a screenshot of the primary display.",
      risk: "read",
      approval: "auto",
      parameters: { type: "object", properties: { grid: { type: "boolean" }, grid_step: { type: "integer", minimum: 20, maximum: 500 } }, additionalProperties: false },
      async execute(input) { return computer.screenshot(input) },
    },
    {
      name: "computer_click_at",
      description: "Click a desktop screen coordinate, optionally double-clicking or choosing a mouse button.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "middle", "right"] }, double_click: { type: "boolean" } }, required: ["x", "y"], additionalProperties: false },
      async execute(input) { return computer.clickAt(input) },
    },
    {
      name: "computer_drag",
      description: "Drag the pointer between desktop screen coordinates.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { from_x: { type: "number" }, from_y: { type: "number" }, to_x: { type: "number" }, to_y: { type: "number" } }, required: ["from_x", "from_y", "to_x", "to_y"], additionalProperties: false },
      async execute(input) { return computer.drag(input) },
    },
    {
      name: "computer_scroll",
      description: "Scroll the desktop pointer in a direction by a bounded number of wheel steps.",
      risk: "config_write",
      approval: "required",
      parameters: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false },
      async execute(input) { return computer.scroll(input) },
    },
    {
      name: "computer_terminate_app",
      description: "Terminate a desktop application by process ID or process name.",
      risk: "destructive",
      approval: "required",
      parameters: { type: "object", properties: { pid: { type: "integer" }, process_name: { type: "string" } }, additionalProperties: false },
      async execute(input) { return computer.terminateApp(input) },
    },
    {
      name: "computer_list_processes",
      description: "List running desktop processes.",
      risk: "read",
      approval: "auto",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(input) { return computer.listProcesses(input) },
    },
    {
      name: "computer_get_system_info",
      description: "Get operating system and hardware information.",
      risk: "read",
      approval: "auto",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(input) { return computer.getSystemInfo(input) },
    },
    {
      name: "computer_list_displays",
      description: "List connected displays and their bounds.",
      risk: "read",
      approval: "auto",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute(input) { return computer.listDisplays(input) },
    },
  ]
  syncTools()

  const engine = new AgentEngine({
    // Finished background commands are announced to the model at the start of its next turn,
    // so it never has to poll; the first turn of a run also lists commands still running.
    notifications: ({ runId, sessionId }) => {
      const notices = processes.takeFinishedNotices(sessionId)
      if (!noticedRuns.has(runId)) {
        noticedRuns.add(runId)
        if (noticedRuns.size > 500) noticedRuns.delete(noticedRuns.values().next().value as string)
        const running = processes.runningSummary(sessionId)
        if (running.length) notices.push(`Commands still running from earlier: ${running.join("; ")}`)
      }
      return notices
    },
    llm: llmFor,
    describeNoModel: (requested) => resolveCurrentModel(requested).reason,
    tools: registry,
    approvals,
    // Interactive Miki runs execute user-directed tool calls directly. Tool
    // metadata still records risk and autonomy policies may hard-block calls,
    // but ordinary chat must not stall waiting for an approval queue.
    turboMode: true,
    // Dynamic budget: a run that hits its turn / tool limit while still making
    // progress gets a bounded extension. Disable with agent.dynamic_budget.enabled=false.
    dynamicBudget: () => {
      const cfg = (deps.getAppConfig() as any)?.agent?.dynamic_budget
      if (cfg?.enabled === false) return false
      const extensionTurns = Number(cfg?.extension_turns)
      const maxExtensions = Number(cfg?.max_extensions)
      return {
        ...(Number.isFinite(extensionTurns) ? { extensionTurns: Math.min(24, Math.max(1, Math.floor(extensionTurns))) } : {}),
        ...(Number.isFinite(maxExtensions) ? { maxExtensions: Math.min(5, Math.max(0, Math.floor(maxExtensions))) } : {}),
      }
    },
    // Accuracy: a tool-using run checks its draft answer against the evidence and
    // revises once on a concrete problem. Disable with agent.self_check.enabled=false.
    selfCheck: () => {
      const cfg = (deps.getAppConfig() as any)?.agent?.self_check
      if (cfg?.enabled === false) return false
      const maxRevisions = Number(cfg?.max_revisions)
      const minToolCalls = Number(cfg?.min_tool_calls)
      return {
        ...(Number.isFinite(maxRevisions) ? { maxRevisions: Math.min(2, Math.max(0, Math.floor(maxRevisions))) } : {}),
        ...(Number.isFinite(minToolCalls) ? { minToolCalls: Math.max(1, Math.floor(minToolCalls)) } : {}),
      }
    },
    // Identity + live capability context; the model still writes every reply itself.
    systemPrompt: () => {
      const config = deps.getAppConfig() as any
      const persona = typeof config?.agent?.persona === "string" ? config.agent.persona : undefined
      const state = toolState()
      const identity = buildIdentityContext({
        groups: Object.keys(TOOL_GROUPS).map((key) => ({ key, enabled: state[key] === true })),
        persona,
        specialistId: "miki",
        identityDirs: [path.join(deps.workspaceRoot, "identity"), path.join(deps.workspaceRoot, "config", "identity")],
      })
      return `${DEFAULT_SYSTEM_PROMPT}\n\n${identity}`
    },
    // Inject curated memory every turn and advertise only the skills permitted
    // by the active turn profile. Episodic notes remain retrieval-only.
    contextProvider: async (info) => {
      // Memory and the skills catalog are independent; build them concurrently so
      // the first model call is not delayed by two sequential lookups.
      const memoryBlock = async (): Promise<string | undefined> => {
        if (!deps.fileMemory?.isEnabled()) return undefined
        const trust = await deps.memoryContextPolicy?.()
        const memory = await deps.fileMemory.buildContextBlock({
          ...(trust ? { trustedUser: trust.user, trustedMemory: trust.memory } : {}),
        })
        return memory || undefined
      }
      const skillsBlock = async (): Promise<string | undefined> => {
        if (!info.toolsEnabled || !registry.has("skill_read")) return undefined
        const profile = (deps.getAppConfig() as any)?.agents?.defaults?.turn_profile
        if (profile?.enabled === true) {
          const skills = profile.skills || {}
          const mode = String(skills.mode || "default")
          if (mode === "off") return undefined
          if (mode === "custom") {
            const allow = new Set(Array.isArray(skills.allow) ? skills.allow.filter((value: unknown): value is string => typeof value === "string").map((value: string) => value.trim()).filter(Boolean) : [])
            const records = (await deps.skills.store.list()).filter((record) => allow.has(record.name))
            if (!records.length) return undefined
            const lines = records.map((skill) => `- ${skill.name}: ${skill.description.replace(/\s+/g, " ").slice(0, 140)}`).join("\n")
            return [
              "Installed skills enabled for this turn:",
              "Only the following skills are permitted. Call skill_read with one of these names before following its instructions.",
              lines,
            ].join("\n")
          }
        }
        return (await buildSkillsContext(deps.skills.store)) || undefined
      }
      // Semantic recall from the one global memory, keyed by what the user just asked.
      // Owner-only: strangers on any channel get nothing and leave nothing.
      const recalled = async (): Promise<string | undefined> => {
        const origin = runOrigins.get(info.runId)
        if (!origin || !deps.globalMemory) return undefined
        return deps.globalMemory.recall(info.goal, origin)
      }
      const [memory, skills, global] = await Promise.all([memoryBlock(), skillsBlock(), recalled()])
      return [memory, global, skills].filter(Boolean).join("\n\n") || undefined
    },
    logger: (message, details) => deps.log?.(message, details as Json),
    // In-run context management. Evaluated at the start of every run, so a config
    // change applies to the next run without restarting the gateway.
    get compaction() {
      const defaults = ((deps.getAppConfig() as any)?.agents?.defaults ?? {}) as Record<string, unknown>
      if (defaults.run_compaction === false) return false as const
      const percent = Number(defaults.run_compaction_percent)
      return Number.isFinite(percent) && percent > 0 ? { triggerRatio: percent / 100 } : {}
    },
    // Details leave the context window only after their summary is in durable,
    // cross-session memory, so a long task is never forgotten mid-way or later.
    onContextCompact: (info) => {
      if (!deps.fileMemory?.isEnabled()) return
      deps.fileMemory.noteDaily(
        `Task in progress: ${oneLine(info.goal, 200)}\nProgress notes (${info.droppedMessages} earlier steps compacted):\n${info.summary}`,
        "run",
      )
    },
    // Use the explicitly configured per-agent fallback list first, followed by
    // the default model-router lane's fallback list. Never infer alternate models.
    fallbackModels: () => {
      const config = (deps.getAppConfig() ?? {}) as any
      const defaults = (config.agents?.defaults ?? {}) as Record<string, unknown>
      const lane = config.agent?.model_router?.lanes?.default
      const candidates = [
        ...(Array.isArray(defaults.fallback_models) ? defaults.fallback_models : []),
        ...(Array.isArray(lane?.fallbacks) ? lane.fallbacks : []),
      ]
      return [...new Set(candidates.filter((name: unknown): name is string => typeof name === "string" && name.trim().length > 0).map((name: string) => name.trim()))]
    },
    // FULL_AGENT mode intentionally has no internal call/turn/time budget.
    maxTurns: () => (deps.getAppConfig() as any)?.autonomy?.unlimited_budgets === true
      ? Number.POSITIVE_INFINITY
      : Math.max(1, resolveMaxToolIterations(((deps.getAppConfig() as any)?.agents?.defaults ?? {}) as Record<string, unknown>)),
    maxToolCalls: () => (deps.getAppConfig() as any)?.autonomy?.unlimited_budgets === true
      ? Number.POSITIVE_INFINITY
      : Number(process.env.MIKI_AGENT_MAX_TOOL_CALLS || 40),
    maxToolIterations: () => (deps.getAppConfig() as any)?.autonomy?.unlimited_budgets === true
      ? Number.POSITIVE_INFINITY
      : resolveMaxToolIterations(((deps.getAppConfig() as any)?.agents?.defaults ?? {}) as Record<string, unknown>),
    maxWallTimeMs: () => (deps.getAppConfig() as any)?.autonomy?.unlimited_budgets === true
      ? 0
      : resolveMaxWallTimeMs(((deps.getAppConfig() as any)?.agents?.defaults ?? {}) as Record<string, unknown>),
    contextWindowTokens: () => resolveContextWindowTokens(((deps.getAppConfig() as any)?.agents?.defaults ?? {}) as Record<string, unknown>),
    maxCompletionTokens: () => (deps.getAppConfig() as any)?.autonomy?.unlimited_budgets === true
      ? undefined
      : Number((deps.getAppConfig() as any)?.agents?.defaults?.max_completion_tokens ?? (deps.getAppConfig() as any)?.agents?.defaults?.max_tokens ?? 0) || undefined,
    systemPromptEnabled: () => {
      const p = (deps.getAppConfig() as any)?.agents?.defaults?.turn_profile;
      return !p || p.enabled !== true || String(p?.system_prompt?.mode || "default") !== "off";
    },
  })

  /**
   * Background graph extraction: a few not-yet-processed paragraphs per run, only when
   * enabled in agent.memory.global.extraction. One batch at a time, never blocks a reply,
   * and any failure is logged and forgotten.
   */
  let extractionRunning = false
  function scheduleGraphExtraction(): void {
    const settings = (deps.getAppConfig() as any)?.agent?.memory?.global?.extraction
    if (settings?.enabled !== true || !deps.globalMemory || extractionRunning) return
    const timer = setTimeout(() => {
      void (async () => {
        if (extractionRunning) return
        extractionRunning = true
        try {
          const model = typeof settings.model === "string" && settings.model.trim() ? settings.model.trim() : undefined
          const llm = llmFor(model)
          if (!llm) return
          const batch = Math.min(10, Math.max(1, Math.floor(Number(settings.batch_size) || 3)))
          const result = await deps.globalMemory!.extractPending({
            limit: batch,
            complete: async (messages) => {
              const response = await llm.complete(messages as EngineMessage[], { maxCompletionTokens: 700, temperature: 0 })
              const text = response.choices?.[0]?.message?.content
              return typeof text === "string" ? text : ""
            },
          })
          if (result.processed || result.failed) deps.log?.("graph_extraction.batch", result as unknown as Json)
        } catch (error) {
          deps.log?.("graph_extraction.failed", { error: error instanceof Error ? error.message : String(error) } as Json)
        } finally {
          extractionRunning = false
        }
      })()
    }, 2_000)
    ;(timer as { unref?: () => void }).unref?.()
  }

  const lastUserContent = (history: EngineMessage[]): string => {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index]
      if (message.role === "user" && typeof message.content === "string") return message.content
    }
    return ""
  }

  const oneLine = (text: string, max: number): string => {
    const flat = String(text ?? "").replace(/\s+/g, " ").trim()
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat
  }

  /**
   * Durable writeback: memory is one system-wide store, not per chat session, so
   * the outcome of every tool-using run is logged there. A later session — or a
   * brand-new chat — can then find what was done and what is still open.
   */
  function recordRunToMemory(result: RunResult, source: string): void {
    if (!deps.fileMemory?.isEnabled() || source === "api-test" || result.status === "cancelled") return
    const used = result.toolCalls.filter((call) => call.status === "succeeded")
    if (used.length === 0) return
    const tools = [...new Set(used.map((call) => call.name))].slice(0, 8).join(", ")
    const label = result.status === "completed" ? "Completed task" : "Unfinished task (stopped early)"
    const outcome = oneLine(result.finalText || result.error || "", 500)
    deps.fileMemory.noteDaily(
      `${label}: ${oneLine(result.goal, 200)}\ntools: ${tools} (${used.length} calls)${outcome ? `\noutcome: ${outcome}` : ""}`,
      "run",
    )
  }

  // ---- run tracking (cancel, one run per session) -------------------------
  const runs = new Map<string, { controller: AbortController; sessionId?: string; startedAt: string; source: string }>()
  const sessionRuns = new Map<string, string>()
  // A session can host independent work streams (for example a background
  // autonomous task plus an interactive user question). Callers that do not
  // provide a lane keep the legacy one-run-per-session behavior.
  // Where each active run came from (channel, sender, chat/task). Read by contextProvider.
  const runOrigins = new Map<string, { source: string; peerId?: string; sessionId?: string; taskTitle?: string }>()
  const executionLanes = new Map<string, string>()

  const persistTerminalTask = (runId: string, result: RunResult): void => {
    const status = result.status === "completed"
      ? "completed"
      : result.status === "cancelled"
        ? "cancelled"
        : "failed"
    const reason = result.status === "completed"
      ? "agent run completed"
      : result.status === "cancelled"
        ? "agent run cancelled"
        : result.status === "limit_reached"
          ? "agent run reached an execution limit"
          : "agent run failed"
    try {
      const current = taskStore.get(runId)
      if (!current || current.status === "completed" || current.status === "failed" || current.status === "cancelled") return
      const options = {
        now: result.finishedAt,
        reason,
        ...(result.finalText ? { result: result.finalText } : {}),
        ...(result.error ? { error: result.error } : {}),
      }
      if (status === "completed" && current.status === "running") {
        taskStore.transition(runId, "verifying", { ...options, reason: "agent run finished; verifying terminal result" })
      }
      taskStore.transition(runId, status, options)
    } catch (error) {
      deps.log?.("run.task_persist_failed", { runId, error: error instanceof Error ? error.message : String(error) } as Json)
    }
  }

  function cancelRun(runId: string): boolean {
    const run = runs.get(runId)
    if (!run) return false
    run.controller.abort()
    return true
  }

  /** Deliver a user message to a run that is already working. False when no such run is active. */
  function steerRun(runId: string, text: string): boolean {
    return runs.has(runId) && engine.steer(runId, text)
  }

  async function startRun(input: {
    sessionId?: string
    history: EngineMessage[]
    model?: string
    allowTools?: boolean
    source: string
    /** Sender on that channel (Telegram user id, ...). Decides whether the shared memory applies. */
    peerId?: string
    /** Title of the chat/task, recorded with what is remembered. */
    taskTitle?: string
    runId?: string
    executionLaneId?: string
    goal?: string
    plan?: AgentPlan | false
    toolAllowlist?: string[]
    tools?: ToolRegistry
    approvalPolicy?: ToolApprovalPolicy
    onEvent?: (event: EngineEvent) => void
    signal?: AbortSignal
  }): Promise<RunResult> {
    const runId = input.runId ?? `run_${randomUUID()}`
    const runGoal = input.goal ?? lastUserContent(input.history)
    const laneId = input.executionLaneId ?? input.sessionId
    if (laneId && executionLanes.has(laneId))
      throw new Error("A run is already active for this execution lane.")
    const startedAt = now()
    const previousTask = taskStore.get(runId)
    // Chat retries intentionally reuse the visible run ID for stream
    // correlation. Durable task IDs must still be unique because a failed
    // first attempt is terminal and cannot be transitioned back to running.
    const durableTaskId = previousTask
      ? `${runId}:attempt:${randomUUID()}`
      : runId
    taskStore.create({ taskId: durableTaskId, goal: runGoal, sessionId: input.sessionId, now: startedAt })
    taskStore.transition(durableTaskId, "running", {
      now: startedAt,
      leaseMs: Math.max(5 * 60_000, resolveMaxWallTimeMs(((deps.getAppConfig() as any)?.agents?.defaults ?? {}) as Record<string, unknown>) || 0),
      reason: "agent runtime claimed run",
    })
    const controller = new AbortController()
    input.signal?.addEventListener("abort", () => controller.abort(), { once: true })
    runs.set(runId, { controller, sessionId: input.sessionId, startedAt, source: input.source })
    if (laneId) executionLanes.set(laneId, runId)
    if (input.sessionId && !input.executionLaneId) sessionRuns.set(input.sessionId, runId)
    runOrigins.set(runId, { source: input.source, peerId: input.peerId, sessionId: input.sessionId, taskTitle: input.taskTitle })
    try {
      getLifecycleBus().emit("message:received", {
        eventId: runId,
        session_key: input.sessionId,
        text: input.history.at(-1)?.content,
        surface: input.source,
      })
      let runTools = input.tools
      if (!runTools && input.toolAllowlist) {
        runTools = new ToolRegistry()
        for (const name of input.toolAllowlist) {
          const tool = registry.get(name)
          if (tool) runTools.register(tool)
        }
      }
      const result = await engine.run({
        runId,
        sessionId: input.sessionId,
        history: input.history,
        goal: input.goal,
        plan: input.plan,
        model: input.model,
        allowTools: input.allowTools,
        preActionUpdates: input.source === "webchat",
        tools: runTools,
        approvalPolicy: input.approvalPolicy,
        signal: controller.signal,
        onEvent: input.onEvent,
      })
      persistTerminalTask(durableTaskId, result)
      try {
        recordRunToMemory(result, input.source)
      } catch (error) {
        deps.log?.("run.memory_writeback_failed", { error: error instanceof Error ? error.message : String(error) } as Json)
      }
      try {
        deps.globalMemory?.recordTurn({
          source: input.source,
          peerId: input.peerId,
          sessionId: input.sessionId,
          taskTitle: input.taskTitle,
          userMessage: input.goal ?? lastUserContent(input.history),
          assistantMessage: result.finalText,
          status: result.status,
        })
        scheduleGraphExtraction()
      } catch (error) {
        deps.log?.("run.global_memory_failed", { error: error instanceof Error ? error.message : String(error) } as Json)
      }
      getLifecycleBus().emit("message:sent", {
        eventId: runId,
        session_key: input.sessionId,
        text: result.finalText,
        surface: input.source,
        status: result.status,
      })
      return result
    } catch (error) {
      try {
        taskStore.transition(durableTaskId, "failed", {
          now: now(),
          reason: "agent runtime threw before producing a result",
          error: error instanceof Error ? error.message : String(error),
        })
      } catch (persistError) {
        deps.log?.("run.task_persist_failed", { runId, error: persistError instanceof Error ? persistError.message : String(persistError) } as Json)
      }
      throw error
    } finally {
      runOrigins.delete(runId)
      runs.delete(runId)
      if (laneId && executionLanes.get(laneId) === runId) executionLanes.delete(laneId)
      if (input.sessionId && !input.executionLaneId && sessionRuns.get(input.sessionId) === runId) sessionRuns.delete(input.sessionId)
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
      if (run) return res.json({ id: req.params.id, status: "running", sessionId: run.sessionId, startedAt: run.startedAt })
      if (deps.externalRunActive?.(req.params.id)) return res.json({ id: req.params.id, status: "running" })
      return res.status(404).json({ error: "Task not found or already finished" })
    })
    app.delete("/api/tasks/:id", deps.requireAuth, (req, res) => {
      if (cancelRun(req.params.id) || deps.externalCancelRun?.(req.params.id)) return res.json({ status: "cancelling", id: req.params.id })
      return res.status(404).json({ error: "Task not found or already finished" })
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
            else if (event.type !== "message.final" && event.type !== "message.delta") events.push({ type: event.type })
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

  async function setToolState(name: string, enabled: boolean): Promise<Json> {
    const result = await controller.setToolState(name, enabled)
    return { ...result, status: enabled ? "enabled" : "disabled", name }
  }
  return { engine, control, approvals, registry, processes, llmFor, resolveCurrentModel, mount, startRun, steerRun, cancelRun, syncTools, setToolState, allToolNames: () => allTools.map((tool) => tool.name), describePlan, activeRunCount: () => runs.size }
}

export type AgentRuntime = ReturnType<typeof createAgentRuntime>

/** Map engine events onto the dashboard's WebSocket protocol. */
export function createWsEventMapper(
  send: (type: string, payload: Json) => void,
  model?: string,
  getToolFeedbackConfig: () => { enabled: boolean; separateMessages: boolean; maxArgsLength: number } = () => ({ enabled: true, separateMessages: false, maxArgsLength: 300 }),
  getMessagingConfig: () => Partial<AdaptiveMessagingConfig> = () => ({}),
  getAttachmentContext?: () => AttachmentContext,
  /** Called when a message written for the user mid-run (before the final answer) becomes permanent. */
  onInterimMessage?: (message: { id: string; content: string }) => void,
) {
  /** Proof files (screenshots, written files) gathered from this run's tool calls. */
  const attachmentCollector = getAttachmentContext ? createAttachmentCollector(getAttachmentContext) : undefined
  const attachmentsFor = (): ChatAttachmentPayload[] => attachmentCollector?.list() ?? []
  const toolMessageId = (callId: string) => `tool-${callId}`
  const created = new Set<string>()
  /** Id of the primary/final assistant message (finalIds holds the same single id). */
  let finalId: string = randomUUID()
  const finalIds: string[] = []
  /** Live message that is currently receiving streamed text, keyed by run. */
  const streamed = new Map<string, { id: string; turn: number; text: string }>()
  let thoughtSeq = 0
  let stateSeq = 0
  let toolFeedbackSeq = 0
  const toolFeedbackPayload = (call: { id: string; name: string; arguments?: string; status: string; error?: string }, runId: string) => {
    const cfg = getToolFeedbackConfig()
    if (!cfg.enabled) return
    const rawArgs = typeof call.arguments === "string" ? call.arguments : "{}"
    const max = Math.max(0, Math.floor(cfg.maxArgsLength || 0))
    const argumentsText = max > 0 && rawArgs.length > max ? `${rawArgs.slice(0, Math.max(0, max - 1))}…` : rawArgs
    const messageId = cfg.separateMessages
      ? `tool-${call.id}-${call.status}-${++toolFeedbackSeq}`
      : `tool-${call.id}`
    send(cfg.separateMessages || !created.has(messageId) ? "message.create" : "message.update", {
      message_id: messageId,
      content: `Tool ${call.name}: ${call.status}${call.error ? ` — ${call.error}` : ""}`,
      kind: "tool_calls",
      run_id: runId,
      tool_calls: [{
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: argumentsText },
        extra_content: { tool_feedback_explanation: call.error ? `${call.status}: ${call.error}` : call.status },
      }],
    })
    created.add(messageId)
  }
  const emitAdaptiveResponse = (runId: string, content: string, model?: string) => {
    const planned = planAdaptiveOutput(
      {
        id: `final-${runId}`,
        runId,
        channel: "web",
        kind: "response",
        content,
        final: true,
        longRunning: true,
        streamingRequested: false,
      },
      undefined,
      getMessagingConfig(),
    )
    finalIds.length = 0
    const proof = attachmentsFor()
    for (const [index, item] of planned.entries()) {
      const id = randomUUID()
      if (!finalId) finalId = id
      finalIds.push(id)
      send("message.create", {
        ...(proof.length > 0 && index === planned.length - 1 ? { attachments: proof } : {}),
        message_id: id,
        message_group_id: item.groupId,
        message_sequence: item.sequence,
        message_total: item.total,
        message_strategy: item.strategy,
        content: item.content,
        kind: "normal",
        run_id: runId,
        ...(model ? { model_name: model } : {}),
      })
    }
    if (finalIds[0]) finalId = finalIds[0]
  }

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
      case "plan.updated":
        send("message.create", {
          message_id: `plan-update-${event.plan.id}-${Date.now()}`,
          content: describePlan(event.plan),
          kind: "thought",
          thought_category: "Plan",
          run_id: runId,
        })
        break
      case "message.delta": {
        if (!event.delta) break
        let live = streamed.get(runId)
        if (!live || live.turn !== event.turn) {
          live = { id: randomUUID(), turn: event.turn, text: "" }
          streamed.set(runId, live)
        }
        live.text += event.delta
        send("message.delta", { message_id: live.id, delta: event.delta, run_id: runId, ...(model ? { model_name: model } : {}) })
        break
      }
      case "thought": {
        const live = streamed.get(runId)
        const liveThisTurn = live && live.turn === event.turn ? live : undefined
        const text = event.content.trim()
        if (event.interim && text) {
          // The model wrote this for the user while it kept working (or before it took up a new user
          // message): it stays as its own message. It is never merged with the final answer.
          let id = liveThisTurn?.id
          if (id) {
            send("message.update", { message_id: id, content: text, kind: "normal", run_id: runId, ...(model ? { model_name: model } : {}) })
          } else {
            id = randomUUID()
            send("message.create", { message_id: id, content: text, kind: "normal", run_id: runId, ...(model ? { model_name: model } : {}) })
          }
          streamed.delete(runId)
          onInterimMessage?.({ id, content: text })
          break
        }
        // A discarded draft (e.g. rejected by the self-check): retract what streamed. Raw
        // chain-of-thought is intentionally not sent to clients, and no placeholder text is sent.
        if (liveThisTurn) {
          send("message.delete", { message_id: liveThisTurn.id, run_id: runId })
          streamed.delete(runId)
        }
        break
      }
      case "tool.call":
        toolFeedbackPayload(event.call, runId)
        attachmentCollector?.observe(event.call)
        break
      case "message.final": {
        const live = streamed.get(runId)
        streamed.delete(runId)
        if (live && live.text.trim()) {
          // The answer already streamed into one live message: finalize it in place. It is never split.
          finalId = live.id
          finalIds.length = 0
          finalIds.push(live.id)
          const proof = attachmentsFor()
          send("message.update", { message_id: live.id, content: event.content, kind: "normal", run_id: runId, ...(proof.length > 0 ? { attachments: proof } : {}), ...(model ? { model_name: model } : {}) })
          break
        }
        emitAdaptiveResponse(runId, event.content, model)
        break
      }
      case "run.finished":
        send("typing.stop", { run_id: runId })
        send("node.run_end", {
          run_id: runId,
          status: event.status === "completed" ? "completed" : event.status === "cancelled" ? "cancelled" : event.status === "limit_reached" ? "completed_with_warning" : "failed",
          ...(event.error ? { error: event.error } : {}),
        })
        break
      default:
        break
    }
  }
  return { handle, finalId, finalIds, attachments: attachmentsFor }
}
