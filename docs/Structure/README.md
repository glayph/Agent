# Project Structure — @hiro

This directory contains a chunked breakdown of the entire project structure.

| File | Covers |
|---|---|
| [Root](Root.md) | Top-level files and directories (`.devin`, `.github`, `bin/`, `config/`, `data/`, `docs/`, `promlem-lists/`, `src/skills/`, root config files) |
| [Core](Core.md) | `packages/core/` — agent engine, API, tools, channels, safety, plugins, self-improvement |
| [Config](Config.md) | `packages/config/` — shared configuration, schema, security, secret vault |
| [Gateway](Gateway.md) | `packages/gateway/` — Express reverse proxy, LiteLLM supervisor, MCP proxy |
| [Installer](Installer.md) | `packages/installer/` — multi-source skill installer |
| [Memory](Memory.md) | `packages/Hiro-memory/` — GraphRAG memory server |
| [Skills](Skills.md) | `packages/skills/` — bundled skill catalog |
| [UI](UI.md) | `packages/ui/` — React frontend + Go backend |
| [CLI](CLI.md) | `packages/Hiro-cli/` — Go terminal UI |
| [Scripts](Scripts.md) | `scripts/` — build and release automation |

