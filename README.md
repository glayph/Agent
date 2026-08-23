# Agent Miki

**Agent Miki** is a local-first, cross-platform agentic AI workspace for Linux and Windows. It combines a Node.js launcher, a TypeScript agent core, a React dashboard, model and credential management, memory, tools, channels, automations, and a guarded control plane.

The project is designed to be useful with low-cost or local models first. Cloud providers remain optional and can be configured through the dashboard without placing credentials in source code.

## What Miki includes

| Area | What it provides |
| --- | --- |
| Agent workspace | Conversational chat, runs, execution details, artifacts, and Inspector views |
| Models | Provider catalog, default-model selection, local llama.cpp support, and runtime health |
| Search | Local-first web search with optional API providers and source citations |
| Memory | Selective memory, search, reindexing, retrieval traces, and SQLite-backed storage |
| Tools | Guarded filesystem, shell, browser, web, model, workflow, MCP, and skill capabilities |
| Channels | Web chat plus configurable channel adapters with allow-lists and runtime probes |
| Automation | Schedules, workflows, persistent job state, retries, and approval-aware execution |
| Agent Control | Sanitized state, capability discovery, validated reversible changes, approvals, and an operation journal |

## Quick start

The recommended local workflow is:

```bash
npm install
npm run build:all
npm start
```

Open the dashboard address printed by the launcher. The usual local address is `http://127.0.0.1:18800`. On first launch, Miki asks you to set a dashboard password.

For development with hot reload, use:

```bash
npm run dev
```

The complete setup guide is available in [`SETUP.md`](SETUP.md). It contains the platform-specific prerequisites, model configuration, voice setup, provider setup, troubleshooting, and release instructions.

## Linux and Windows support

Miki’s application code is cross-platform. Linux and Windows use the same launcher, dashboard, configuration model, and safety boundaries. The local llama.cpp runtime is selected by platform and must be built or supplied with a compatible executable. Answer-model GGUF files are not bundled; configure an operator-provided model path through the dashboard or the documented environment variables.

A conservative native build on Linux can be started with:

```bash
MIKI_LLAMA_BUILD_JOBS=1 npm run build:all
```

On Windows, run the commands from PowerShell or a Node.js-compatible terminal after installing the native build prerequisites described in [`SETUP.md`](SETUP.md).

## Agent Control

The **Agent Control** page is available at `/control` and from the dashboard sidebar. It provides a small, typed management surface rather than an unrestricted automation macro.

| Control | Boundary |
| --- | --- |
| State and capabilities | Read-only, sanitized, and credential-redacted |
| Resource profile | Reversible `eco`, `balanced`, or `performance` configuration change |
| Tool enablement | Enable or disable an existing registered tool through the dashboard controller |
| Model/runtime health | Inspect registered provider/runtime adapters, including llama.cpp |
| Runtime reload | Reload supported configuration and report restart requirements |
| Protected operations | Owner approval, context binding, one-time consumption, and journaled outcome |

Complex or destructive actions are not silently guessed. Arbitrary shell commands, unrestricted filesystem mutation, factory reset, credential deletion, unattended third-party code installation, and generic model downloading remain outside the autonomous control boundary.

The control API is documented in [`docs/agent-control-api.md`](docs/agent-control-api.md). The implementation audit is in [`docs/agent-control-capability-report.md`](docs/agent-control-capability-report.md).

## Low-cost model strategy

Miki works best when a local model or a free/low-cost provider is configured as the default. Local llama.cpp models keep inference on the operator’s machine. Cloud providers can be added later through the Models and Credentials pages. Provider availability depends on the operator’s credentials, network access, quotas, and provider policy.

Do not commit API keys, bot tokens, MCP credentials, model weights, local databases, or runtime logs. Use the dashboard’s secret-aware fields or environment configuration for sensitive values.

## 24/7 operation

For a continuously running installation, keep the launcher under a process supervisor and configure automatic restart after failure. Miki includes readiness commands that can be used by a supervisor or deployment check:

```bash
npm run runtime:24-7:check
npm run runtime:24-7
```

The readiness check confirms that the expected gateway entrypoint and runtime configuration are present. It does not prove that every provider, channel, native runtime, MCP server, or model is available; those dependencies are reported separately by the dashboard and health surfaces.

For detailed Linux/Windows service setup, relocation, native runtimes, voice transcription, and production notes, read [`SETUP.md`](SETUP.md).

## Optional capabilities

Miki supports local-first web search, configurable API search providers, Whisper.cpp-based voice transcription, authenticated MCP, Telegram-style channel administration, skill discovery/import, and persistent approval workflows. Optional capabilities remain disabled or degraded until their runtime, credentials, model, endpoint, or allow-list is explicitly configured.

The project deliberately treats external MCP servers, downloaded skills, native binaries, and model files as untrusted or operator-provided inputs. Installation and side-effectful operations must pass validation and, where required, owner approval.

## Project layout

| Path | Purpose |
| --- | --- |
| `packages/core` | Agent orchestration, tools, control plane, channels, security, model/runtime logic, and APIs |
| `packages/config` | Validated configuration schemas and runtime settings |
| `packages/gateway` | Gateway process and runtime-facing services |
| `packages/memory` | SQLite-backed memory and retrieval components |
| `packages/skills` | Skill metadata, discovery, import, and installation boundaries |
| `packages/ui/frontend` | React dashboard, routes, API clients, and visual workspace |
| `scripts` | Development, build, release, verification, and 24/7 readiness commands |
| `docs` | Architecture audits, control API guidance, and capability reports |

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the development workflow |
| `npm run build:all` | Build native/runtime packages and the production dashboard |
| `npm start` | Start the launcher |
| `npm run test` | Run workspace tests where configured |
| `npm run verify` | Run the project verification workflow |
| `npm run runtime:24-7:check` | Check continuous-runtime readiness |
| `npm run build:release:linux` | Build the Linux offline release package |
| `npm run build:release:windows` | Build the Windows release package |

## Verification notes

The repository contains focused tests for control capability boundaries, secret redaction, approval gating, operation routing, and deterministic management intents. A full build, native runtime probe, provider probe, and browser pass should be run on the target Linux or Windows machine before production deployment because those checks depend on local compilers, binaries, model files, credentials, and operating-system services.

## License

Agent Miki is released under the MIT License. Third-party providers, model weights, native runtimes, skills, and external MCP servers may have separate licenses and terms. Review those terms before distribution or deployment.
