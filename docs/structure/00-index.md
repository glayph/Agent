# Miki Project Structure Index

This directory contains annotated file-tree documentation for the complete Miki codebase (Agent-1.3.7-offline).

Reading these files in order provides a deep structural understanding of the monorepo without needing to open every source file.

## Chunks

| File | Scope |
|------|--------|
| [00-index.md](00-index.md) | This index |
| [01-root-and-top-level.md](01-root-and-top-level.md) | Root files, bin/, config/, deploy/, docs/, scripts/, providers/ |
| [02-packages-overview.md](02-packages-overview.md) | packages/ top-level overview and inter-package relationships |
| [03-core-engine.md](03-core-engine.md) | packages/core — agent engine, plugins, tools, autonomy, LLM |
| [04-memory.md](04-memory.md) | packages/memory — Temporal Knowledge Graph and related modules |
| [05-gateway-config-installer.md](05-gateway-config-installer.md) | packages/gateway, packages/config, packages/installer |
| [06-cli-skills.md](06-cli-skills.md) | packages/cli and packages/skills |
| [07-ui-dashboard.md](07-ui-dashboard.md) | packages/ui — frontend dashboard + backend |
| [08-build-and-ci.md](08-build-and-ci.md) | scripts/, .github/, test configs, build tooling |

## High-level layout

```
Agent-1.3.7-offline/
├── bin/                 # Runtime entry points (miki, doctor, config)
├── config/              # agent.yaml, tools.yaml — primary runtime config
├── deploy/              # Linux systemd, Windows PS1, nginx, firewall examples
├── docs/                # Documentation (including this structure/)
├── packages/
│   ├── cli/             # Self-contained `miki` CLI + Go TUI
│   ├── config/          # Shared settings, schema, security, types
│   ├── core/            # Main agent engine (largest package)
│   ├── gateway/         # Express HTTP/WS gateway
│   ├── installer/       # Workspace registration helpers
│   ├── memory/          # Temporal Knowledge Graph + consolidation
│   ├── skills/          # Pre-bundled skills
│   └── ui/              # React web dashboard + Go backend
├── providers/           # Example external provider plugin
├── scripts/             # Build, model, verify, release, soak scripts
└── (root configs)       # package.json, tsconfig, jest, eslint, turbo, locks
```

Total approximate size of source tree: ~3000 files, ~340 directories.
