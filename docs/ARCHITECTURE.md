# Miki Architecture and Module Boundaries

## Runtime communication

The Gateway package is the application composition root. The Agent runtime is created by
`packages/gateway/src/agent/agent-runtime.ts`, while the HTTP/WebSocket server and process
startup remain in `packages/gateway/src/index.ts`.

Model providers have one Agent-facing entry point:

```text
Agent runtime
    |
    v
packages/gateway/src/providers/ProviderGateway
    |
    v
packages/core/src/plugins/providers/ProviderRegistry
    |
    v
provider adapters / built-in provider plugins / local llama.cpp runtime
```

`AgentRuntime` must not import `providerRegistry`, provider SDK implementations, or transport
factories directly. It asks `ProviderGateway` to create an `EngineLLMClient`, determine whether
a provider is local, and resolve provider credential failover candidates. The gateway owns
transport selection and keeps registry/plugin details private to the provider boundary.

The HTTP model-settings and health endpoints may perform provider probes for administration;
Agent inference and local-provider lifecycle changes go through `ProviderGateway`.

## Package responsibility

```text
packages/
├── gateway/       Application composition, HTTP/WS, Agent runtime, runtime services
├── core/          Agent engine, plugin contracts, tools, governance and core services
├── memory/        Canonical persistent memory and retrieval system
├── config/        Shared config schemas, validation, secrets and vault adapters
├── skills/        Bundled skill catalogue and metadata
├── installer/     Skill/plugin package installation contracts
├── cli/           Command-line client
└── ui/            Frontend and desktop/backend UI integration
```

The intended dependency direction is:

```text
UI / CLI / channels
        |
        v
     Gateway
        |
        +------> Core
        +------> Memory
        +------> Config / Skills / Installer
```

Core modules do not import the Gateway package. The Gateway supplies runtime dependencies to
Core through typed interfaces and service objects.

## Gateway source domains

`packages/gateway/src/index.ts` is kept as the composition root. Other files are grouped by
responsibility:

- `agent/`: Agent runtime, identity prompt, feedback, learned behavior and supervision.
- `providers/`: the Agent-to-provider gateway plus model resolution, retry and provider errors.
- `chat/`: chat turn handling, attachments, media, streaming and message traces.
- `channels/`: channel runtime, session lanes, outbound delivery and webhook ingress.
- `tools/`: tool naming, grouping, terminal tools, result presentation and tool wire formats.
- `plugins/`: marketplace plugin management and MCP proxy routes.
- `memory/`: memory indexing, ranking and governance.
- `runtime/`: process lifecycle, recovery, locking, resource arbitration and run artifacts.
- `security/`: authentication, cookies, origin checks, request policy and secret scanning.
- `monitoring/`: health, monitor history, dashboard extensions and user-facing notices.
- `config/`, `files/`: Gateway configuration adapters and archive/file helpers.

## Core source domains

- `engine/`: planning, Agent execution loop, tool registry, LLM client contracts and token budgets.
- `plugins/providers/`: provider registry, SDK/plugin contracts, adapters and local llama.cpp runtime.
- `tasks/`: durable task state, store, worker, retry classification and lineage coordinator.
- `plugins/skills/`: bundled skill catalog, runtime skills manager, and installer implementation in one core-owned plugin module.
- `messaging/`, `sessions/`: message formatting/adaptation and persisted session history.
- `observability/`: audit log, error handler and metrics collection.
- `services/`: web search and speech-to-text integrations.
- `hooks/`, `control/`, `permissions/`, `autonomy/`, `self-improvement/`, `api/`, `mcp/`:
  lifecycle events, control plane, permission governance, autonomous supervision, API routing
  and external-tool connectivity.

## Maintenance rules

1. Add new provider implementations under `packages/core/src/plugins/providers/`; do not let
   Agent runtime files instantiate provider adapters directly.
2. Add new Agent-facing provider behavior to `ProviderGateway`, not to `AgentEngine`.
3. Keep network/API ingress in Gateway and reusable business/domain logic in Core or its
   dedicated package.
4. Keep the complete memory implementation (TKG, file-backed notes, compaction, and memory tools) under `packages/memory/`; Core and Gateway consume it through package exports.
5. Add new files to the domain folder that owns their lifecycle; avoid returning to flat
   `gateway/src` or `core/src` directories.
6. Keep public package subpath exports in sync when a module's output path changes.

The Core build runs `scripts/build-skill-catalog.mjs` after TypeScript compilation to copy non-code skill assets into `packages/core/dist/plugins/skills/catalog/`.
