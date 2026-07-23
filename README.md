![Hiro](docs/theme.png)

# Hiro

Hiro is a local-first assistant runtime for developers who want
an inspectable, configurable, and recoverable workspace agent. It is built as
an integrated local stack that runs from a single repository and provides the
following runtime components:

- A command-line launcher that starts the local runtime.
- A gateway that serves the dashboard and proxies API, WebSocket, webhook, and
  MCP traffic.
- A core TypeScript API that manages chat sessions, memory, tools, skills,
  channels, and safety.
- A React dashboard for operating the agent, configuring models and channels,
  inspecting health, and browsing runtime data.
- An installer and a bundled skills catalog for extensible tool and skill loading.

This project is intentionally local-first: network-facing features are only
enabled when configured, external channels require explicit credentials, and
runtime behavior is designed to be visible and recoverable rather than hidden.

## Documentation

- [Detailed Documentation](Documentation.md)
- [Feature Notes](feature.md)
- [Release Checklist](RELEASE_CHECKLIST.md)
- [Troubleshooting Matrix](TROUBLESHOOTING_MATRIX.md)

> Archived markdown files have been moved to `docs/trash` to keep the docs folder small and focused.

## Project Overview

> **Project**: `@hiro` — Version `1.0.0` — License MIT
> **Author**: Glayph — **Timezone**: Galaxy/Earth
> **Runtime**: Node.js `^20.19.0 | ^22.13.0 | >=24` — **Package Manager**: `pnpm@10.33.0`
> **Build System**: Turborepo — **Language Stack**: TypeScript (core) + Go (UI backend + CLI) + React/Vite (frontend)

**Hiro** is a production-grade, multi-agent, autonomous AI system that can take full control of a computer. The agent, named **Miki**, can autonomously control file systems, applications, browsers, desktops, shells, and messaging platforms.

It is a **Monorepo** with 8 packages, each responsible for a distinct layer of the runtime.

## Monorepo Structure

```
miki/
├── packages/
│   ├── core/          ← Agent engine (TypeScript) — the brain
│   ├── gateway/       ← Process orchestrator + LiteLLM manager (TypeScript)
│   ├── memory/        ← Vector + Graph memory system (JavaScript)
│   ├── skills/        ← Built-in skill library (TypeScript)
│   ├── config/        ← Shared config, secrets, validation (TypeScript)
│   ├── installer/     ← Skill/plugin installer engine (TypeScript)
│   ├── ui/
│   │   ├── frontend/  ← React + Vite Web UI (TypeScript/TSX)
│   │   └── backend/   ← Go HTTP server (legacy + stub)
│   └── cli/           ← Go TUI terminal launcher (mikiagent-cli)
├── config/
│   ├── agent.yaml     ← Agent personality, specialists, channels config
│   ├── litellm.yaml   ← LiteLLM proxy config
│   └── tools.yaml     ← Tool definitions
├── scripts/           ← Build automation (16 .mjs scripts)
├── bin/               ← CLI entry point (Hiro.js / Agent.js)
├── src/skills/        ← Workspace-level skill definitions
└── data/              ← Runtime data, SQLite databases, logs
```

## What This Project Provides

Hiro is not just a chat application. It is a full local agent
runtime with separate operational layers:

- `bin/Hiro.js` and `packages/Hiro-cli`: startup, process supervision,
  runtime bootstrapping, and developer CLI entry points.
- `packages/gateway`: Express gateway, static dashboard serving, HTTP
  proxying, webhook relays, WebSocket routes, LiteLLM supervision, and MCP proxy.
- `packages/core`: core agent API, memory storage, tools, skills,
  models, channel adapters, goals, jobs, and safety checks.
- `packages/Hiro-memory`: GraphRAG memory system with temporal knowledge
  graph, intelligent chunking, hybrid vector-BM25 search, and data optimization.
- `packages/ui`: React dashboard UI plus a Go compatibility backend
  for local packaged runtime support.
- `packages/config`: config schema, validation, CORS, and secret helpers.
- `packages/installer`: skill installation, source adapters, and
  bundled skill registry.
- `packages/skills`: included skills and sample bundles.

Each layer is intentionally decoupled so the launcher, gateway, core, and UI can
be inspected independently, and the same local stack can be packaged or run from
source with consistent behavior.

## Package Deep Analysis

### `packages/core` — Agent Engine

This is the **heart** of the project. 76+ TypeScript files, ~220,000+ LOC.

#### Core Orchestrator — `agent.ts` (1,993 lines)

`AgentOrchestrator` class is the central hub that integrates all subsystems:

| Subsystem | Class/Module | Purpose |
|---|---|---|
| Tool Registry | `ToolRegistry` | Manages all tools |
| Heartbeat | `HeartbeatEngine` | Periodic background actions |
| Self Improvement | `SelfImprovementEngine` | Reflection + optimization |
| Skill Governance | `SkillGovernanceEngine` | Skill validation + safety |
| Task Queue | `TaskQueue` + `ConcurrentTaskManager` | Async task management |
| Scheduler | `TaskScheduler` | Cron + one-shot tasks |
| Cost Calibrator | `CostCalibrator` | LLM cost optimization |
| Token Budget | `buildAgentTokenBudget()` | Context window management |
| Agent Registry | `AgentRegistry` | Multi-agent instance tracking |
| Message Bus | `globalAgentMessageBus` | Agent-to-agent communication |
| Blackboard | `globalAgentBlackboard` | Shared state between agents |
| Delegator | `AgentDelegator` | Task delegation to specialists |
| Planner | `globalAgentPlanner` | Multi-step goal planning |
| Aggregator | `globalAgentAggregator` | Result aggregation |

**Core constants:**
- `MAX_AGENT_TURNS = 50` — maximum turns per session
- `MAX_AGENT_TURNS_NO_OUTPUT = 12` — maximum silent turns without output
- `DEFAULT_MESSAGE_HISTORY_LIMIT = 15` — message history limit

#### Agent Run Strategy — `agent-run.ts` (1,154 lines)

Manages the lifecycle of each task execution:

```
AgentRun
├── id, objective, status, createdAt, updatedAt
├── TaskGraphStep[]  ← dependency-based execution graph
│   ├── id, title, dependsOn[], phase (planner|executor|verifier)
│   ├── status: pending|running|completed|failed|skipped
│   └── evidence: VerificationEvidence[]
│       ├── kind: command|file|api|manual|metric
│       └── source: planner|executor|verifier|model|tool|test|build|smoke
└── VerificationEvidence — collects evidence to verify results
```

**Run Phases:**
1. **Planner Phase** — decomposes goals into steps
2. **Executor Phase** — executes steps
3. **Verifier Phase** — verifies results and collects evidence

#### Agent Router — `agent-router.ts` (577 lines)

Analyzes tasks and routes them to the correct specialist agent.

**Built-in Specialists:**
| ID | Name | Priority | Specialty |
|---|---|---|---|
| `Master` | Miki (General) | 10 | Everything — coordination, code, research, planning |
| `engineer` | Software Engineer | 8 | Code, debug, test, refactor |
| `planner` | Workflow Planner | 6 | Architecture, roadmap, complex workflows |
| `researcher` | Research Analyst | 4 | Web research, comparison, audit |
| `general` | General Coordinator | 0 | Simple coordination |

#### Multi-Agent System

```
agent-registry.ts      → AgentInstance tracking (id, type, status, sessionId)
agent-message-bus.ts   → Publish/Subscribe messaging between agents
agent-blackboard.ts    → Shared read/write state (key-value store)
agent-delegator.ts     → Task delegation to specialist instances
agent-aggregator.ts    → Parallel result collection + merging
agent-planner.ts       → Goal decomposition with backtracking
agent-tot.ts           → Tree-of-Thought reasoning strategy
```

#### Tool System — `tools/`

| File | Description | Size |
|---|---|---|
| `computer.ts` | Full desktop/OS control (keyboard, mouse, screen) | 37KB |
| `project-workflow.ts` | End-to-end project creation (1,692 lines) | 51KB |
| `browser.ts` | Playwright-powered web automation | 25KB |
| `crawler.ts` | Web crawler + content extraction | 8KB |
| `dependency-resolver.ts` | Tool dependency graph resolution | 7KB |
| `resource-pool.ts` | Tool resource pooling | 5KB |
| `retry-manager.ts` | Tool retry with exponential backoff | 6KB |
| `tool-warmer.ts` | Pre-warming tools for faster execution | 5KB |
| `profile-manager.ts` | Per-tool execution profiles | 4KB |

**`executor/`** — shell command execution:
- `shell.ts` — secure shell command runner
- `file-security.ts` — path traversal prevention
- `security.test.ts` — security test suite

**`registry/`** — tool registration + discovery system

#### Tool Parallelism — `tool-call-parallelism.ts` (651 lines)

Sophisticated system for running multiple tools in parallel:

```
ToolExecutionPlan
└── levels[]
    └── ToolExecutionLevel
        ├── parallel: boolean
        └── items: PlannedToolInvocation[]
            └── policy: ToolConcurrencyPolicy
                ├── locks: ToolResourceLock[] (shared|exclusive)
                ├── retry: ToolRetryPolicy
                └── timeoutMs
```

Config: `maxParallelToolCalls = 8`, `toolLockTimeoutMs = 30,000ms`

#### Memory & Context Management

```
token-budget-manager.ts  → Task complexity → token allocation
                           (simple|standard|complex) × model cost optimization
contextual-tool-pruner.ts → Context-aware tool list pruning
cache-manager.ts          → LRU cache for tool results
llm-cache.ts             → LLM response caching
request-deduplicator.ts  → Duplicate request prevention
stream-predictor.ts      → Streaming response optimization
workflow-accelerator.ts  → Decision pattern acceleration
```

#### Quality & Monitoring

```
quality-evaluator.ts     → Response quality scoring
agent-confidence.ts      → Confidence scoring per decision
metrics-collector.ts     → Performance metrics (latency, tokens, cost)
execution-tracer.ts      → Full execution trace logging
audit-log.ts             → Tamper-evident audit trail (SQLite)
structured-logger.ts     → JSON structured logging
performance-budgets.ts   → Performance budget enforcement
```

#### Safety System — `safety/`

| File | Purpose |
|---|---|
| `doctor.ts` | System health diagnosis (9,252 bytes) |
| `backup.ts` | Automated backup engine (11,773 bytes) |
| `migrations.ts` | Database migration manager |
| `safe-mode.ts` | Restricted operation mode |
| `secret-scan.ts` | Secret/credential leak detection |
| `watchdog.ts` | Process watchdog |
| `startup.ts` | Safe startup validation |
| `full-health.ts` | Full system health check |

#### MCP (Model Context Protocol) — `mcp/`

| File | Purpose |
|---|---|
| `server.ts` | MCP server (11,962 bytes) |
| `connectors.ts` | MCP connector management |
| `discovery.ts` | MCP server auto-discovery |
| `core-client.ts` | MCP client implementation |
| `resources.ts` | MCP resource handlers |
| `prompts.ts` | MCP prompt templates |
| `session-manager.ts` | MCP session lifecycle |
| `permissions/` | Fine-grained MCP tool permissions |

#### Heartbeat Engine — `heartbeat.ts` (272 lines)

Runs background cycles every `30 seconds`:
- Self-improvement reflection check
- Prompt tuning check
- Optimization cycle check
- Resource cleanup (stale profiles, task queue)
- Cost calibration update

#### Skill System — `skill-loader.ts`, `skill-search.ts`, `skill-api.ts`

```
SkillLoader          → YAML-based skill discovery + loading
SkillSearchEngine    → Semantic skill search (keyword + vector)
skill-api.ts         → REST API (~20 routes): list, get, install, execute, probe
SkillGovernanceEngine → Skill validation + safety rules
```

#### REST API — `api/`

`api/index.ts` (57,176 bytes) — complete API server:

| Router | Purpose |
|---|---|
| `launcher-compat.ts` (6,089 lines) | Main compatibility layer — session, config, models |
| `file-manager-router.ts` (41,455 bytes) | Full file system operations |
| `enhancement-router.ts` (20,270 bytes) | AI enhancement endpoints |
| `channel-runtime-probe.ts` (17,991 bytes) | Channel health probing |
| `session-router.ts` | Session management |
| `auth-middleware.ts` | JWT/token auth |
| `provider-management.ts` | LLM provider CRUD |
| `system-monitoring.ts` | System stats endpoint |
| `mcp-server.ts` | MCP server endpoint |

#### Plugin System — `plugins/`

```
plugin-channel-adapter.ts       → Channel plugin runtime integration (11KB)
plugin-channel-runtime.ts       → Channel plugin lifecycle (21KB)
plugin-contract-runtime.ts      → Plugin contract enforcement (31KB)
plugin-marketplace-readiness.ts → Marketplace compatibility check (20KB)
plugin-provider-adapter.ts      → LLM provider plugin adapter (9KB)
plugin-tool-registration.ts     → Dynamic tool registration from plugins (5KB)
```

Plugin contract kinds: `tools` | `channels` | `skills` | `providers` | `hooks`

#### System Index — `system-index/`

```
indexer.ts       → File system + code indexer (12,698 bytes)
database.ts      → SQLite-backed index storage (7,406 bytes)
extractors.ts    → Content extractor (code, docs, configs)
agent-context.ts → Per-session context builder
types.ts         → Index data types
```

### `packages/gateway` — Process Orchestrator

The **Gateway** is the system's **front door** — it receives all requests on port `18800`.

#### Architecture:
```
Client Request (port 18800)
       │
  [Gateway - Express.js]
       │
   ┌───┴────────────────────────────────┐
   │                                    │
[Core Process]                   [LiteLLM Proxy]
 port 8000                         port 4000
 (Node.js child)                   (Python process)
       │
  [WebSocket Relay]
  (real-time streaming)
```

#### Key Files:
| File | Description |
|---|---|
| `index.ts` (829 lines) | Main gateway server, process manager, CORS, health |
| `litellm-manager.ts` | LiteLLM Python process lifecycle |
| `websocket-relay.ts` | WebSocket bi-directional relay |
| `shutdown.ts` | Graceful shutdown handler |

#### Gateway Responsibilities:
- Core process **spawn + restart** (max 5 restarts)
- LiteLLM **Python process** management
- **CORS** enforcement (allowed origins from env)
- **CIDR-based** IP allowlisting
- **WebSocket relay** for real-time streaming
- Health check forwarding (`/health`)
- MCP proxy (`/mcp/*`)
- Payload size limiting (5MB max)
- Startup timeout: 60 seconds

### `packages/memory` — Memory System

Node.js-based memory engine with **6 core components**:

```
memory/src/core/
├── memory-manager.js   → Unified memory API (18,892 bytes)
│   ├── short_term_limit: 20 messages
│   ├── long_term_enabled: true
│   ├── personality_enabled: true
│   └── procedural_enabled: true
│
├── vector-index.js     → Semantic similarity search (14,519 bytes)
│   └── vector_search_threshold: 0.5
│
├── graph-store.js      → Knowledge graph storage (22,090 bytes)
│   └── NodeGraphRAG-based relationships
│
├── chunk-engine.js     → Text chunking + embedding (14,162 bytes)
│
├── temporal-engine.js  → Time-aware memory decay (16,816 bytes)
│   ├── message_retention_days: null (unlimited)
│   ├── consolidation_batch_size: 5
│   └── consolidation_debounce_ms: 60,000
│
└── optimizer.js        → Memory optimization + pruning (12,084 bytes)
    ├── prune_low_value_facts: true
    ├── fact_prune_threshold: 0.15
    └── fact_prune_min_age_days: 30
```

**Memory Types:**
- `short_term` — recent conversation context
- `long_term` — persistent facts + knowledge
- `personality` — user preferences + behavioral patterns
- `procedural` — learned workflows + procedures

**API Layer:**
- `memory/src/api/` — REST API for memory CRUD
- `memory/src/cli.js` — CLI interface
- `memory/src/nodegraphrag.js` — Graph RAG integration

### `packages/skills` — Built-in Skill Library

Skills are pre-packaged workflows that the Agent can execute directly.

```
skills/src/
├── software-development/  → Code writing, debugging, PR creation
├── research/              → Web research, fact checking, summarization
├── github/                → GitHub PR, issues, repo management
├── social-media/          → Social media automation
├── ai-collaboration/      → Multi-AI coordination
├── goal-completion/       → Long-running goal pursuit
└── find-skills/           → Dynamic skill discovery
```

Each skill is a YAML/JSON definition containing:
- `name`, `description`, `version`
- `triggers` (when to activate)
- `steps` (what actions to take)
- `tools_required` (which tools are needed)

### `packages/config` — Shared Configuration

Shared configuration, secrets management and validation across all packages:

- **`settings`** — Runtime configuration singleton
- **`ChatMessage`**, **`ToolDefinition`**, **`LLMResponse`** — Core types
- **`validateRuntimeConfig()`** — Config validation
- **Secret Vault** — Encrypted credential storage
- **`redactSecrets()`** — Log sanitization
- **Security helpers** — CORS origins, CIDR validation, LiteLLM key resolution

### `packages/installer` — Plugin & Skill Installer

```
installer/src/
├── source-dispatch.ts    → Unified source dispatcher (8,606 bytes)
│   ├── git source         → Git repository install
│   ├── npm source         → NPM package install
│   ├── local source       → Local directory install
│   └── clawhub source     → Custom registry install
├── installer/
│   └── skill-installer.ts → Skill installation engine (8,108 bytes)
├── registry/              → Installed package registry
├── utils/                 → Helper utilities
└── types.ts               → Plugin contract types
    └── PluginContractKind: tools|channels|skills|providers|hooks
```

### `packages/ui` — User Interface

#### Frontend (React + Vite + TypeScript)

**Technology Stack:**
- React 19 + TanStack Router
- Vite build system
- shadcn/ui components
- i18n internationalization
- Zustand state management

**Routes:**
| Route | Purpose |
|---|---|
| `/` | Home dashboard |
| `/agent` | Main chat interface |
| `/agents` | Multi-agent management |
| `/agents/:id` | Specific agent view |
| `/agents/swarm` | Swarm mode |
| `/channels` | Channel configuration |
| `/config` | Agent configuration |
| `/credentials` | API key management |
| `/drive` | File manager |
| `/health` | System health |
| `/logs` | Log viewer |
| `/models` | LLM model management |
| `/launcher-login` | Authentication |
| `/launcher-setup` | Initial setup wizard |

**Components:**
- `app-sidebar.tsx` — Navigation sidebar
- `app-command-palette.tsx` — Command palette (Ctrl+K)
- `global-header-actions.tsx` — Header actions (10,823 bytes)
- `app-background.tsx` — Animated background
- `shared-form.tsx` — Reusable form components
- `resizable-sidebar-splitter.tsx` — Resizable panels

#### Backend (Go)

```
ui/backend/
├── main.go (708 lines)    → Legacy Go HTTP server (build tag: legacy_backend)
│   └── miki Web Console — WebSocket chat + config management
├── stub_main.go           → Minimal stub (no external deps)
├── systray.go             → System tray icon support
├── i18n.go                → Internationalization
├── embed.go               → Frontend embedding
├── api/                   → API route handlers
├── dashboardauth/         → Dashboard authentication
├── launcherconfig/        → Launcher config management
├── middleware/            → HTTP middleware
└── model/                 → Data models
```

> Legacy Go backend requires external `miki` pkg deps. Normally, `stub_main.go` compiles without them.

### `packages/cli` — Go TUI Launcher

Terminal-based launcher written in Go (`mikiagent-cli`, 20MB compiled):

```
cli/
├── main.go          → Entry point (553 bytes)
├── tui.go           → Terminal UI (Bubble Tea) — 11,272 bytes
├── runtime.go       → Runtime management — 8,090 bytes
├── config.go        → Config management — 4,454 bytes
├── styles.go        → TUI styles + colors — 2,342 bytes
├── help.go          → Help system — 982 bytes
├── logbuffer.go     → Log buffering — 1,005 bytes
├── plain.go         → Plain text output mode
├── process_unix.go    → Unix/Linux process management
```

**Functions:**
- Launches the Hiro process
- Real-time log streaming
- Health status display
- Process restart management

## How It Works

1. The launcher starts the runtime.
   - `npm start` runs the gateway directly, which supervises the core API and
     the LiteLLM process.
   - `npm run dev` runs `bin/Hiro.js`, which additionally starts the Go CLI
     and the GraphRAG memory server.
2. The gateway serves the dashboard and proxies requests.
   - Dashboard UI requests are served from the built React app.
   - API calls under `/api/*` are forwarded to the core.
   - WebSocket chat routes and MCP traffic are proxied cleanly through the
     gateway.
   - Webhook routes are mounted for supported external channels.
3. The core manages state and agent behavior.
   - Session history, chat messages, facts, goals, tasks, and model records are
     persisted in SQLite.
   - Tools are registered and executed through a policy-aware tool registry.
   - Skills can be loaded, installed, inspected, and removed.
   - Channel events are normalized and forwarded into the agent response loop.
4. Agent responses are collected and emitted.
   - Chat input may arrive from the dashboard or channel adapters.
   - The runtime constructs prompts, calls the configured model provider, and
     returns structured assistant output.
   - Tool calls, channel replies, and session updates are persisted so the
     runtime can recover state after restart.

### Startup Flow

```
bin/Hiro.js (Entry Point)
       │
       ▼
[CLI Go Launcher] ──→ mikiagent-cli
       │
       ▼
packages/gateway/dist/index.js  (Gateway Server — port 18800)
       │
   ┌───┴──────────────────────────────────────────┐
   │                                              │
[Core Process spawn]                    [LiteLLM spawn]
packages/core/dist/api/index.js          (Python, port 4000)
 (port 8000)
       │
   ┌───┴──────────────────────────────────────────┐
   │                                              │
[AgentOrchestrator]                      [WebSocket Relay]
   │
   ├── ToolRegistry (computer, browser, shell, ...)
   ├── HeartbeatEngine (30s cycles)
   ├── TaskScheduler (cron + one-shot)
   ├── MemoryManager (vector + graph)
   ├── SkillLoader (YAML skills)
   ├── MCPServer (protocol bridge)
   └── ChannelAdapters (15 platforms)
```

### Request Flow (User Message → Response)

```
User Message (any channel)
       │
Channel Adapter (telegram/discord/slack/...)
       │
Gateway (port 18800) ──→ HTTP/WebSocket
       │
Core API (port 8000)
       │
AgentOrchestrator.chat()
       │
   ┌───┴──────────────────────────────────────┐
   │                                           │
[Agent Router]                         [Context Building]
 → Task Profile classify                → Message history
 → Specialist selection                 → System index
 → Route decision                       → Memory retrieval
   │                                           │
   └───────────────┬──────────────────────────┘
                   │
            [LLM Call via LiteLLM]
                   │
            [Tool Call Parallelism]
             max 8 parallel calls
                   │
            [Quality Evaluation]
             retry if needed (max 1)
                   │
            [Verification Evidence]
                   │
            [Response Stream]
                   │
            Back to Channel Adapter
```

## Implemented Runtime Capabilities

- Chat session and WebSocket runtime for dashboard conversations.
- Model/provider management with LiteLLM routing and provider configuration.
- Configurable tool registry and execution for local tools and external helpers.
- Skill installation and management via local, git, npm, and ClawHub-style sources.
- Persistent SQLite-backed memory for sessions, messages, tasks, and goals.
  Additional memory types (habits, profiles, model records) are planned but not
  yet fully implemented.
- MCP server support at `/mcp` with runtime discovery, tool proxying, and
  connector management.
- Channel adapters and webhook routing for real external integrations.
- Health checks, doctor diagnostics, backups, rollback support, migrations,
  audit events, and secret scanning.

## Channels That Are Actually Wired In

The runtime includes functional Node adapters for the following channels:

- Telegram
- Discord
- Slack
- Matrix
- IRC
- OneBot
- MQTT
- LINE
- WhatsApp bridge
- Feishu/Lark webhook flows
- DingTalk webhook flows
- QQ webhook callbacks
- hiro (built-in web chat)

The repository also contains forms and config surfaces for WeChat/WeCom, but the
live runtime adapters for those services are currently partial and require more
provider handshake implementation before they should be treated as fully active.

## What Is Not Automatically Enabled

- External API access is not turned on silently. The default configuration
  stays local and loopback-only unless you explicitly change ports or expose the
  gateway.
- Most channel traffic is disabled until credentials and webhook settings are
  configured. WhatsApp is enabled by default but still requires bridge credentials
  to function.
- Background autonomy and scheduled jobs are gated behind runtime settings.

## Configuration System

### `config/agent.yaml` — Agent Configuration

```yaml
agent:
  name: Miki
  timezone: xxx
  max_tokens_per_cycle: 4096
  resource:
    message_history_limit: 15
    max_context_chars: 80,000
    system_index_limit: 6
    tool_warmup_enabled: true
    quality_retry_limit: 1

memory:
  short_term_limit: 20
  long_term_enabled: true
  vector_search_threshold: 0.5
  max_context_memories: 5
  fact_prune_threshold: 0.15

concurrency:
  maxConcurrentTasks: 3
  maxParallelToolCalls: 8
  toolLockTimeoutMs: 30,000ms
  taskQueueSize: 50
  maxScheduledTaskAttempts: 3

self_improvement:
  enabled: true
  reflection_interval_minutes: 60
  max_reflections_per_day: 12
  auto_apply_optimizations: false

security:
  bypass_restrictions: true
  system_access: full
  sandbox_mode: false
  audit_logging: true
```

## Data Storage

| Storage | Path | Purpose |
|---|---|---|
| SQLite (core) | `data/agent.db` | Agent runs, audit logs, task queue |
| SQLite (memory) | `data/memory.db` | Long-term memories, facts |
| SQLite (scheduled) | `data/scheduled_tasks.db` | Cron/scheduled tasks |
| SQLite (system-index) | `data/system_index.db` | File system index |
| File System | `data/` | Logs, backups, cache |
| Secret Vault | `data/vault.json` | Encrypted credentials |

## Build System

### Turborepo Pipeline

```
build → typecheck → lint → test
```

### Build Scripts (scripts/)

| Script | Purpose |
|---|---|
| `build-cli.mjs` | Go CLI binary |
| `build-go-backend.mjs` | Go UI backend |
| `build-webui*.mjs` | Frontend builds |
| `build-runtime-if-stale.mjs` | Incremental runtime build |
| `prepare-runtime-package.mjs` | Runtime package preparation |
| `sync-webui-backend.mjs` | Sync frontend assets to backend |
| `run-verify.mjs` | Pre-release verification |
| `run-release-verify.mjs` | Release verification |
| `run-go-tests.mjs` | Go test runner |
| `clean-build-artifacts.mjs` | Build cleanup |

## Key Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.29.0 | MCP protocol |
| `better-sqlite3` | ^12.11.1 | SQLite database |
| `express` | ^4.19.0 | HTTP server |
| `openai` | ^4.52.0 | OpenAI API client |
| `playwright` | ^1.44.0 | Browser automation |
| `telegraf` | ^4.16.0 | Telegram bot |
| `ws` | ^8.17.0 | WebSocket |
| `zod` | ^3.25.76 | Schema validation |
| `js-yaml` | ^4.1.0 | YAML parsing |
| `turndown` | ^7.2.4 | HTML→Markdown |
| `tar` | ^7.4.0 | Archive handling |
| `dotenv` | ^16.4.0 | Environment config |

### Dev Dependencies

| Package | Purpose |
|---|---|
| `turbo` | ^2.10.5 | Monorepo build |
| `typescript` | ^6.0.0 | TypeScript compiler |
| `jest` | ^29.7.0 | Test framework |
| `eslint` | ^10.4.0 | Linting |
| `prettier` | ^3.8.3 | Code formatting |

## Security Architecture

```
┌─────────────────────────────────────────┐
│             Security Layers             │
├─────────────────────────────────────────┤
│ 1. CORS Enforcement (Gateway)           │
│    - Explicit origin allowlist          │
│    - CIDR-based IP allowlist            │
├─────────────────────────────────────────┤
│ 2. Auth Middleware (Core API)           │
│    - JWT/Bearer token validation        │
│    - One-time bootstrap token           │
│    - Dashboard access control           │
├─────────────────────────────────────────┤
│ 3. Tool Permission System (Core)        │
│    - auto_approve_safe: true            │
│    - require_confirm_destructive: true  │
│    - Per-tool lock modes (shared/excl.) │
├─────────────────────────────────────────┤
│ 4. Secret Management (Config)           │
│    - Vault-encrypted credentials        │
│    - Log redaction (redactSecrets)      │
│    - Secret scanning (secret-scan.ts)   │
├─────────────────────────────────────────┤
│ 5. File Security (Executor)             │
│    - Path traversal prevention          │
│    - Restricted paths enforcement       │
├─────────────────────────────────────────┤
│ 6. Audit Logging                        │
│    - Tamper-evident SQLite audit log    │
│    - Full tool call tracing             │
└─────────────────────────────────────────┘
```

> **Note:** `config/agent.yaml` has `security.system_access: full` and `sandbox_mode: false` — the agent operates with full OS access.

## Self-Improvement & Evolution System

```yaml
self_improvement:
  reflection_interval: 60min   → Performance reflection
  prompt_tuning: 120min        → System prompt optimization
  optimization: 180min         → Workflow optimization
  max_reflections_per_day: 12

evolution:
  mode: observe                → Currently observation-only
  min_task_count: 2
  min_success_ratio: 0.7       → 70% success rate required
  cold_path_trigger: after_turn

skill_governance:
  enabled: false               → Currently disabled
  check_syntax: true
  check_dangerous_patterns: true
  test_execution: true
```

**Circuit Breaker:** `SelfImprovementEngine` has a circuit breaker that stops self-improvement when the error rate is too high.

## Work In Progress (GOAL_PHASE2.md)

A **Phase 2 Cleanup** is currently underway to remove over-engineering:

| Phase | Task | Status |
|---|---|---|
| A | Broken stubs fix (`SelfImprovementEngine`) | Pending |
| B | Skill-governance consolidation (3 files → 1) | Pending |
| C | Skill-api.ts consolidation (20 routes → 3) | Pending |
| D | Installer source handlers cleanup | Pending |
| E | Build scripts cleanup (delete 10 unused) | Pending |
| F | Gateway runtime-utils inline | Pending |
| G | Skill-loader findSkillIndex fix | Pending |
| H | Final typecheck pass | Pending |

**Goal:** Remove ~1,500 lines + ~10 files.

## Testing

```
test/
├── Jest (JavaScript/TypeScript)
│   ├── packages/core/src/*.test.ts        → Unit tests
│   ├── packages/core/src/api/*.test.ts    → API tests
│   ├── packages/core/src/tools/*.test.ts  → Tool tests
│   ├── packages/core/src/mcp/*.test.ts    → MCP tests
│   └── packages/core/src/safety/*.test.ts → Safety tests
│
├── Go Tests
│   ├── packages/cli/*_test.go             → CLI tests
│   └── packages/ui/backend/*_test.go      → Backend tests
│
└── Frontend Tests
    └── packages/ui/frontend/              → Vitest tests
```

**Test Commands:**
```bash
npm run test          # All Jest tests
npm run test:go       # Go tests
npm run test:frontend # Frontend tests
npm run verify        # Pre-release verification
```

## File Count Summary

| Package | File Count | Estimated LOC |
|---|---|---|
| `packages/core/src` | 76+ files | ~150,000+ |
| `packages/core/src/api` | 19 files | ~70,000+ |
| `packages/gateway/src` | 8 files | ~3,000 |
| `packages/memory/src` | 10+ files | ~8,000 |
| `packages/skills/src` | 10+ dirs | ~5,000 |
| `packages/ui/frontend/src` | 50+ files | ~20,000 |
| `packages/ui/backend` | 20 files | ~3,000 |
| `packages/cli` | 15 files | ~3,000 |
| `packages/installer/src` | 10 files | ~5,000 |
| `packages/config/src` | 10+ files | ~3,000 |
| `scripts/` | 16 files | ~8,000 |
| **Total** | **~250+ files** | **~280,000+ LOC** |

## Optimizing This Project

### Optimize model usage

- Configure models and providers through the dashboard or `config/litellm.yaml`.
- Keep the LiteLLM proxy running at `127.0.0.1:4000` for local inference and
  consistent model routing.
- Use provider-specific advanced fields only when the chosen provider supports
  them; unsupported options may be ignored by the runtime.
- Pick the smallest model that still meets your prompt needs to reduce latency
  and cost.

### Optimize runtime performance

- Run `npm run doctor` after build to validate local health and configuration.
- Use `npm run verify` and `npm run smoke:gateway` before packaging or release.
- Keep `node_modules` and built outputs up to date with `npm run build`.
- Use `npm run sanitize:local-data` before sharing or archiving the workspace.

### Optimize channel setup

- Configure each channel with explicit credentials and webhook endpoints.
- Use `npm run smoke:channels-ui` to verify adapter readiness.
- Treat probe statuses as authoritative; `ready` means the runtime is configured,
  while `needs_config` means credentials are missing.

### Optimize security and visibility

- Keep the dashboard on `127.0.0.1:18800` unless you intentionally expose it.
- Use optional API key authentication for any external access path.
- Audit runtime behavior using logs, health reports, and the dashboard record
  history.

## Quick Start

```bash
npm install
npm run build
npm run doctor
npm start
```

The launcher prints the dashboard URL after startup. In a default local setup,
the dashboard is served at:

```text
http://127.0.0.1:18800/
```

On first launch:

1. Create a dashboard password.
2. Configure a model provider.
3. Open the chat page or configure a channel.

If you want to use the runtime with external integrations, add the required
credentials and webhook settings before enabling those channels.

## Common Commands

```bash
npm start                 # start the packaged/source runtime
npm run dev               # build, then start
npm run doctor            # run local health checks
npm run lint              # lint packages and dashboard
npm run verify            # test, audit, doctor
npm run verify:release    # release-grade verify/build/package/audit/smoke path
npm run smoke:gateway     # gateway integration smoke
npm run smoke:channels-ui # channel UI/probe smoke
npm run pack:check        # verify packaged runtime contents
npm run sanitize:local-data
```

## Repository Layout

```text
bin/                         CLI entrypoints
config/                      runtime configuration
data/                        local state, logs, databases, backups
docs/                        project documentation
packages/core     agent runtime and core API
packages/gateway  dashboard gateway and process supervisor
packages/config   config schema and security helpers
packages/Hiro-memory   GraphRAG memory system
packages/installer skill installer
packages/skills   bundled skills
packages/ui       React dashboard and Go compatibility backend
packages/Hiro-cli         Go terminal launcher
scripts/                     build, smoke, audit, packaging, cleanup scripts
```

## Runtime Defaults

```text
Dashboard/Gateway: http://127.0.0.1:18800
Core API:          http://127.0.0.1:8000
LiteLLM proxy:     http://127.0.0.1:4000
MCP endpoint:      http://127.0.0.1:18800/mcp
```

These values can be changed in `.env`.

## Release Verification

Before publishing, packaging, or handing off a build, run the following checks:

```bash
npm run lint
npm run verify
npm run build
npm run pack:check
npm run audit:agent
npm run smoke:gateway
npm run smoke:channels-ui
npm audit --omit=dev
```

For local checkouts that may contain generated secrets or runtime state, run:

```bash
npm run sanitize:local-data
```

## License

MIT
