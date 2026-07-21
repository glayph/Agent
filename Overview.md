# Hiro (Nexus) — Deep Project Overview

> **Project**: `@hiro` · Version `1.0.0` · License MIT  
> **Author**: miki · **Timezone**: Asia/Dhaka  
> **Runtime**: Node.js `^20.19.0 | ^22.13.0 | >=24` · **Package Manager**: `pnpm@10.33.0`  
> **Build System**: Turborepo · **Language Stack**: TypeScript (core) + Go (UI backend + CLI) + React/Vite (frontend)

---

## 1. প্রোজেক্টের সংক্ষিপ্ত পরিচয়

**Hiro** হলো একটি সম্পূর্ণ autonomous AI Agent system যা কম্পিউটারের পূর্ণ নিয়ন্ত্রণ নিয়ে কাজ করতে পারে।  
Agent-টির নাম **Miki**, যে ফাইল সিস্টেম, অ্যাপ্লিকেশন, ব্রাউজার, ডেস্কটপ, শেল এবং মেসেজিং প্ল্যাটফর্ম — সবকিছু স্বয়ংক্রিয়ভাবে নিয়ন্ত্রণ করতে পারে।

এটি একটি **Monorepo** যেখানে ৮টি আলাদা package রয়েছে, প্রতিটি আলাদা দায়িত্ব নিয়ে কাজ করে।

---

## 2. Monorepo Structure (সম্পূর্ণ কাঠামো)

```
Nexus/
├── packages/
│   ├── core/          ← Agent engine (TypeScript) — মূল মস্তিষ্ক
│   ├── gateway/       ← Process orchestrator + LiteLLM manager (TypeScript)
│   ├── memory/        ← Vector + Graph memory system (JavaScript)
│   ├── skills/        ← Built-in skill library (TypeScript)
│   ├── config/        ← Shared config, secrets, validation (TypeScript)
│   ├── installer/     ← Skill/plugin installer engine (TypeScript)
│   ├── ui/
│   │   ├── frontend/  ← React + Vite Web UI (TypeScript/TSX)
│   │   └── backend/   ← Go HTTP server (legacy + stub)
│   └── cli/           ← Go TUI terminal launcher (nexusagent-cli)
├── config/
│   ├── agent.yaml     ← Agent personality, specialists, channels config
│   ├── litellm.yaml   ← LiteLLM proxy config
│   └── tools.yaml     ← Tool definitions
├── scripts/           ← Build automation (16 .mjs scripts)
├── bin/               ← CLI entry point (Hiro.js / Agent.js)
├── src/skills/        ← Workspace-level skill definitions
└── data/              ← Runtime data, SQLite databases, logs
```

---

## 3. Package-by-Package Deep Analysis

---

### 📦 3.1 `packages/core` — Agent Engine (মূল ইঞ্জিন)

এটি সম্পূর্ণ প্রোজেক্টের **হৃদয়**। ৬৬+ TypeScript ফাইল, ~৩৩০K+ LOC।

#### 3.1.1 মূল Orchestrator — `agent.ts` (1,993 lines)

`AgentOrchestrator` class হলো সবকিছুর কেন্দ্রবিন্দু। এটি নিম্নলিখিত সব subsystem কে একত্রিত করে:

| Subsystem | ক্লাস/মডিউল | কাজ |
|---|---|---|
| Tool Registry | `ToolRegistry` | সব tool manage করে |
| Heartbeat | `HeartbeatEngine` | periodic background actions |
| Self Improvement | `SelfImprovementEngine` | reflection + optimization |
| Skill Governance | `SkillGovernanceEngine` | skill validation + safety |
| Task Queue | `TaskQueue` + `ConcurrentTaskManager` | async task management |
| Scheduler | `TaskScheduler` | cron + one-shot tasks |
| Cost Calibrator | `CostCalibrator` | LLM cost optimization |
| Token Budget | `buildAgentTokenBudget()` | context window management |
| Agent Registry | `AgentRegistry` | multi-agent instance tracking |
| Message Bus | `globalAgentMessageBus` | agent-to-agent communication |
| Blackboard | `globalAgentBlackboard` | shared state between agents |
| Delegator | `AgentDelegator` | task delegation to specialists |
| Planner | `globalAgentPlanner` | multi-step goal planning |
| Aggregator | `globalAgentAggregator` | result aggregation |

**Core constants:**
- `MAX_AGENT_TURNS = 50` — একটি session-এ সর্বোচ্চ turns
- `MAX_AGENT_TURNS_NO_OUTPUT = 12` — output ছাড়া সর্বোচ্চ silent turns
- `DEFAULT_MESSAGE_HISTORY_LIMIT = 15` — message history limit

#### 3.1.2 Agent Run Strategy — `agent-run.ts` (1,154 lines)

প্রতিটি task execution-এর lifecycle পরিচালনা করে। মূল data structures:

```
AgentRun
├── id, objective, status, createdAt, updatedAt
├── TaskGraphStep[]  ← dependency-based execution graph
│   ├── id, title, dependsOn[], phase (planner|executor|verifier)
│   ├── status: pending|running|completed|failed|skipped
│   └── evidence: VerificationEvidence[]
│       ├── kind: command|file|api|manual|metric
│       └── source: planner|executor|verifier|model|tool|test|build|smoke
└── VerificationEvidence — প্রমাণ সংগ্রহ করে result verify করে
```

**Run Phases:**
1. **Planner Phase** — goal decompose করে steps বানায়
2. **Executor Phase** — steps execute করে
3. **Verifier Phase** — results verify করে evidence সংগ্রহ করে

#### 3.1.3 Agent Router — `agent-router.ts` (577 lines)

Task-কে analyze করে সঠিক specialist agent-এ route করে।

**Built-in Specialists:**
| ID | নাম | Priority | বিশেষত্ব |
|---|---|---|---|
| `miki` | Miki (General) | 10 | সব কিছু — coordination, code, research, planning |
| `engineer` | Software Engineer | 8 | code, debug, test, refactor |
| `planner` | Workflow Planner | 6 | architecture, roadmap, complex workflows |
| `researcher` | Research Analyst | 4 | web research, comparison, audit |
| `general` | General Coordinator | 0 | simple coordination |

**Routing Algorithm:**
```
Task Input → TaskProfile (complexity: simple|standard|complex)
           → Signal Detection (keyword + pattern matching)
           → Candidate Scoring (priority × signal match)
           → Best Specialist Selection (min_score = 2)
           → Route Decision (single_orchestrator | multi_agent)
```

#### 3.1.4 Multi-Agent System

```
agent-registry.ts      → AgentInstance tracking (id, type, status, sessionId)
agent-message-bus.ts   → Publish/Subscribe messaging between agents
agent-blackboard.ts    → Shared read/write state (key-value store)
agent-delegator.ts     → Task delegation to specialist instances
agent-aggregator.ts    → Parallel result collection + merging
agent-planner.ts       → Goal decomposition with backtracking
agent-tot.ts           → Tree-of-Thought reasoning strategy
```

#### 3.1.5 Tool System — `tools/`

| ফাইল | বর্ণনা | আকার |
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

#### 3.1.6 Tool Parallelism — `tool-call-parallelism.ts` (651 lines)

একাধিক tool একই সাথে parallel-এ চালানোর জন্য sophisticated system:

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

#### 3.1.7 Memory & Context Management

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

#### 3.1.8 Quality & Monitoring

```
quality-evaluator.ts     → Response quality scoring
agent-confidence.ts      → Confidence scoring per decision
metrics-collector.ts     → Performance metrics (latency, tokens, cost)
execution-tracer.ts      → Full execution trace logging
audit-log.ts             → Tamper-evident audit trail (SQLite)
structured-logger.ts     → JSON structured logging
performance-budgets.ts   → Performance budget enforcement
```

#### 3.1.9 Safety System — `safety/`

| ফাইল | কাজ |
|---|---|
| `doctor.ts` | System health diagnosis (9,252 bytes) |
| `backup.ts` | Automated backup engine (11,773 bytes) |
| `migrations.ts` | Database migration manager |
| `safe-mode.ts` | Restricted operation mode |
| `secret-scan.ts` | Secret/credential leak detection |
| `watchdog.ts` | Process watchdog |
| `startup.ts` | Safe startup validation |
| `full-health.ts` | Full system health check |

#### 3.1.10 MCP (Model Context Protocol) — `mcp/`

| ফাইল | কাজ |
|---|---|
| `server.ts` | MCP server (11,962 bytes) |
| `connectors.ts` | MCP connector management |
| `discovery.ts` | MCP server auto-discovery |
| `core-client.ts` | MCP client implementation |
| `resources.ts` | MCP resource handlers |
| `prompts.ts` | MCP prompt templates |
| `session-manager.ts` | MCP session lifecycle |
| `permissions/` | Fine-grained MCP tool permissions |

#### 3.1.11 Channel Adapters — `channels/`

**১৫টি messaging platform** সরাসরি integrate করা:

| Platform | ফাইল | আকার |
|---|---|---|
| Telegram | `telegram.ts` | 9KB |
| Discord | `discord.ts` | 12KB |
| Slack | `slack.ts` | 10KB |
| WhatsApp | `whatsapp.ts` | 12KB |
| Feishu (飞书) | `feishu.ts` | 13KB |
| DingTalk (钉钉) | `dingtalk.ts` | 10KB |
| QQ | `qq.ts` | 9KB |
| WeChat/Weixin | (config-only) | — |
| LINE | `line.ts` | 6KB |
| OneBot | `onebot.ts` | 12KB |
| Matrix | `matrix.ts` | 9KB |
| IRC | `irc.ts` | 12KB |
| MQTT | `mqtt.ts` | 16KB |
| Pico | (config-only) | — |
| Adapter SDK | `adapter-sdk.ts` | 6KB |

#### 3.1.12 Plugin System — `plugins/`

```
plugin-channel-adapter.ts       → Channel plugin runtime integration (11KB)
plugin-channel-runtime.ts       → Channel plugin lifecycle (21KB)
plugin-contract-runtime.ts      → Plugin contract enforcement (31KB)
plugin-marketplace-readiness.ts → Marketplace compatibility check (20KB)
plugin-provider-adapter.ts      → LLM provider plugin adapter (9KB)
plugin-tool-registration.ts     → Dynamic tool registration from plugins (5KB)
```

Plugin contract kinds: `tools` | `channels` | `skills` | `providers` | `hooks`

#### 3.1.13 System Index — `system-index/`

```
indexer.ts       → File system + code indexer (12,698 bytes)
database.ts      → SQLite-backed index storage (7,406 bytes)
extractors.ts    → Content extractor (code, docs, configs)
agent-context.ts → Per-session context builder
types.ts         → Index data types
```

#### 3.1.14 Heartbeat Engine — `heartbeat.ts` (272 lines)

প্রতি `30 seconds`-এ background cycle চালায়:
- Self-improvement reflection check
- Prompt tuning check
- Optimization cycle check
- Resource cleanup (stale profiles, task queue)
- Cost calibration update

#### 3.1.15 Skill System — `skill-loader.ts`, `skill-search.ts`, `skill-api.ts`

```
SkillLoader          → YAML-based skill discovery + loading
SkillSearchEngine    → Semantic skill search (keyword + vector)
skill-api.ts         → REST API (~20 routes): list, get, install, execute, probe
SkillGovernanceEngine → Skill validation + safety rules
```

#### 3.1.16 REST API — `api/` (মূল HTTP Server)

`api/index.ts` (57,176 bytes!) — সম্পূর্ণ API server:

| Router | কাজ |
|---|---|
| `launcher-compat.ts` (6,089 lines!) | Main compatibility layer — session, config, models |
| `file-manager-router.ts` (41,455 bytes) | Full file system operations |
| `enhancement-router.ts` (20,270 bytes) | AI enhancement endpoints |
| `channel-runtime-probe.ts` (17,991 bytes) | Channel health probing |
| `session-router.ts` | Session management |
| `auth-middleware.ts` | JWT/token auth |
| `provider-management.ts` | LLM provider CRUD |
| `system-monitoring.ts` | System stats endpoint |
| `mcp-server.ts` | MCP server endpoint |

---

### 📦 3.2 `packages/gateway` — Process Orchestrator

**Gateway** হলো সিস্টেমের **front door** — port `18800`-তে সব request receive করে।

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
| ফাইল | বর্ণনা |
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

---

### 📦 3.3 `packages/memory` — Memory System

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
- `short_term` — সাম্প্রতিক conversation context
- `long_term` — persistent facts + knowledge
- `personality` — user preferences + behavioral patterns
- `procedural` — learned workflows + procedures

**API Layer:**
- `memory/src/api/` — REST API for memory CRUD
- `memory/src/cli.js` — CLI interface
- `memory/src/nodegraphrag.js` — Graph RAG integration

---

### 📦 3.4 `packages/skills` — Built-in Skill Library

Skills হলো pre-packaged workflows যা Agent সরাসরি execute করতে পারে।

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

প্রতিটি skill একটি YAML/JSON definition যেখানে থাকে:
- `name`, `description`, `version`
- `triggers` (কখন activate হবে)
- `steps` (কী কী action নেবে)
- `tools_required` (কোন tools দরকার)

---

### 📦 3.5 `packages/config` — Shared Configuration

সব package-এ shared configuration, secrets management এবং validation:

- **`settings`** — Runtime configuration singleton
- **`ChatMessage`**, **`ToolDefinition`**, **`LLMResponse`** — Core types
- **`validateRuntimeConfig()`** — Config validation
- **Secret Vault** — Encrypted credential storage
- **`redactSecrets()`** — Log sanitization
- **Security helpers** — CORS origins, CIDR validation, LiteLLM key resolution

---

### 📦 3.6 `packages/installer` — Plugin & Skill Installer

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

---

### 📦 3.7 `packages/ui` — User Interface

#### Frontend (React + Vite + TypeScript)

**Technology Stack:**
- React 19 + TanStack Router
- Vite build system
- shadcn/ui components
- i18n internationalization
- Zustand state management

**Routes (পেজ সমূহ):**
| Route | কাজ |
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
│   └── owlclaw Web Console — WebSocket chat + config management
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

> ⚠️ Legacy Go backend requires external `owlclaw` pkg deps. Normally, `stub_main.go` compiles without them.

---

### 📦 3.8 `packages/cli` — Go TUI Launcher

Go-তে লেখা terminal-based launcher (`nexusagent-cli`, 20MB compiled):

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

**কাজ:**
- Hiro process launch করে
- Real-time log streaming
- Health status display
- Process restart management

---

## 4. Configuration System Deep Dive

### `config/agent.yaml` — মূল Agent Configuration

```yaml
agent:
  name: Miki
  timezone: Asia/Dhaka
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

---

## 5. Runtime Architecture

### Startup Flow

```
bin/Hiro.js (Entry Point)
       │
       ▼
[CLI Go Launcher] ──→ nexusagent-cli
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

---

## 6. Data Storage

| Storage | Path | কাজ |
|---|---|---|
| SQLite (core) | `data/agent.db` | Agent runs, audit logs, task queue |
| SQLite (memory) | `data/memory.db` | Long-term memories, facts |
| SQLite (scheduled) | `data/scheduled_tasks.db` | Cron/scheduled tasks |
| SQLite (system-index) | `data/system_index.db` | File system index |
| File System | `data/` | Logs, backups, cache |
| Secret Vault | `data/vault.json` | Encrypted credentials |

---

## 7. Build System

### Turborepo Pipeline

```
build → typecheck → lint → test
```

### Build Scripts (scripts/)

| Script | কাজ |
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



---

## 8. Key Dependencies

### Runtime Dependencies

| Package | Version | কাজ |
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

| Package | কাজ |
|---|---|
| `turbo` | ^2.10.5 | Monorepo build |
| `typescript` | ^6.0.0 | TypeScript compiler |
| `jest` | ^29.7.0 | Test framework |
| `eslint` | ^10.4.0 | Linting |
| `prettier` | ^3.8.3 | Code formatting |

---

## 9. Security Architecture

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

> **Note:** `config/agent.yaml`-এ `security.system_access: full` এবং `sandbox_mode: false` set আছে — মানে Agent-টি সম্পূর্ণ OS access নিয়ে কাজ করে।

---

## 10. Self-Improvement & Evolution System

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

**Circuit Breaker:** `SelfImprovementEngine`-এ একটি circuit breaker আছে যা error rate বেশি হলে self-improvement বন্ধ করে দেয়।

---

## 11. Work In Progress (GOAL_PHASE2.md)

বর্তমানে একটি **Phase 2 Cleanup** চলছে — over-engineering দূর করা:

| Phase | কাজ | Status |
|---|---|---|
| A | Broken stubs fix (`SelfImprovementEngine`) | Pending |
| B | Skill-governance consolidation (3 files → 1) | Pending |
| C | Skill-api.ts consolidation (20 routes → 3) | Pending |
| D | Installer source handlers cleanup | Pending |
| E | Build scripts cleanup (delete 10 unused) | Pending |
| F | Gateway runtime-utils inline | Pending |
| G | Skill-loader findSkillIndex fix | Pending |
| H | Final typecheck pass | Pending |

**Goal:** ~1,500 lines + ~10 files মুছে ফেলা।

---

## 12. Testing

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

---

## 13. সম্পূর্ণ File Count Summary

| Package | ফাইল সংখ্যা | আনুমানিক LOC |
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

---

## 14. Project Summary (One-Liner)

> **Hiro (Nexus)** হলো একটি production-grade, multi-agent, autonomous AI system যা TypeScript + Go + React দিয়ে তৈরি, যেখানে রয়েছে: 15টি messaging platform integration, parallel tool execution, semantic memory, MCP protocol support, plugin marketplace, এবং সম্পূর্ণ OS-level computer control — সবকিছু একটি Turborepo monorepo-তে সংগঠিত।

---

*Generated: 2026-07-20 | Deep Analysis by Antigravity*
