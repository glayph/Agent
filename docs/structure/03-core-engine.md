# 03 — packages/core (Agent Engine and Domain Runtime)

`@miki/core` owns reusable Agent execution, tools, permission governance, autonomous scheduling, durable goal/task logic, plugin integration and domain services. Gateway composes these capabilities into a running application.

## Main source domains

```text
packages/core/src/
├── api/                 # Core API composition/contracts
├── autonomy/            # AutonomousSupervisor and ambient/goal orchestration
├── control/             # Supported Agent control plane
├── engine/              # Planning, execution loop, tool registry, model client contracts
├── hooks/               # Lifecycle events and dispatch
├── mcp/                 # MCP contracts and integration
├── messaging/           # Message adaptation/formatting
├── observability/       # Metrics, errors and audit support
├── permissions/         # Permission policy and approval governance
├── plugins/             # Providers, skills, tools, browser and computer-use plugins
├── runtime-fetch/       # Runtime fetch/network helpers
├── self-improvement/    # Evaluated learning and change-management workflow
├── services/            # Reusable domain integrations
├── sessions/            # Session contracts/state
└── tasks/               # Durable task store, workers, retries and lineage
```

The plugin subtree includes provider adapters and the bundled skill subsystem. The exact inventory evolves; inspect the relevant package source and tests before adding a new module or relying on a path described in a dated report.

## Execution model

A meaningful request may be converted into an `AgentPlan`; the engine then executes eligible steps through the registered tool runtime. Depending on configuration, tool output can undergo semantic action verification, and durable task/run checkpoints support steering and recovery. A successful tool response is not always sufficient proof that the user-visible outcome is correct.

The model invocation itself is finite. `AutonomousSupervisor` is host-side scheduling/orchestration; durable goal/task workers execute eligible work on their own lifecycle. Ambient decisions and tracked goal execution have different tool sets and permissions. Read [Autonomous Execution](../AUTONOMOUS-EXECUTION.md) and [Always-active Idle Mode](../always-active-idle-mode.md) for details.

## Provider and memory boundaries

Provider registry and implementation code is under `packages/core/src/plugins/providers/`. Agent-facing calls are mediated by `ProviderGateway` in `packages/gateway/src/providers/`; Agent runtime code must not directly instantiate provider SDK clients.

Persistent memory implementations belong to `packages/memory/`, not a parallel Core memory engine. Core uses the public package boundary.

## Maintenance rules

- Add reusable execution/governance logic to the owning Core domain.
- Keep ingress, session transport, and application composition in Gateway.
- Use typed tool schemas and the live permission system; never invent capability from persona wording.
- Preserve host/guest isolation, audit events, authorization and approval checks.
- Add or update tests with behavior changes; architecture docs alone do not validate an integration.
