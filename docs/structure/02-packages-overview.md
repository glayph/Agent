# 02 — Workspace Packages Overview

The actual npm workspaces in this source snapshot are `cli`, `config`, `core`, `gateway`, `memory`, and `ui`. The root `package.json` and package manifests are the authoritative workspace list.

```text
packages/
├── cli/       # CLI, gateway lifecycle controller and terminal dashboard
├── config/    # Shared config, schema, security and secret-vault contracts
├── core/      # Agent engine, tasks, tools, plugins, permission governance and autonomy
├── gateway/   # HTTP/WS composition, Agent runtime, channels and monitoring
├── memory/    # Persistent Temporal Knowledge Graph and file-backed notes
└── ui/        # React frontend plus legacy Go compatibility sources
```

There is no standalone `packages/skills/` or `packages/installer/` workspace in this checkout. The bundled skill catalogue, runtime manager, governance and installer live together under `packages/core/src/plugins/skills/`. Skill documentation/definitions are intentionally not part of persona upgrades.

## Simplified dependency direction

```text
UI / CLI / channel integrations
              |
              v
           Gateway
           /  |  \
          v   v   v
        Core Memory Config
          |
          v
  Provider / tool / plugin contracts
```

- **config** provides shared settings, schema validation, environment compatibility, security helpers and vault integration.
- **core** owns reusable planning/execution, task and goal logic, tool/plugin contracts, permission governance, autonomous supervision and domain services.
- **gateway** owns app composition, HTTP/WebSocket ingress, Agent runtime construction, chat/channels, provider boundary, health and monitoring.
- **memory** owns persistent TKG and file-memory implementations; Core/Gateway consume them through package exports.
- **ui** is the operator-facing React dashboard and associated legacy compatibility sources.
- **cli** starts/manages the runtime and packages the supported command-line distribution.

## Build and runtime notes

Use the root `npm run build:all` pipeline for the supported full build. It runs contract/native checks and workspace builds in the declared order. The CLI distribution is assembled from built workspace artifacts; do not assume source-only execution will provide every runtime file.

Version strings and release artifact labels can differ across packages. For an installed release version, read the package manifests or generated release metadata rather than relying on an old structure note.
