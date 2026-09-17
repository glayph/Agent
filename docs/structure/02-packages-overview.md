# 02 — Packages Overview

The monorepo is organized under `packages/`. Each package has its own `package.json`, TypeScript config (where applicable), and is referenced from the root workspaces.

```
packages/
├── cli/           # Self-contained CLI + Go terminal UI
├── config/        # Shared configuration, types, security utilities
├── core/          # Agent engine (planner, tools, plugins, autonomy, LLM)
├── gateway/       # Express-based HTTP / WebSocket gateway
├── installer/     # Workspace registration and installation helpers
├── memory/        # Temporal Knowledge Graph & memory consolidation
├── skills/        # Pre-bundled skills and skill loading
└── ui/            # Web dashboard (React frontend + Go backend)
```

## Dependency flow (simplified)

```
ui / cli
    ↓
gateway  ←→  core  ←→  memory
    ↑           ↑
    └── config ─┘
         ↑
    installer / skills
```

- **config** is the foundation: settings, schema validation, secret vault, security helpers.
- **core** is the largest and most complex package; it imports config, memory, and hosts the plugin system.
- **gateway** proxies traffic to core and serves the static UI.
- **cli** packages a complete runtime and launches everything with a single `miki` command.
- **memory** can run as a long-lived process (consolidation daemon) and is integrated into core.
- **skills** supplies loadable skill definitions used by the skill governance engine inside core.
- **ui** is the operator-facing dashboard (Chat UI, models, logs, health, skills, memory views).

## Versioning notes

Root `package.json` reports version 1.3.6 in this tree; the distribution name is Agent-1.3.7-offline. Individual packages mostly use 1.0.0 / 2.0.0 internally for the workspace packages.
