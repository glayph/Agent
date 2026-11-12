# 05 — Gateway, Config and Skill Installer Ownership

## packages/gateway

The Gateway is the application composition root and primary web backend. It owns HTTP/WebSocket routes, the Agent runtime, chat turns, channel integration, provider boundary, health, monitoring, runtime process services, file routes and security policy.

```text
packages/gateway/src/
├── agent/       # Agent runtime, identity prompt/file loading, feedback
├── channels/    # Channel adapters, session lanes and delivery
├── chat/        # Chat turn lifecycle, streaming, attachments and media
├── config/      # Gateway configuration adapters
├── files/       # File/archive operations
├── memory/      # Memory adapters and routes
├── monitoring/  # Health, run traces and operator notifications
├── plugins/     # Plugin marketplace/MCP routes and tool bridges
├── providers/   # Agent-facing ProviderGateway boundary
├── runtime/     # Process lifecycle, recovery, locks and run artifacts
├── security/    # Authentication, origin/cookie policy and secret scanning
└── tools/       # Tool registration/grouping and serialization adapters
```

`packages/gateway/src/index.ts` composes application startup and `packages/gateway/src/agent/agent-runtime.ts` constructs the interactive Agent runtime. Identity files are loaded by `agent/identity-prompt.ts`; the exact file order and permission model are documented in [the operating model](../AGENT_MIKI_OPERATING_MODEL.md).

## packages/config

`@miki/config` is the shared foundation for configuration values and schemas, environment compatibility, default-model resolution, security helpers and secret-vault access. It defines contracts; Gateway/Core own their runtime consumers.

## Skill installer is Core-owned

This checkout does **not** contain a separate `packages/installer` workspace. Skill catalogue, runtime discovery/manager, governance integration and installer implementation live under `packages/core/src/plugins/skills/`. The root build compiles/validates the Core-owned implementation. This document describes package ownership only and does not authorize changing bundled skill content.

## Reliability and recovery

Gateway and host supervisor services include bounded health probes, durable delivery/replay, run artifact collection and process recovery paths. Their effective behavior depends on runtime flags, database state, provider access and process health. Use `/gateway/health`, `/gateway/live`, `/api/monitor/*`, and `/api/autonomy/status` as supported by the running version. A green process health check is not proof that a particular task is progressing; inspect its run/goal trace.
