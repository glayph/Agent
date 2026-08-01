<div align="center">

# 🤖 Hiro

### An autonomous AI agent with full computer control

[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Node](https://img.shields.io/badge/Node.js-20.19+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)
[![version](https://img.shields.io/badge/version-0.1.0-blue.svg?style=for-the-badge)]()
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=for-the-badge)]()

<br/>

Hiro pairs a **self-hosted agent engine** with direct LLM providers (Gemini / OpenRouter / OpenAI),
a **React web dashboard**, a **Go launcher binary**, and a **graph-based memory system**.

It can read, write, and delete files, run shell commands, drive a browser, automate a
Windows desktop, talk to messaging platforms, and manage its own skills and memory.

</div>

---

## 🧭 A Note on Names

The project is **Hiro**, the default agent persona is **Miki**, and the runtime binaries are
aliased as `hiro`, `Hiro`, `mikiagent`, `MikiAgent`, `agent`, and `Agent`.

> ⚠️ **Warning:** this project is designed to run with **full system access**. Review the
> configuration and tool permissions (`config/agent.yaml`, `config/tools.yaml`) before running
> it on a machine you care about.

---

## 📑 Table of Contents

<details open>
<summary>Jump to a section</summary>

- [✨ Features](#-features)
- [🏗️ Architecture](#️-architecture)
- [📦 Repository Structure](#-repository-structure)
- [🧰 Prerequisites](#-prerequisites)
- [🚀 Getting Started](#-getting-started)
- [⚙️ Configuration](#️-configuration)
- [🖥️ Web Dashboard](#️-web-dashboard)
- [⌨️ Command-Line Interface](#️-command-line-interface)
- [🛠️ Agent Tools](#️-agent-tools)
- [📡 Channels](#-channels)
- [🧠 Memory System](#-memory-system)
- [🎓 Skills](#-skills)
- [🧪 Testing & Verification](#-testing--verification)
- [📜 npm Scripts](#-npm-scripts)
- [🔌 Ports](#-ports)
- [🩺 Troubleshooting](#-troubleshooting)
- [📄 License](#-license)

</details>

---

## ✨ Features

- 🧠 **Agent runtime** — turn-based orchestration loop with tool calling, message history,
  token/context budgeting, and configurable resource profiles (`eco`, `balanced`, `performance`).
- 🔀 **Multi-agent routing** — a router classifies tasks and can dispatch to specialist agents
  (`general`, `engineer`, `researcher`, `planner`, `miki`), with delegation, a message bus, a
  shared blackboard, and result aggregation.
- 🛠️ **40+ tools** — shell execution, file read/write/delete, Playwright-based browser
  automation, Windows desktop automation (UI Automation locators), web scraping, web search,
  model management, and project workflow creation.
- 💬 **15 messaging channels** — Telegram, Discord, Slack, Feishu, DingTalk, QQ, WeChat
  (Weixin), WeCom, Line, OneBot, WhatsApp, Hiro, Matrix, IRC, and MQTT adapters.
- 🕸️ **Temporal graph memory** — a GraphRAG-style memory server with episodic/semantic/procedural
  tiers, hybrid vector + BM25 search, time-decay relevance, and a visual dashboard.
- 🖥️ **Web dashboard** — a React SPA (chat, models, credentials, channels, skills, tools, config,
  logs) served by a Go launcher backend with password login.
- 🧩 **Skill system** — bundled skill catalog plus an installer that supports Clawhub, npm, git,
  and local skill sources.
- 🛡️ **Safety & governance** — audit logging, startup doctor checks, a watchdog, secret scanning,
  backups, safe-mode fallback, skill governance, and a self-improvement engine.
- 🚪 **Self-hosted gateway** — an Express gateway that supervises the core agent process, with
  health monitoring, automatic restarts, WebSocket relay, rate limiting, and log rotation.
- 🔗 **MCP support** — a Model Context Protocol server (Streamable HTTP) that exposes agent tools
  when enabled.

---

## 🏗️ Architecture

```text
                       ┌────────────────────────────────────────────────┐
                       │  Browser / Dashboard / CLI / Channels          │
                       └──────────────┬─────────────────────────────────┘
                                      │  HTTP + WebSocket
                              ┌───────▼────────┐        ┌──────────────────┐
                              │  Gateway       │        │  Memory server   │
                              │ (@hiro/gateway)│       │ (graphrag-memory)│
                              │  port 18800    │        │  port 3777       │
                              └───────┬────────┘        └───────┬──────────┘
                                      │ proxy                  │
                              ┌───────▼────────┐               │
                              │  Core agent    │───────────────┘
                              │  (@hiro/core)  │  memory bridge
                              │  port 8000     │
                              └───────┬────────┘
                                      │ direct OpenAI-compatible calls
                              ┌───────▼────────┐
                              │  LLM provider  │
                              │  Gemini /      │
                              │  OpenRouter /  │
                              │  OpenAI        │
                              └────────────────┘
```

The launcher/dashboard (`packages/ui`, Go + React) and the gateway both listen on port `18800`.
The gateway spawns the core agent as a child process, and the core agent talks directly to
Gemini / OpenRouter / OpenAI for model access and to the memory server on port `3777` for
long-term memory.

---

## 📦 Repository Structure

| Path | Package | Purpose |
|------|---------|---------|
| `packages/core/` | `@hiro/core` | Agent engine — orchestrator, tools, channels, API, safety, self-improvement, MCP |
| `packages/gateway/` | `@hiro/gateway` | Express gateway — reverse proxy, WebSocket relay, rate limiting |
| `packages/config/` | `@hiro/config` | Shared configuration, schema, security helpers, secret vault |
| `packages/memory/` | `graphrag-memory` | Temporal Knowledge Graph memory server + dashboard |
| `packages/skills/` | `@hiro/skills` | Pre-bundled skill catalog |
| `packages/installer/` | `@hiro/installer` | Skill installer (Clawhub, npm, git, local sources) |
| `packages/ui/` | — | React frontend + Go launcher backend |
| `packages/cli/` | `@hiro/cli` | Go terminal UI + npm CLI entry point |
| `bin/` | — | Runtime entry points (`Hiro.js`, `Agent.js`, doctor, PowerShell supervisor) |
| `config/` | — | `agent.yaml`, `tools.yaml` |
| `scripts/` | — | Build, release, and verification automation |
| `docs/` | — | Structure breakdown and troubleshooting matrix |

---

## 🧰 Prerequisites

| Dependency | Version / Requirement | Notes |
|------------|----------------------|-------|
| **Node.js** | `^20.19.0 \|\| ^22.13.0 \|\| >=24` | npm 10.8.2 |
| **Go** | optional | only to build the CLI / Go backend from source |
| **pnpm** | via Corepack | used for the web UI build; headless agent works without it |

---

## 🚀 Getting Started

### 1️⃣ Install JavaScript dependencies

```bash
npm ci --no-audit --no-fund
```

This installs every workspace package and third-party dependency. The root `allowScripts`
setting permits the `better-sqlite3` native rebuild.

### 2️⃣ Install Python dependencies (optional, skill-only)

```bash
python -m pip install --user -r requirements.txt
```

LLM calls go directly to Gemini / OpenRouter / OpenAI, so no Python gateway is required. The
remaining entries in `requirements.txt` are optional skill-only packages (matplotlib, numpy,
arxiv, etc.).

### 3️⃣ Create and configure `.env`

```bash
Copy-Item .env.example .env
```

Edit `.env` and set at minimum:

- `GEMINI_API_KEY` (or `OPENAI_API_KEY` / `OPENROUTER_API_KEY`) — the agent cannot serve models without one

Keys can also be set from the dashboard Models/Credentials pages or the CLI
(`mikiagent config set GEMINI_API_KEY <your-key>`); they are stored in your user profile secret
vault.

### 4️⃣ Build

```bash
npm run build:all   # turbo build of all TypeScript packages
npm run build       # build release artifacts (runtime, web UI, Go binaries)
```

### 5️⃣ Run

```bash
npm start
```

- 🖥️ Web dashboard: `http://127.0.0.1:18800`

For development with live rebuilds, use `npm run dev`.

### 6️⃣ Optional extras

```bash
npx playwright install   # browser binaries, only needed for browser/crawler tools
```

---

## ⚙️ Configuration

Configuration lives in three YAML files under `config/`:

| File | Purpose |
|------|---------|
| `agent.yaml` | Agent name/persona, resource profiles, browser settings, memory, heartbeat, concurrency, self-improvement, skill governance, specialist agents, channel list |
| `tools.yaml` | Per-tool permission model (access level, timeouts, output caps, workspace restrictions) and web-search providers |

Runtime settings such as ports and API keys are read from `.env`:

| Variable | Purpose |
|----------|---------|
| `CORE_HOST` / `CORE_PORT` | Core agent API (default `127.0.0.1:8000`) |
| `GATEWAY_HOST` / `GATEWAY_PORT` | Gateway / dashboard (default `127.0.0.1:18800`) |
| `GEMINI_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | Direct provider API keys |
| `DEFAULT_MODEL` | Default model name (e.g. `google/gemini-2.0-flash-001`) |
| `ENABLE_API_KEY_AUTH` / `API_KEY_SECRET` | API-key protection for non-dashboard APIs |
| `ENABLE_MCP` | Enables the MCP server |
| `Hiro_ALLOWED_ORIGINS` | CORS allowlist for the dashboard |

---

## 🖥️ Web Dashboard

The dashboard (`packages/ui`) is a Vite + React 19 + TanStack Router SPA served by a Go backend
launcher on `http://127.0.0.1:18800`. It supports **English** and **Simplified Chinese**, plus
**light** and **dark** themes.

| Route | Purpose |
|-------|---------|
| `/` | Chat UI with session history and model selection |
| `/models` | Add, edit, delete, and set the default model |
| `/credentials` | Manage provider credentials |
| `/channels/*` | Configure channels from a shared catalog |
| `/agent/skills` | Browse and import skills |
| `/agent/tools` | View and toggle tool availability |
| `/config` | Edit agent defaults, self-evolution, exec/cron controls, heartbeat, and launch settings |
| `/logs` | View the in-memory gateway log buffer |
| `/launcher-setup` / `/launcher-login` | Create and use the dashboard password |

The launcher manages the Hiro subprocess: it can auto-start or attach to the gateway, captures
stdout/stderr into a ring buffer, and tracks gateway state. It only allows gateway startup when
a valid default model is configured.

---

## ⌨️ Command-Line Interface

The Go CLI (`packages/cli`) ships a Bubble Tea terminal UI plus an `agent.js` npm entry point:

```bash
agent start       # start the dashboard and agent runtime
agent doctor      # run system diagnostics and health checks
agent install     # install (npm package mode)
agent uninstall   # uninstall from system
agent version     # show version and build information
agent help        # show help
```

`bin/owlclaw-doctor.mjs` performs deeper runtime checks (Node/npm/Go versions, runtime files,
writable directories, config validation, SQLite writability, secret-vault status, provider API
key presence, npm audit).

---

## 🛠️ Agent Tools

The tool registry in `packages/core/src/tools/` wires 40+ handlers:

| Group | Tools |
|-------|-------|
| 🖥️ Shell | `shell_execute` |
| 📁 File | `file_read`, `file_write`, `file_delete` |
| 🌐 Browser (Playwright) | `browser_navigate`, `browser_click`, `browser_type`, `browser_invoke`, `browser_fill`, `browser_press`, `browser_extract`, `browser_screenshot`, `browser_scroll`, `browser_close` |
| 🖱️ Computer (Windows automation) | `computer_observe`, `computer_focus`, `computer_invoke`, `computer_set_text`, `computer_hotkey`, `computer_clipboard`, `computer_launch`, `computer_verify`, `computer_screenshot`, `computer_list_processes`, `computer_get_system_info`, `computer_list_displays`, `computer_click_at`, `computer_drag`, `computer_scroll`, `computer_terminate_app`, `computer_list_windows`, `computer_grid_screenshot` |
| 📋 Scraping | `scrape_page`, `scrape_selectors`, `scrape_paginated`, `scrape_infinite_scroll`, `scrape_json`, `scrape_table` |
| 🧮 Models | `model_list`, `model_add`, `model_delete`, `model_select` |
| 🔍 Other | `web_search`, `direct_download_search`, `project_workflow_create` |

Tool permissions are enforced from `config/tools.yaml` (access level, workspace-only constraints,
timeouts, and output caps). The browser tool rejects `javascript:`, `data:`, and `file:` URLs
and rotates user agents.

---

## 📡 Channels

Channel adapters live in `packages/core/src/channels/`. The config enables 15 channels:

```
telegram · discord · slack · feishu · dingtalk · qq
weixin · wecom · line · onebot · whatsapp · hiro
matrix · irc · mqtt
```

Webhook routers are mounted for Line, WhatsApp, Feishu, DingTalk, and QQ. The core API also
exposes a WebSocket chat relay (`/ws/chat`, `/hiro/ws`) used by the web chat and Hiro channel.

---

## 🧠 Memory System

`packages/memory` (`graphrag-memory` v2.0.0) is a Temporal Knowledge Graph & event-driven
memory server:

- 🧬 **Three-tier memory** — episodic, semantic, and procedural
- 🔎 **Hybrid search** — pure-JS TF-IDF cosine similarity + BM25, combined with graph and temporal relevance
- ⏳ **Temporal awareness** — exponential time-decay scoring, validity windows, event supersession
- 🧪 **TKG v2 engine** — event stream, working-memory anchors, special-event highlighting, and a memory-consolidation daemon
- 🌐 **HTTP API** — classic v1 CRUD/search/context endpoints plus `/api/v2/*` event, anchor, entity, relation, query, context, and consolidate endpoints
- 📊 **Web dashboard** — force-directed graph canvas and timeline charts at `http://localhost:3777`

The core agent reads memory context before LLM calls and writes interactions back through the
memory bridge (`packages/core/src/memory/`). A `data/agent-memory.db` SQLite database stores
the data.

---

## 🎓 Skills

Bundled skills (`packages/skills`) span five categories:

| Category | Skills |
|----------|--------|
| `ai-collaboration` | 18 skills (accessibility, concise-prompt, css-styling, frontend-frameworks, html-semantic, javascript, memory-management, rag-context, responsive-design, semantic-summarization, skills-creator, skills-finder, skills-use, structured-output, testing-debugging, user-centered-design, visual-design, wireframing) |
| `github` | 6 skills (codebase-inspection, github-auth, github-code-review, github-issues, github-pr-workflow, github-repo-management) |
| `research` | 5 skills (arxiv, blogwatcher, llm-wiki, polymarket, research-paper-writing) |
| `social-media` | 1 skill (xurl) |
| `software-development` | 8 skills (node-inspect-debugger, plan, python-debugpy, requesting-code-review, spike, systematic-debugging, test-driven-development, writing-plans) |

The skill installer (`packages/installer`) supports **Clawhub**, **npm**, **git**, and **local**
sources, with safety checks for path segments, temp names, git branches, and npm package names.
`skills-lock.json` pins third-party skills by SHA-256 hash.

---

## 🧪 Testing & Verification

```bash
npm test               # run Jest test suites
npm run test:go        # run Go tests
npm run test:frontend  # run frontend tests (pnpm)
npm run verify         # lint + Jest + doctor checks
npm run verify:release # full release verification (packaging + gateway smoke test)
npm run lint           # ESLint (packages + frontend)
npm run typecheck      # turbo typecheck across packages
```

---

## 📜 npm Scripts

| Script | Purpose |
|--------|---------|
| `npm run build:all` | Turbo build of all TypeScript packages |
| `npm run build` | Build release artifacts (runtime package, web UI, Go binaries) |
| `npm run build:webui` | Build the React web UI |
| `npm run build:go-backend` | Build the Go launcher backend |
| `npm run build:cli` | Build the Go CLI |
| `npm run dev` | Build runtime if stale, then launch `bin/Hiro.js` |
| `npm start` | Run the gateway directly from `packages/gateway/dist` |
| `npm run doctor` | Run diagnostics via the CLI |
| `npm run verify` / `npm run verify:release` | CI-style verification |

---

## 🔌 Ports

| Service | Port |
|---------|------|
| 🧠 Core agent API | `8000` |
| 🖥️ Gateway / dashboard | `18800` |
| 🧠 Memory server | `3777` |

---

## 🩺 Troubleshooting

| Symptom | Likely fix |
|---------|------------|
| Chat fails with a missing-credential error | No Gemini / OpenRouter / OpenAI API key is configured. Add one via the Models page, `.env`, or `mikiagent config set GEMINI_API_KEY <your-key>` |
| Provider rejects the API key (401/403) | The stored key is invalid. Update it in the dashboard Credentials or Models page |
| Chat fails with quota / rate-limit error | Provider quota exhausted; wait for reset or configure another provider/model as fallback |
| Gateway health times out | Check `data/logs/**` and free the configured `CORE_PORT`/`GATEWAY_PORT` |
| `npm run doctor` hangs | `bin/Hiro.js` has no doctor branch; use `agent doctor` or `bin/owlclaw-doctor.mjs` instead |

See `docs/TROUBLESHOOTING_MATRIX.md` and `setup.md` (a Windows setup guide) for more.

---



## Project Structure — @hiro

This directory contains a chunked breakdown of the entire project structure.

| File | Covers |
|---|---|
| [Root](Root.md) | Top-level files and directories (`.devin`, `.github`, `bin/`, `config/`, `data/`, `docs/`, `promlem-lists/`, `src/skills/`, root config files) |
| [Core](Core.md) | `packages/core/` — agent engine, API, tools, channels, safety, plugins, self-improvement |
| [Config](Config.md) | `packages/config/` — shared configuration, schema, security, secret vault |
| [Gateway](Gateway.md) | `packages/gateway/` — Express reverse proxy, MCP proxy |
| [Installer](Installer.md) | `packages/installer/` — multi-source skill installer |
| [Memory](Memory.md) | `packages/Hiro-memory/` — GraphRAG memory server |
| [Skills](Skills.md) | `packages/skills/` — bundled skill catalog |
| [UI](UI.md) | `packages/ui/` — React frontend + Go backend |
| [CLI](CLI.md) | `packages/Hiro-cli/` — Go terminal UI |
| [Scripts](Scripts.md) | `scripts/` — build and release automation |



## 📄 License

<div align="center">

**MIT** — declared in `package.json`.

<br/>

*Built with ☕ & 🤖*

</div>