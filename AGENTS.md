# AGENTS.md

## Repository Overview

Hiro (miki) is a local-first autonomous AI agent runtime with full computer control. This repository contains all runtime components in one place.

- **8 packages** in monorepo with TypeScript core + Go CLI + React UI
- **Complex architecture** with multi-agent system and tool parallelism
- **Production-ready** with safety systems and audit logs

## Key Architecture Files

* `bin/Hiro.js` - Entry point that starts Go CLI and Gateway
* `packages/gateway/` - Express gateway supervising Core + LiteLLM processes
* `packages/core/` - Agent engine (~220K LOC) - **THE HEART**
* `config/agent.yaml` - Agent personality, channels, tool permissions

## Runtime Defaults

These are hardcoded runtime defaults, not configuration values:
* Dashboard/Gateway: http://127.0.0.1:18800
* Core API:          http://127.0.0.1:8000
* LiteLLM proxy:     http://127.0.0.1:4000
* MCP endpoint:      http://127.0.0.1:18800/mcp

## Package Boundaries & Ownership

* **packages/core/** - Agent engine: orchestrator, tool registry, task scheduler, memory, skills
* **packages/gateway/** - Process orchestrator: spawns Core + LiteLLM, WebSocket relay, CORS/IP rules
* **packages/cli/** - Go TUI launcher: terminal UI, process supervision
* **packages/ui/frontend/** - React dashboard (50+ files)
* **packages/ui/backend/** - Legacy Go backend (stub + compatibility)
* **packages/memory/** - GraphRAG memory system (vector + graph storage)
* **packages/skills/** - Pre-packaged skill library
* **packages/config/** - Config schema, secret vault, validation
* **packages/installer/** - Skill/plugin installer

## Developer Commands

### Critical Commands

```bash
# Quick verification
npm run doctor              # Run local health checks after major changes

# Build chain - REQUIRED ORDER
npm run lint              # ESLint check (fails on warnings)
npm run typecheck         # TypeScript typecheck
npm test                  # Jest tests (use --runInBand for speed)

# Full verification
npm run verify            # lint + test + doctor
npm run verify:release    # Release-grade verify/build/package/audit

# Build step
npm run build              # Full build: TypeScript + Go + React
```

### Package-specific

```bash
# Go binaries
npm run build:cli         # packages/cli (Go CLI binary)
npm run build:go-backend   # packages/ui/backend (Go UI backend)

# React frontend
npm run build:webui       # packages/ui/frontend

# Runtime package (after TypeScript build)
npm run prepare:runtime   # Creates dist/runtime/ package
```

## Environment & Setup

### Toolchain Requirements

* **Node:** >=24 or ^22.13.0 or ^20.19.0
* **pnpm:** 10.33.0 (forced by frontend package.json)
* **Go:** Optional (CLI/backend builds)
* **Turborepo:** Build orchestrator

### Dependency Management

* Use `node scripts/frontend-pnpm.mjs` for frontend builds
* Go binaries are gracefully skipped if Go not installed
* Corepack is required for frontend builds (see AGENTS.md for troubleshooting)

## Configuration System

### Core Config (`config/agent.yaml`)

**Non-negotiable defaults:**
* `security.system_access: full` - agent has full OS access
* `sandbox_mode: false` - no sandboxing
* `channels.*` - 13+ adapters enabled by default (Telegram, Discord, etc.)
* `self_improvement.enabled: true` - with circuit breaker

**Important:** Security is explicit, not implicit. The runtime is local-only unless exposed intentionally.

### Key Configuration Files

* `config/agent.yaml` - Agent personality, specialists, channels
* `config/litellm.yaml` - LiteLLM proxy config
* `config/tools.yaml` - Tool definitions

## Build System

### TypeScript (core)

* Files: packages/core/src/ (~150K LOC)
* Testing: packages/core/src/*.test.ts (~200K LOC of tests)

### Go Components

* packages/cli/ - CLI binary (`mikiagent-cli`, ~20MB)
* packages/ui/backend/ - Legacy Go backend (702 lines)
* Must build Go components for full test suite

### Frontend

* packages/ui/frontend/ - React 19 + TanStack Router
* Uses pnpm with Vite build system
* Tests via `npm run test:frontend`

## Testing Quirks

### Test Prerequisites

* Core tests need built runtime (`dist/runtime/packages/core/dist`)
* Go tests require Go binary
* Frontend tests need React build
* Should run through `npm run verify`

### Test Structure

* **Core:** packages/core/src/*.test.ts + packages/core/src/api/*.test.ts + packages/core/src/tools/*.test.ts
* **Go:** packages/cli/*_test.go + packages/ui/backend/*_test.go
* **Frontend:** packages/ui/frontend/ (Vitest via frontend-pnpm.mjs)

**Critical:** Tests depend on built runtime. Build first if you see "Cannot find dist/runtime/packages/core/dist" errors.

### Command Issues

* `npm test` needs `--runInBand` flag for JS tests to run in serial
* Go tests via: `npm run test:go` (run-go-tests.mjs)
* Frontend tests via: `npm run test:frontend` (frontend-pnpm.mjs wrapper)

## Runtime Operations

### Startup Flow

**Source Development:**
```bash
npm run dev              # Builds runtime if stale, then starts full stack
                        # Launches Go CLI + Gateway + Core + LiteLLM
```

**Production Runtime:**
```bash
npm start               # Starts Gateway directly (requires `npm run build` first)
```

### Health & Diagnosis

```bash
npm run doctor          # System health diagnosis after any build

# Troubleshooting commands
npm run smoke:gateway     # Gateway integration smoke test
npm run smoke:channels-ui # Channel UI/probe verification
npm run sanititze:local-data  # Before sharing/archive
```

## Troubleshooting

### Common Failures

**"Cannot find dist/runtime/packages/core/dist"**
* NOT built yet
* Solution: `npm run build` first

**"Go not installed - skipping build"**
* Solution: Install Go for CLI/backend features
* Acceptable: CLI/backend missing, Gateway still functional

**"Corepack not found"**
* Solution: `npm install -g corepack` or `corepack enable`
* Affects frontend build only

### Gateway Issues

**"Gateway port 18800 is in use"**
* Solution: `tasks clean:turbo` then restart

**"Cannot read file: ... credential file"**
* Solution: Ensure `data/vault.json` exists with correct permissions

## File Structure

### Data Directory

* `data/agent.db` - Agent runs, audit logs, task queue
* `data/memory.db` - Long-term memories, facts
* `data/scheduled_tasks.db` - Cron/scheduled tasks
* `data/system_index.db` - File system index
* `data/vault.json` - Encrypted credential storage

### Configuration

```
config/agent.yaml
config/litellm.yaml
config/tools.yaml
```

### Scripts

| Script | Purpose |
|--------|---------|
| build-release-artifacts.mjs | Full build pipeline |
| frontend-pnpm.mjs | pnpm with platform-specific logic |
| prepare-runtime-package.mjs | Runtime packaging for distribution |
| run-verify.mjs | Pre-release verification |
| run-go-tests.mjs | Go test runner |
```

### Build Clean

```bash
npm run clean              # Clean TypeScript artifacts
npm run clean:turbo        # Clean all turbo caches
```

## Backwards Compatibility

### Releases vs Source

**Source Development (recommended):**
```bash
npm run dev              # Builds + starts (lazy build)
npm run doctor           # Health checks
```

**From Packaged Release:**
```bash
npm start                # Starts gateway directly (pre-built)
```

## Security Notes

### Default Configuration

Runtime security defaults:
* `bypass_restrictions: true`
* `system_access: full`
* `sandbox_mode: false`
* `risk_acceptance: true`
* `privileged_account_required: false`

### Safety Features

* Secret scanning via `safety/secret-scan.ts`
* Path traversal prevention in `executor/file-security.ts`
* Per-tool resource locks (max 8 parallel calls, 30-second timeout)
* Tamper-evident audit logging in SQLite

## Self-Improvement & Evolution

**Heartbeat:** Runs every 30 seconds:
- Self-improvement reflection check
- Prompt tuning check  
- Optimization cycle check
- Resource cleanup
- Cost calibration update

**Circuit Breaker:** Stops if error rate too high
**Max reflections:** 12/day
**Mode:** Currently observation-only (Phase 2 planned)

## Extension System

### Plugin Contract Kinds

* `tools` | `channels` | `skills` | `providers` | `hooks`

### Installation Sources

* Git repositories
* npm packages
* Local directories
* ClawHub registry

### Governance

* `skill_governance.enabled: false` (currently)
* Validates syntax and dangerous patterns
* Can be enabled later

### MCP

* Model Context Protocol server at `/mcp`
* Fine-grained permission system
* Resource handlers, prompt templates, session management