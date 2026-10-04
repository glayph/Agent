# Miki

**Local-first autonomous AI agent**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Version](https://img.shields.io/badge/version-1.3.14-informational.svg)](https://github.com/glayph/Agent)
[![Platform](https://img.shields.io/badge/platform-Linux%20%7C%20Windows-lightgrey.svg)](https://github.com/glayph/Agent)

> Run a capable agent on your machine — plan, call tools, manage files, remember context — with a real dashboard, local models, and clear approval gates.

---

## Overview

Miki is a **local-first** monorepo agent runtime. It combines:

- A **React dashboard** (chat, models, files, control)
- An **Express gateway** (HTTP + WebSocket, auth, static UI)
- A **TypeScript core engine** (observe → plan → tool loop → answer)
- **Local GGUF** models via vendored llama.cpp and optional **cloud/API** providers
- **Fully local memory** (Temporal Knowledge Graph + file memory)
- **Safe file/Drive tools** and gated script execution

It solves the gap between “chat-only” assistants and brittle scripts: one process that can plan multi-step work, request approval for risky actions, and keep durable local state without shipping your data to a third-party host by default.

---

## Key Features

- **Agent loop** — Plan → model turns → tool calls → results → limits/cancel, with structured events over WebSocket
- **Approval gates** — Risky tools and control operations require explicit approval (expiry, single-use, input-bound)
- **File / Drive manager** — Upload, download, preview (Range), copy/move, conflict-aware writes, protected-path policy
- **Script runner** — `POST /api/files/run` with allowlisted env, timeout, output cap, process-group kill (kill switch: `MIKI_FILE_EXECUTION=false`)
- **Local + cloud models** — llama-server for GGUF; OpenAI-compatible cloud paths when configured
- **Local memory** — Temporal Knowledge Graph and file-backed memory under `identity/` / data dir
- **Skills** — Bundled skills catalog under `@miki/skills`
- **Cross-platform builds** — Linux x64/arm64 and Windows x64 via GitHub Actions
- **Single-session Chat UI** — One dashboard session; control and agent APIs behind session or API key

---

## Tech Stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js ≥ 20 (engines pin 20.19+ / 22.13+ / ≥24 for gateway) |
| Language | TypeScript 5.9, ESM workspaces |
| Gateway | Express, `ws`, better-sqlite3 |
| UI | React (Vite) dashboard under `packages/ui/frontend` |
| Core | Agent engine, tool registry, planner, approvals, file-manager |
| Memory | `@miki/memory` — local TKG + file memory |
| Local LLM | Vendored llama.cpp → headless `llama-server` |
| Build | npm workspaces, Turbo, Jest, ESLint |
| Deploy | systemd / Windows scripts under `deploy/` |

---

## Getting Started

### Prerequisites

- **Node.js** ≥ 20
- **npm** (or pnpm for workspace tooling)
- Optional: **Go** and platform toolchains for full offline/native builds (see CI workflows)
- Optional: GGUF model path for local inference

### Installation

```bash
git clone https://github.com/glayph/Agent.git
cd Agent
npm install
```

Copy environment defaults and adjust:

```bash
cp .env.example .env
# Set dashboard password, data dir, model defaults as needed
```

### Build

```bash
npm run build          # full monorepo build (llama, packages, frontend, CLI)
# or targeted:
npm run build:frontend
npm run build --workspace=@miki/core
npm run build --workspace=@miki/gateway
```

### Run

```bash
npm start              # production-style launcher (bin/miki.js)
npm run dev            # development launcher
```

Dashboard defaults to **http://127.0.0.1:18800** (see `.env.example`).  
When a dashboard password is set, session auth protects control and agent surfaces.

### Useful commands

| Command | Purpose |
| --- | --- |
| `npm start` / `npm run dev` | Start gateway + UI |
| `npm run model:list` / `model:install` / `model:status` | Local model management |
| `npm run smoke:agent-core` | Agent engine smoke |
| `npm run test:files` | File manager / runner tests |
| `npm run verify` | Project verification script |
| `npm run build:release:linux` / `build:release:windows` | Offline release artifacts |

Full install and doctor flows are documented in [`SETUP.md`](SETUP.md).

---

## Project Structure

```text
.
├── bin/                 # Launcher (miki.js)
├── config/              # agent.yaml, tools.yaml
├── deploy/              # systemd, Windows, reverse-proxy, firewall
├── docs/                # AGENT_ENGINE.md, FILES_DRIVE.md, …
├── identity/            # SOUL, IDENTITY, memory, agents notes
├── packages/
│   ├── cli/             # Self-contained miki CLI package
│   ├── config/          # Shared config package
│   ├── core/            # Engine, API, tools, providers, file-manager
│   ├── gateway/         # Express + WS, agent-runtime
│   ├── installer/       # Install helpers
│   ├── memory/          # Local TKG & memory services
│   ├── skills/          # Bundled skills
│   └── ui/              # Dashboard (frontend + backend helpers)
├── scripts/             # Build, model, soak, verify utilities
├── package.json         # Workspace root (version 1.3.14)
└── workflow.json        # Workflow manifest
```

Engine details: [`docs/AGENT_ENGINE.md`](docs/AGENT_ENGINE.md)  
Files / Drive: [`docs/FILES_DRIVE.md`](docs/FILES_DRIVE.md)

---

## Screenshots & Demo

> Add product screenshots under `docs/` or `packages/ui/` and reference them here.

```markdown
![Dashboard chat](docs/screenshots/chat-ui.png)
![File manager](docs/screenshots/files-drive.png)
```

Architectural flow (engine):

```text
Observe → Plan → [ model turn → tool calls → results ]* → Verify/limits → Answer
```

---

## Configuration

Primary knobs live in `.env` / `.env.example` and `config/agent.yaml`.

| Variable | Role |
| --- | --- |
| `MIKI_DATA_DIR` | Override gateway data directory |
| `MIKI_FILE_EXECUTION` | Kill switch for script runner (`false` disables) |
| `MIKI_AGENT_MAX_TURNS` / `MIKI_AGENT_MAX_TOOL_CALLS` | Agent loop budgets |
| `DEFAULT_MODEL` | Default provider model id |
| `ENABLE_API_KEY_AUTH` / `API_KEY_SECRET` | Non-dashboard API protection |
| `MIKI_ALLOWED_ORIGINS` | CORS allowlist for the dashboard origin |

---

## Contributing

1. Fork and branch from `main`.
2. Keep changes focused; prefer tests next to engine/file code (`packages/core/src/engine/`).
3. Run `npm run verify` / targeted package tests before opening a PR.
4. Document user-facing behavior in `docs/` (Markdown only under `docs/`).

CI builds and verifies on Linux x64, Linux arm64, and Windows x64 (see `.github/workflows/`).

---

## License

MIT — see `package.json` (`"license": "MIT"`).  
Add a root `LICENSE` file if you redistribute binaries and need the full text checked into the tree.

---

## Links

- **Repository:** [https://github.com/glayph/Agent](https://github.com/glayph/Agent)
- **Setup guide:** [SETUP.md](SETUP.md)
- **Agent engine:** [docs/AGENT_ENGINE.md](docs/AGENT_ENGINE.md)
- **Files / Drive:** [docs/FILES_DRIVE.md](docs/FILES_DRIVE.md)
