# Miki Project Structure Index

This directory documents the current repository layout as represented by the supplied source tree. It is a navigation aid, not a runtime manifest; `package.json`, workspace package manifests, source code, and tests are authoritative.

## Agent operating references

- [Agent-Miki Operating Model](../AGENT_MIKI_OPERATING_MODEL.md): identity loading, capability discovery, execution lifecycle, autonomy lanes and safety boundaries.
- [Autonomous Execution](../AUTONOMOUS-EXECUTION.md): durable run lifecycle, task steering and recovery.
- [Always-active Idle Mode](../always-active-idle-mode.md): ambient supervisor lifecycle and live status.
- [Upgrade TODO](../MIKI_AGENT_AND_CHAT_TOPBAR_UPGRADE_TODO.md): current implementation checklist.

## Structure guides

| File | Scope |
|---|---|
| [01-root-and-top-level.md](01-root-and-top-level.md) | Root configuration, bin, config, deployment, docs and scripts |
| [02-packages-overview.md](02-packages-overview.md) | Actual workspace packages and dependency direction |
| [03-core-engine.md](03-core-engine.md) | Core engine, autonomy, tasks, plugins, permissions and tools |
| [04-memory.md](04-memory.md) | Persistent memory package and interfaces |
| [05-gateway-config-installer.md](05-gateway-config-installer.md) | Gateway, shared config and Core-owned skill installer |
| [06-cli-skills.md](06-cli-skills.md) | CLI and bundled skill subsystem location |
| [07-ui-dashboard.md](07-ui-dashboard.md) | React dashboard, Chat Top Bar and legacy compatibility layer |
| [08-build-and-ci.md](08-build-and-ci.md) | Build/test scripts, root tooling and CI |

## Current top-level layout

```text
.
├── bin/                 # Runtime launchers and diagnostics
├── config/              # Agent persona, tools policy and environment template
├── deploy/              # Linux, Windows, reverse-proxy and firewall examples
├── docs/                # Architecture, operations, audits and structure guides
├── identity/            # Agent-Miki identity and specialist profile Markdown
├── packages/
│   ├── cli/             # TypeScript CLI and lifecycle dashboard
│   ├── config/          # Shared configuration/security contracts
│   ├── core/            # Agent engine, tools, autonomy, plugins and tasks
│   ├── gateway/         # HTTP/WS server and Agent runtime composition
│   ├── memory/          # Persistent TKG and file-memory systems
│   └── ui/              # React dashboard and legacy Go compatibility sources
├── scripts/             # Build, test, runtime, release and verification scripts
├── package.json         # npm workspace scripts and package orchestration
├── package-lock.json    # Canonical npm lockfile
└── pnpm-lock.yaml       # Retained repository lock/config support; not the root npm lock
```

There is no separate `packages/skills/` or `packages/installer/` workspace in this project snapshot. The bundled skill catalogue and installer are under `packages/core/src/plugins/skills/`. Do not use historical package diagrams as a substitute for the current filesystem.
