# Miki Architecture and Module Boundaries

This document describes the current code layout. For the operational identity, capability discovery, autonomous execution lanes, and permission boundaries, read [Agent-Miki Operating Model](AGENT_MIKI_OPERATING_MODEL.md).

## Runtime composition

The Gateway package is the application composition root. `packages/gateway/src/index.ts` starts the HTTP/WebSocket server and runtime services; `packages/gateway/src/agent/agent-runtime.ts` builds and manages the Agent runtime. Core owns reusable agent execution and domain logic. Memory owns persistent-memory implementations.

```text
React UI / CLI / channels
          |
          v
       Gateway  -----> Agent runtime / chat / channels / health / auth
          |                         |
          |                         v
          +-----------------> ProviderGateway
          |                         |
          v                         v
         Core <-------------- Provider registry / adapters
          |
          +------> Memory package
          +------> Config contracts
```

## Provider boundary

Agent-facing provider access is routed through `packages/gateway/src/providers/ProviderGateway`. It resolves provider capabilities, credentials/failover candidates, and the `EngineLLMClient` boundary. Provider registry and adapter implementations live under `packages/core/src/plugins/providers/`. Agent runtime code must not instantiate provider SDK clients or import the registry directly. Administrative model/health endpoints may perform their own guarded probes.

## Workspace responsibilities

```text
packages/
├── cli/       # TypeScript CLI, lifecycle controller, terminal dashboard, package assembly
├── config/    # Shared schemas, environment/config loading, security and vault contracts
├── core/      # Agent engine, tools, permissions, autonomy, plugins, tasks and services
├── gateway/   # HTTP/WS composition, Agent runtime, channels, chat, providers and monitoring
├── memory/    # Canonical TKG and file-backed persistent memory
└── ui/        # React frontend plus legacy Go compatibility sources
```

There is no independent `packages/skills` or `packages/installer` workspace in this tree. Skill catalogue, manager, governance integration, and installer implementation are housed under `packages/core/src/plugins/skills/`. The root `package.json` declares the actual workspace/build topology; do not infer a package from an old diagram.

## Gateway source domains

- `agent/`: prompt construction, identity file loading, runtime integration, feedback and learned behavior.
- `providers/`: Agent-facing provider boundary, model resolution, retry and provider error handling.
- `chat/`: chat turns, streaming, attachments, media and message traces.
- `channels/`: channel runtime, session lanes, delivery and webhook ingress.
- `tools/`: tool names, groups, terminal integration and tool wire formats.
- `plugins/`: marketplace and MCP proxy routes.
- `memory/`: Gateway-side memory adapters and routes.
- `runtime/`: process lifecycle, recovery, locking, artifacts and resource arbitration.
- `security/`: authentication, cookies, origin checks, request policy and secret scanning.
- `monitoring/`: health, historical monitor data and dashboard notices.
- `config/`, `files/`: configuration adapters and file/archive utilities.

## Core source domains

- `engine/`: planning, execution loop, tool registry, model-client contracts and context/token budgets.
- `autonomy/`: autonomous supervisor, durable goal and ambient-decision orchestration.
- `tasks/`: durable task store, worker, retries and lineage coordination.
- `plugins/providers/`: provider interfaces, registry, adapters, local provider integration.
- `plugins/skills/`: bundled catalogue, skill manager and installer.
- `plugins/tools/`, `plugins/browser/`, `plugins/computer-use/`, `plugins/code-execution/`: supported tool integrations.
- `permissions/`, `control/`: permission governance and supported runtime control surfaces.
- `hooks/`, `observability/`, `services/`, `sessions/`, `messaging/`, `mcp/`, `self-improvement/`, `api/`: lifecycle and domain support.

## Identity and autonomy boundaries

`identity-prompt.ts` is the source of truth for interactive identity loading. It loads the configured identity documents and combines them with the current tool registry, capability state, autonomy status, persona configuration, and runtime contract. The live tool registry and permission gates always override descriptive documentation.

`AutonomousSupervisor` is host-side scheduling/orchestration. A model call is finite; the supervisor or durable worker initiates later calls. The ambient decision lane has narrower permissions than the tracked goal-execution lane. See [Always-active idle mode](always-active-idle-mode.md).

The Chat Top Bar is implemented by `packages/ui/frontend/src/features/chat/components/workspace/workspace-header.tsx` and the state/handlers passed from `packages/ui/frontend/src/pages/chat-page.tsx`. Global Gateway lifecycle controls live in `packages/ui/frontend/src/app/layout/global-header-actions.tsx`.

## Maintenance rules

1. Keep provider SDK and registry details behind `ProviderGateway`.
2. Keep persistent memory implementations in `packages/memory/`.
3. Keep reusable execution/governance logic in Core, transport/composition in Gateway, and presentation in UI.
4. Update public package exports when source/build paths move.
5. Treat runtime schemas, exact tool registrations, tests, and permission checks as authoritative; documentation cannot enable tools.
6. Keep historical audit reports as dated records and link them to current source/tests rather than rewriting historical observations.
7. Do not modify the bundled skill definitions when making identity/documentation improvements unless the task explicitly includes skill content.
