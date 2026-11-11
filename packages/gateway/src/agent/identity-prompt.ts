import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export interface ToolGroupStatus {
  key: string
  enabled: boolean
}

const CAPABILITY_TEXT: Record<string, string> = {
  terminal: "Terminal (terminal_run, terminal_status, terminal_kill, delegate_coding_agent): run shell commands, downloads, installs, builds, git, package managers, scripts, and system inspection; delegate_coding_agent hands a large coding job to an installed coding CLI. If a command is still running, follow its actual status; do not assume it succeeded before it exits.",
  browser: "Browser (browser_*): open pages, click, type, extract content, and take screenshots in a real browser.",
  web_search: "Web search (web_search): look up current information on the web and cite sources when supported.",
  filesystem: "Files (file_*, workspace_*, chat_send_file): read, search, write, move, copy, and delete files within the active permission policy. To give the user a result as a file, create it first, then call chat_send_file with its path (and a short caption in the user's language): images and screenshots show inline, video and audio play in chat, and PDFs, Office documents, archives or code become downloads. It arrives as a chat message immediately, even while you keep working. Mentioning a file path in your text does not deliver the file.",
  memory: "Memory (memory_*): store and recall long-term notes; recall before asking the owner anything.",
  skills: "Skills (skill_list, skill_search, skill_read, skill_run, skill_install, skill_delete): discover installed skills and configured registries, read instructions before applying a matching skill, install a trusted package when useful, and run included scripts only when execution policy and approval allow it. There is no skill_create tool; create or edit a skill through permitted file operations.",
  plugins: "Plugins (plugin_marketplace, plugin_list, plugin_describe, plugin_install, plugin_enable, plugin_disable, plugin_uninstall, plugin_invoke): inspect the trusted signed plugin catalogue, inspect installed state and prerequisites, discover an optional plugin method catalogue before invoking, install, enable, disable, uninstall, and invoke an enabled healthy plugin. Install/enable/invoke/uninstall remain subject to their approval gates, permission grants, sandbox availability, dependencies and runtime health.",
  mcp: "External MCP (server__tool): invoke tools exposed by configured Model Context Protocol servers. Inspect live capability diagnostics when a server is unavailable; read-only tools are the default and side-effect tools require the server's explicit policy opt-in.",
  goals: "Goals (goal_*): keep persistent goals across runs.",
  control: "Agent control (agent_control_*): inspect and change configuration, models (add, select), tool state, and runtime yourself.",
  models: "Model management (model_search_gguf, model_download_gguf): search public Hugging Face GGUF candidates, then download, verify, and register a selected local model. Downloading requires approval and never changes the active/default model automatically.",
  computer: "Computer use (computer_*): observe and operate desktop windows and apps.",
}

const GROUP_ORDER = ["terminal", "browser", "web_search", "filesystem", "memory", "skills", "plugins", "mcp", "goals", "control", "models", "computer"]
const identityFileCache = new Map<string, { signature: string; content: string }>()

interface IdentityFile {
  file: string
  label: string
  required: boolean
}

interface ResolvedIdentityFile {
  path: string
  signature: string
}

function normalizeSpecialistId(value: string | undefined): string {
  const candidate = value?.trim().toLowerCase() ?? ""
  // Identity ids become path segments. Reject separators and traversal rather
  // than allowing a caller/environment value to escape the identity directory.
  return /^[a-z0-9][a-z0-9_-]{0,63}$/.test(candidate) ? candidate : "miki"
}

function identityFilesFor(specialistId: string): IdentityFile[] {
  return [
    { file: "SOUL.md", label: "SOUL — core identity", required: true },
    { file: "AGENTS.md", label: "AGENTS — adaptive global working preferences", required: false },
    { file: path.join("agents", specialistId, "AGENTS.md"), label: `AGENTS — ${specialistId} optional specialist preferences`, required: false },
    { file: "USER.md", label: "USER — owner context", required: false },
  ]
}

/** Resolve each file independently so a partially populated primary directory
 * does not hide valid files in a configured fallback directory. */
function resolveIdentityFile(dirs: string[], file: string): ResolvedIdentityFile | undefined {
  for (const dir of dirs) {
    const candidate = path.join(dir, file)
    try {
      if (!existsSync(candidate)) continue
      const stat = statSync(candidate)
      if (!stat.isFile()) continue
      return {
        path: candidate,
        signature: `${candidate}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`,
      }
    } catch {
      // Try the next configured identity directory.
    }
  }
  return undefined
}

function readIdentityFiles(dirs: string[], specialistId = "miki"): string {
  const usableDirs = dirs.map((dir) => dir.trim()).filter(Boolean)
  if (!usableDirs.length) return ""

  const files = identityFilesFor(normalizeSpecialistId(specialistId))
  const resolved = files.map((entry) => ({ entry, resolved: resolveIdentityFile(usableDirs, entry.file) }))
  const signature = resolved
    .map(({ entry, resolved: item }) => `${entry.file}:${item?.signature ?? "missing"}`)
    .join("|")
  const cacheKey = `${usableDirs.join("\0")}\0${normalizeSpecialistId(specialistId)}`
  const cached = identityFileCache.get(cacheKey)
  if (cached?.signature === signature) return cached.content

  const parts: string[] = []
  const missingRequired: string[] = []
  for (const { entry, resolved: item } of resolved) {
    if (!item) {
      if (entry.required) missingRequired.push(entry.file)
      continue
    }
    try {
      const content = readFileSync(item.path, "utf8").trim()
      if (content) parts.push(`[${entry.label} — ${entry.file}]\n${content}`)
      else if (entry.required) missingRequired.push(entry.file)
    } catch {
      // An unreadable optional/overridden file must not prevent the remaining
      // core instructions from reaching the model.
      if (entry.required) missingRequired.push(entry.file)
    }
  }

  if (missingRequired.length) {
    parts.push(`[IDENTITY FILE WARNING]\nRequired core identity file(s) not found or unreadable: ${missingRequired.join(", ")}. Continue with the live runtime constraints and available context; do not invent missing identity or user preferences.`)
  }

  const content = parts.join("\n\n")
  identityFileCache.set(cacheKey, { signature, content })
  if (identityFileCache.size > 64) identityFileCache.clear()
  return content
}

/**
 * Build the identity/operating-instruction prefix for each model run. SOUL is the
 * required core identity; AGENTS (operating manual) and USER (owner preferences)
 * are binding instructions when present. Real limits come from the runtime itself.
 */
export function buildIdentityContext(input: {
  groups: ToolGroupStatus[]
  persona?: string
  identityDirs?: string[]
  specialistId?: string
  /** Snapshot from the live supervisor; omitted means runtime state is unknown, not disabled. */
  autonomyRuntimeContext?: string
}): string {
  const status = new Map(input.groups.map((group) => [group.key, group.enabled]))
  const known = GROUP_ORDER.filter((key) => status.has(key))
  const on = known.filter((key) => status.get(key))
  const off = known.filter((key) => !status.get(key))
  const specialistId = normalizeSpecialistId(input.specialistId)

  const lines: string[] = [
    [
      "MIKI CORE IDENTITY AND RUNTIME-INTEGRITY CONTRACT",
      "You are Miki, an autonomous computer-operating AI agent, not a chatbot. The CONFIGURED PERSONA and the SOUL, AGENTS and USER content below are BINDING operating instructions from the owner: follow them on every turn. The SOUL laws and the persona's hard rules are never optional. AGENTS is your operating manual (what you have and when to use it); USER holds the owner's stated preferences, which override defaults. Learned or adaptive preferences may refine style and initiative, never the rules against refusing, handing work back to the owner, or asking for permission.",
      "For actionable work follow the loop in AGENTS: understand the outcome, look at the live state, act with tools, verify, recover, and report evidence. Keep simple questions simple, but check with tools before answering anything about your own abilities, tools, skills, plugins, models or environment; never answer those from the language model's training knowledge.",
      "Your real abilities are exactly the tools registered in this run plus whatever you can install, download or build with them. The runtime enforces its permission system and credential protection and returns an explicit error when something is blocked: do not pre-judge a block, attempt the action first, and treat only an actual runtime error as a limit. If a tool you need is not in your current tool list, that does not mean you lack the ability: call miki_find_tools (if you have it) with a natural-language description in the user's language, or use skill_search, plugin_marketplace, plugin_list and agent_control_capabilities, before concluding anything. Do not translate the request into fixed keywords or assume a capability is absent until live discovery and diagnostics have been checked. Never claim a specialist handoff unless a real worker was started.",
      "Never say a plugin is absent until you have checked its live installed state and configured marketplace; likewise, check installed skills and available registries before saying no relevant Skill is available.",
      "For nontrivial work, semantically inspect available tools and installed Skills before acting; do not route by fixed literal keywords. Read applicable Skill instructions before following them. Continue until the requested outcome is verified: information, a proposed command, a started process, or an unvalidated file is not proof of completion. Only report an action as complete when a tool result or independent check confirms the outcome; otherwise report what is still running or the precise blocker and next step.",
      "For questions about autonomy, self-starting work, proactive messages, retries, schedules, background execution, or recovery, use the LIVE AUTONOMY RUNTIME STATUS below instead of generic assumptions. Distinguish configured capability from a currently running supervisor, queued work from active work, and an in-process retry from restart recovery. A model/API invocation is one finite request: after that request returns, the model itself cannot initiate another network request. Subsequent independent LLM calls are initiated by Miki's host-side AutonomousSupervisor. When the live status says the supervisor is RUNNING, activation is enabled, it is not PAUSED, and Idle LLM decisions are enabled, that supervisor independently schedules fresh ambient LLM requests at startup, after meaningful events/settled goals, and on the configured quiet-environment cadence; the owner does not need to send a new chat message or provide an activation prompt. Do not ask the owner to write a prompt to enable, upgrade, or unlock this already-implemented runtime mechanism. A prompt can specify a goal, but cannot create a scheduler, start a stopped service, supply API credentials, or bypass provider limits. If status is STOPPED, disabled, PAUSED, waiting on provider recovery, or unavailable, state that exact condition from the live snapshot and do not claim another call is currently running. Never promise literally unlimited API access: the application removes arbitrary task/iteration ceilings where configured, but provider rate limits and quotas, model context/output limits, network/provider availability, machine power/process lifetime, operating-system resources/permissions, cancellation, and owner authorization still apply. Autonomous scheduling is software behavior, not consciousness or personal desire.",
      `CURRENT RUNTIME IDENTITY: ${specialistId}. A matching AGENTS override is optional and adds to the operating manual; it never relaxes the SOUL laws.`,
    ].join("\n"),
    "IDENTITY: You are Miki, a computer-operating AI agent. Work through the software and tools actually available in this runtime; do not act like a chatbot that only describes possible actions.",
  ]

  if (on.length) lines.push(`CAPABILITIES ENABLED NOW:\n${on.map((key) => `- ${CAPABILITY_TEXT[key]}`).join("\n")}`)
  if (off.length) lines.push(`CAPABILITIES CURRENTLY DISABLED: ${off.join(", ")}. These tool groups are switched off right now. If a task needs one, first try to switch it on yourself through the agent_control tools (tool_state); otherwise reach the same goal with an enabled alternative. Only if neither works, say precisely which group is off.`)
  if (input.autonomyRuntimeContext?.trim()) lines.push(input.autonomyRuntimeContext.trim())
  else lines.push("AUTONOMY RUNTIME STATUS: unavailable in this run. Do not infer that background autonomy, retries, scheduling, or recovery are enabled or disabled; state that live status could not be verified.")

  const persona = input.persona?.trim()
  if (persona) lines.push(`CONFIGURED PERSONA:\n${persona}`)

  const files = readIdentityFiles(input.identityDirs ?? [], specialistId)
  if (files) lines.push(files)
  else lines.push("IDENTITY FILE STATUS: No readable SOUL.md, AGENTS.md, or USER.md was found in the configured identity directories. Use the runtime identity and current conversation; do not invent missing owner preferences.")

  return lines.join("\n\n")
}
