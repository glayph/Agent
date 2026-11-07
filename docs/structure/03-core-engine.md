# 03 — packages/core (Agent Engine)

Largest and most critical package. Contains the agent runtime, planner, tool system, plugins, LLM layer, autonomy, safety, and self-improvement loops.

```
packages/core/
├── package.json                 # @miki/core — main: dist/api/index.js
├── tsconfig.json
├── pnpm-lock.yaml
├── __tests__/                   # Integration / API / plugin tests
└── src/
    ├── agent.ts                 # Central Agent class — orchestration entry
    ├── agent-run.ts             # Single-run execution logic
    ├── agent-planner.ts         # Task decomposition / planning
    ├── agent-router.ts          # Message / task routing
    ├── agent-registry.ts        # Agent instance registry
    ├── agent-delegator.ts       # Delegation to sub-agents
    ├── agent-aggregator.ts      # Result aggregation
    ├── agent-blackboard.ts      # Shared blackboard state
    ├── agent-confidence.ts      # Confidence scoring
    ├── agent-history.ts         # Conversation / run history
    ├── agent-message-bus.ts     # Internal event bus
    ├── agent-token-budget.ts    # Token budget management
    ├── agent-workflow-acceleration.ts
    ├── adaptive-capability-selector.ts
    ├── plan-capability-analyzer.ts
    ├── quality-evaluator.ts
    ├── heartbeat.ts             # Keep-alive / periodic control
    ├── automation.ts            # Automation runtime
    ├── scheduler.ts             # Cron / scheduled tasks
    ├── task-queue.ts            # Persistent task queue
    ├── concurrent-manager.ts    # Parallel task execution
    ├── cache-manager.ts
    ├── cost-calibrator.ts
    ├── error-handler.ts
    ├── execution-tracer.ts
    ├── metrics-collector.ts
    ├── request-deduplicator.ts
    ├── session-history-store.ts
    ├── session-turn-lock.ts
    ├── skill-loader.ts
    ├── skill-search.ts
    ├── skill-api.ts
    ├── structured-logger.ts
    ├── universal-session.ts
    ├── voice-runtime.ts / voice-routing.ts / speech-to-text.ts
    ├── web-search-service.ts
    ├── workflow-engine.ts / workflow-accelerator.ts
    ├── paths.ts
    ├── llm.ts                   # LLM call facade
    ├── llm/                     # Provider implementations
    │   └── provider/
    │       └── sdk/             # Provider SDK boundary
    ├── api/                     # HTTP API routers exposed via gateway
    │   ├── index.ts
    │   ├── chat-session.ts
    │   ├── session-router.ts
    │   ├── memory-router.ts
    │   ├── file-manager-router.ts
    │   ├── approval-router.ts / runtime-approval-router.ts
    │   ├── mcp-server.ts
    │   ├── voice-router.ts
    │   ├── system-monitoring.ts
    │   ├── workspace-folders-router.ts
    │   ├── auth-middleware.ts
    │   ├── gateway integration is owned by packages/gateway
    │   └── ...
    ├── autonomy/                # Autonomous goal management
    │   ├── autonomy-controller.ts
    │   ├── autonomous-goal-manager.ts
    │   ├── goal-catalog.ts / goal-scorer.ts
    │   ├── objective-store.ts
    │   ├── state-machine.ts
    │   ├── command-parser.ts
    │   └── ...
    ├── tools/                   # Tool registry & executors
    │   ├── index.ts
    │   ├── registry/
    │   ├── executor/
    │   ├── browser.ts
    │   ├── computer.ts
    │   ├── crawler.ts
    │   ├── hardened-code-worker.ts
    │   └── ...
    ├── plugins/                 # Plugin system (major expansion point)
    │   ├── index.ts
    │   ├── core-host.ts
    │   ├── builtin-plugin-catalog.ts
    │   ├── sdk/
    │   ├── browser/
    │   ├── computer-use/
    │   ├── code-execution/
    │   ├── model-router/
    │   ├── providers/           # Gemini, llama.cpp, etc.
    │   ├── channels/            # Telegram, Discord, Slack, WhatsApp, Matrix, ...
    │   ├── guardrails/
    │   ├── knowledge/
    │   ├── storage/
    │   ├── scheduler/
    │   ├── notifications/
    │   ├── authentication/
    │   ├── integrations/
    │   ├── workflow/
    │   ├── agent-to-agent/
    │   └── ...
    ├── mcp/                     # Model Context Protocol support
    │   ├── contracts/
    │   └── permissions/
    ├── memory/                  # Core-side memory integration helpers
    ├── safety/                  # Safety checks
    ├── security/                # Security plugin / policies
    ├── self-improvement/        # Self-improvement engine & reward
    ├── skill-governance/        # Skill loading / approval governance
    ├── observability/           # Metrics, tracing, logging
    ├── control/                 # Control-plane helpers
    ├── search/                  # Search plugin
    ├── system-index/            # System indexing
    ├── workspace-folders/       # Workspace folder management
    ├── runtime-fetch/           # Controlled fetch utilities
    └── __mocks__/               # Test mocks
```

**Key responsibilities**
- Orchestrates planning → tool selection → execution → verification → memory write-back.
- Hosts the plugin architecture (providers, channels, computer-use, browser, code-execution, etc.).
- Implements model routing, token budgets, concurrency limits, quality evaluation and self-improvement.
- Exposes HTTP/WS APIs consumed by the gateway and UI.
- Enforces safety, approvals and audit logging.

**Comments on important files**
- `agent.ts` — root Agent class; wires most subsystems together.
- `agent-planner.ts` + `plan-capability-analyzer.ts` — decompose goals and match capabilities.
- `plugins/computer-use/` — controlled desktop automation (mouse, keyboard, screenshots).
- `plugins/model-router/` + `llm/` — local (llama.cpp) vs cloud (Gemini etc.) routing.
- `autonomy/` — long-running autonomous goal loops and state machines.
- `self-improvement/` — reward calculation and improvement engine.

**Agent loop behaviour (`src/engine/`)**
- Understanding is the model's job. There is no keyword, regex or intent routing of user messages anywhere in the loop; the old regex control parser and the free-text `agent_control_request` tool were removed. The model calls the typed `agent_control_*` tools directly (capabilities → plan → execute).
- Memory recall runs on every run, with or without tools. The `memory_search` tool ranks with the graph/semantic memory engine (facts, selective graph context), not with SQL `LIKE`.
- Tool selection happens in the primary agent completion; ordinary text replies do not trigger a second LLM completion-classifier call. Web chat activity is driven by real tool events rather than a separate LLM-generated pre-action message.
- The gateway starts relevant-memory retrieval while conversation-history compaction is running, so independent preparation work overlaps.
- Empty model replies are retried once in the same run. Invalid tool arguments come back with the tool's expected parameters so the model can correct the call immediately.
- LLM retries honour `Retry-After` and add jitter to the exponential backoff.
- Optional self-check (`verifier.ts`, disabled by default): set `agent.self_check.enabled=true` to have the model check a tool-using draft against tool evidence and revise it when it finds a concrete problem (unsupported claim, failure reported as success, ignored part of the request). This adds one verification model call; chat-only runs are not checked. Tunables: `agent.self_check.max_revisions` (0-2), `agent.self_check.min_tool_calls`. Tool approval, policy enforcement, action reconciliation and provider recovery are independent and remain active when self-check is off.
- Dynamic budget (`budget.ts`, enabled by the gateway; `agent.dynamic_budget.enabled=false` turns it off): when a run reaches its turn, tool-iteration or tool-call limit while its newest tool calls are still succeeding and not repeating, the limits grow by a bounded step (`extension_turns`, default 6, at most `max_extensions`, default 2). Failing or looping runs still stop at the limit, and a run with its own per-run `maxToolCalls` cap (autonomous supervisor) is never extended. Progress is judged from call status and distinctness only, never from wording.
- Agent task lifetime is unbounded: the gateway ignores legacy `max_wall_time_ms`, `inactivity_timeout_ms`, and background inactivity settings. A task is not stopped because a duration elapsed. Individual provider requests can still fail/retry on their own network timeout, owner cancellation and safety/approval rules remain active, and the 24/7 process supervisor restarts an unresponsive gateway. Queue/active-lane ages are diagnostic telemetry only.
- Each terminal run emits a structured `run.budget` event (`runId`, `elapsedMs`, `wallTimeMs`, `outcome`) and records `agent_run` latency/outcome metrics; wall-time expiries increment `agent_runs_wall_time_exceeded_total`.
- `task-state.ts` defines the deterministic lifecycle contract (`queued`, `running`, `waiting_approval`, `retrying`, `verifying`, `completed`, `failed`, `cancelled`), versioned transitions, terminal-state checks, and invalid-transition errors.
- `task-store.ts` persists that lifecycle in SQLite (`miki_tasks` and `miki_task_events`) with transactional transition history, optimistic version checks, worker leases, claim, and expired-lease recovery; the gateway initializes the schema at startup.
- `task-worker.ts` provides the reusable lease-aware worker loop: claim polling, expired-lease recovery, heartbeat renewal, handler result verification, retry-on-error, and clean shutdown. The autonomous supervisor still has a legacy queue adapter to migrate next.
- `autonomous-supervisor.ts` now mirrors its scheduled queue into the unified durable task tables, preserving legacy scheduling while exposing versioned lifecycle events and durable lease recovery.

## 24/7 execution, health and self-recovery

- Agent task lifetime is intentionally unbounded: no wall-clock or inactivity deadline ends a foreground chat or durable background-agent task. The legacy timeout settings and environment variables are ignored; owner cancellation, approval/security gates, provider request-level failure handling and operating-system resource protection remain separate.
- `npm run dev` builds the project, then starts `scripts/miki-24-7.mjs` as the runtime supervisor. The supervisor restarts the Gateway after process exit or an event-loop/liveness failure, uses capped backoff without a restart-count ceiling, and persists its state under `data/24-7-supervisor.json`. The `dev.js` launcher also relaunches the supervisor if that process itself exits unexpectedly. `npm run runtime:24-7` starts the same Gateway supervisor for an already-built installation.
- On Gateway restart, the durable replay/recovery path re-queues interrupted chat messages and the task store recovers expired worker leases from checkpoints. Unsettled external side effects are reconciled before they can be repeated; they are not blindly replayed.
- Conversation work is serialized per conversation. Waiting entries can be cancelled by their owner without releasing the active holder or breaking FIFO order. Queue/active-lane ages are visible in `/gateway/health` as diagnostic signals; they do not stop long-running work.
- `/gateway/live` is a cheap event-loop liveness probe; `/gateway/health` reports database, event-loop, model, channel, outbox, run-queue and resource-pressure state. The outer supervisor restarts an unresponsive Gateway, not a healthy Gateway merely because a model/provider is unavailable.
- This recovers process crashes and event-loop hangs, and durable checkpoints recover interrupted jobs. It cannot prove that an arbitrary third-party plugin Promise is making progress while the Gateway event loop remains healthy; such integrations should emit heartbeats/checkpoints and implement their own cancellable request recovery. No elapsed-time kill is applied to solve that case.

## Chat steering and conversation serialization

- `AgentEngine.steer()` timestamps and queues user messages. With `agents.defaults.steer_interrupt` enabled (the default), a message aborts only the active LLM completion; the run's own cancellation signal remains independent. The discarded streamed draft is retracted, then steering messages are added to the next model request with numbered timestamps.
- A tool already running is allowed to finish. Before each not-yet-started tool call, the engine checks the steering inbox and records skipped calls with an instruction to repeat the operation if still needed.
- `ChatTurnRunner` acquires a shared `KeyedLane` by conversation before registering a new active run. Messages that can be steered into the active run are delivered there; otherwise they stay queued until the lane is available.
- If a run fails or reaches its execution limit, unread steered messages are queued for one carryover run each. Explicit user cancellation excludes them from carryover. The chat UI shows a processing label and the current activity for a steered message that is waiting to be read.
