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
    │   ├── launcher-compat.ts
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
