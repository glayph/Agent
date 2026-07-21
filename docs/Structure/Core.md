# core — Agent Engine

The main agent runtime: orchestrator, LLM interaction, tool execution, channel adapters,
plugin system, safety, self-improvement, and skill management.

```
core/
├── src/
│   ├── agent.ts                     AgentOrchestrator — core agent loop
│   ├── agent-aggregator.ts          Multi-agent response aggregation
│   ├── agent-blackboard.ts          Shared workspace for sub-agents
│   ├── agent-confidence.ts          Confidence scoring for agent outputs
│   ├── agent-delegator.ts           Delegation to specialist sub-agents
│   ├── agent-message-bus.ts         Inter-agent messaging
│   ├── agent-planner.ts             High-level task planning
│   ├── agent-registry.ts            Sub-agent registration
│   ├── agent-router.ts              Message routing to specialist sub-agents
│   ├── agent-run.ts                 Agent run lifecycle management
│   ├── agent-token-budget.ts        Per-run token budgeting
│   ├── agent-tot.ts                 Tree-of-Thought reasoning
│   ├── agent-workflow-acceleration.ts  Workflow optimization shortcuts
│   ├── audit-log.ts                 Activity audit trail
│   ├── cache-manager.ts             In-memory cache with TTL
│   ├── concurrent-manager.ts        Concurrency control
│   ├── contextual-tool-pruner.ts    Smart tool selection based on context
│   ├── cost-calibrator.ts           Token cost estimation
│   ├── error-handler.ts             Unified error handling
│   ├── errors.ts                    Error types
│   ├── execution-tracer.ts          Execution tracing
│   ├── health-checker.ts            System health monitoring
│   ├── heartbeat.ts                 Heartbeat signal
│   ├── litellm-config.ts            LiteLLM configuration
│   ├── llm-cache.ts                 LLM response caching
│   ├── llm.ts                       LLM client abstraction
│   ├── metrics-collector.ts         Performance metrics
│   ├── optimizations.ts             Runtime optimizations
│   ├── paths.ts                     Path resolution
│   ├── performance-budgets.ts       Performance budget tracking
│   ├── persistent-job-queue.ts      Durable job queue (SQLite-backed)
│   ├── quality-evaluator.ts         Output quality evaluation
│   ├── request-deduplicator.ts      Deduplicate identical requests
│   ├── scheduled-task-store.ts      Scheduled task persistence
│   ├── scheduler.ts                 Task scheduler
│   ├── skill-api.ts                 Skill HTTP API
│   ├── skill-integration.ts         Skill integration helpers
│   ├── skill-loader.ts              Skill loading and lifecycle
│   ├── skill-search.ts              Skill discovery
│   ├── skill-utils.ts               Skill utilities
│   ├── stream-predictor.ts          Response streaming
│   ├── structured-logger.ts         Structured logging
│   ├── task-profile.ts              Task profiling
│   ├── task-queue.ts                In-memory task queue
│   ├── token-budget-manager.ts      Global token budget management
│   ├── tool-call-parallelism.ts     Parallel tool execution
│   ├── workflow-accelerator.ts      Workflow acceleration

### api/ — Express API Routes

│   ├── api/
│   │   ├── index.ts                 Main API server (Express, all routes, WS, channels, 1955 lines)
│   │   ├── auth-middleware.ts       API key and launcher authentication
│   │   ├── channel-runtime-probe.ts Channel health probes
│   │   ├── enhancement-router.ts    Provider enhancement routes
│   │   ├── file-manager-router.ts   File system management routes
│   │   ├── launcher-auth-guards.ts  Launcher authentication guards
│   │   ├── launcher-compat.ts       Launcher compatibility layer
│   │   ├── mcp-server.ts            MCP protocol server
│   │   ├── provider-management.ts   LLM provider management
│   │   ├── session-router.ts        Chat session routes
│   │   ├── shutdown-utils.ts        Graceful shutdown utilities
│   │   └── system-monitoring.ts     System resource monitoring

### channels/ — Channel Adapters (15 platforms)

│   ├── channels/
│   │   ├── adapter-sdk.ts           Channel adapter base class
│   │   ├── agent-response.ts        Unified response formatting
│   │   ├── telegram.ts              Telegram bot adapter
│   │   ├── discord.ts               Discord bot adapter
│   │   ├── slack.ts                 Slack app adapter
│   │   ├── matrix.ts                Matrix protocol adapter
│   │   ├── irc.ts                   IRC adapter
│   │   ├── whatsapp.ts              WhatsApp bridge adapter
│   │   ├── feishu.ts                Feishu/Lark adapter
│   │   ├── dingtalk.ts              DingTalk adapter
│   │   ├── qq.ts                    QQ bot adapter
│   │   ├── line.ts                  LINE messaging adapter
│   │   ├── onebot.ts                OneBot protocol adapter
│   │   └── mqtt.ts                  MQTT adapter

### goals/ — Goal Pursuit

│   ├── goals/
│   │   └── pursue-goal.ts           Goal pursuit engine

### mcp/ — Model Context Protocol

│   ├── mcp/
│   │   ├── index.ts                 MCP module entry
│   │   ├── config.ts                MCP configuration
│   │   ├── types.ts                 MCP type definitions
│   │   ├── context.ts               MCP context management
│   │   ├── connectors.ts            External service connectors
│   │   ├── connectors.test.ts
│   │   ├── core-client.ts           MCP core client
│   │   ├── discovery.ts             MCP tool discovery
│   │   ├── discovery.test.ts
│   │   ├── errors.ts                MCP error types
│   │   ├── prompts.ts               MCP prompt templates
│   │   ├── resources.ts             MCP resource management
│   │   ├── server.ts                MCP server implementation
│   │   ├── session-manager.ts       MCP session lifecycle
│   │   ├── contracts/               Contract definitions
│   │   └── permissions/             Permission management

### plugins/ — Plugin System

│   ├── plugins/
│   │   ├── plugin-tool-registration.ts     Tool plugin registration
│   │   ├── plugin-channel-adapter.ts       Channel plugin adapter
│   │   ├── plugin-channel-runtime.ts       Channel plugin runtime
│   │   ├── plugin-contract-runtime.ts      Plugin contract validation
│   │   ├── plugin-marketplace-readiness.ts Marketplace readiness
│   │   └── plugin-provider-adapter.ts      Provider plugin adapter

### safety/ — Safety & Security

│   ├── safety/
│   │   ├── index.ts                 Safety module entry
│   │   ├── backup.ts                Data backup
│   │   ├── doctor.ts                Diagnostics
│   │   ├── full-health.ts           Comprehensive health check
│   │   ├── migrations.ts            Database migrations
│   │   ├── safe-mode.ts             Safe mode fallback
│   │   ├── secret-scan.ts           Secret scanning
│   │   ├── startup.ts               Startup validation
│   │   └── watchdog.ts              Process watchdog

### self-improvement/ — Self-Improvement Engine

│   ├── self-improvement/
│   │   ├── engine.ts                Self-improvement orchestrator
│   │   ├── ab-test-framework.ts     A/B testing framework
│   │   ├── analyzer.ts              Performance analysis
│   │   ├── behavior-policy.ts       Behavior policy engine
│   │   ├── change-audit.ts          Self-change audit
│   │   ├── optimizer.ts             Prompt/tool optimization
│   │   ├── reflector.ts             Self-reflection
│   │   └── reward.ts                Reward computation

### skill-governance/ — Skill Execution Rules

│   ├── skill-governance/
│   │   ├── engine.ts                Governance engine
│   │   ├── rule-engine.ts           Rule evaluation
│   │   └── self-planner.ts          Autonomous skill planning

### system-index/ — File System Indexing

│   ├── system-index/
│   │   ├── indexer.ts               Recursive file indexer
│   │   ├── agent-context.ts         Context-aware file listing
│   │   ├── database.ts              Index storage
│   │   ├── extractors.ts            Content extractors
│   │   └── types.ts                 Index types

### tools/ — Tool System

│   ├── tools/
│   │   ├── index.ts                 Tool system entry
│   │   ├── registry.ts              Tool registry
│   │   ├── registry/                Registry sub-modules
│   │   ├── executor.ts              Tool execution engine
│   │   ├── executor/                Executor sub-modules
│   │   ├── browser.ts               Browser automation (Playwright)
│   │   ├── computer.ts              Computer control (mouse, keyboard, screen)
│   │   ├── crawler.ts               Web crawler
│   │   ├── dependency-resolver.ts   Dependency resolution
│   │   ├── profile-manager.ts       Tool profile management
│   │   ├── project-workflow.ts      Project workflow tools
│   │   ├── resource-pool.ts         Browser/resource pooling
│   │   ├── retry-manager.ts         Retry with backoff
│   │   └── tool-warmer.ts           Tool pre-warming

├── dist/                            Compiled output
├── package.json
├── tsconfig.json
└── temp-tsconfig.json               Temporary build config
```
