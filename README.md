![Hiro Hiro](docs/theme.png)

# Hiro Hiro

Hiro Hiro is a local-first assistant runtime for developers who want
an inspectable, configurable, and recoverable workspace agent. It is built as
an integrated local stack that runs from a single repository and provides the
following runtime components:

- A command-line launcher that starts the local runtime.
- A gateway that serves the dashboard and proxies API, WebSocket, webhook, and
  MCP traffic.
- A core TypeScript API that manages chat sessions, memory, tools, skills,
  channels, and safety.
- A React dashboard for operating the agent, configuring models and channels,
  inspecting health, and browsing runtime data.
- An installer and a bundled skills catalog for extensible tool and skill loading.

This project is intentionally local-first: network-facing features are only
enabled when configured, external channels require explicit credentials, and
runtime behavior is designed to be visible and recoverable rather than hidden.

## Documentation

- [Detailed Documentation](Documentation.md)
- [Feature Notes](feature.md)
- [Release Checklist](RELEASE_CHECKLIST.md)
- [Troubleshooting Matrix](TROUBLESHOOTING_MATRIX.md)

> Archived markdown files have been moved to `docs/trash` to keep the docs folder small and focused.

## What This Project Provides

Hiro Hiro is not just a chat application. It is a full local agent
runtime with separate operational layers:

- `bin/Hiro.js` and `packages/Hiro-cli`: startup, process supervision,
  runtime bootstrapping, and developer CLI entry points.
- `packages/gateway`: Express gateway, static dashboard serving, HTTP
  proxying, webhook relays, WebSocket routes, LiteLLM supervision, and MCP proxy.
- `packages/core`: core agent API, memory storage, tools, skills,
  models, channel adapters, goals, jobs, and safety checks.
- `packages/Hiro-memory`: GraphRAG memory system with temporal knowledge
  graph, intelligent chunking, hybrid vector-BM25 search, and data optimization.
- `packages/ui`: React dashboard UI plus a Go compatibility backend
  for local packaged runtime support.
- `packages/config`: config schema, validation, CORS, and secret helpers.
- `packages/installer`: skill installation, source adapters, and
  bundled skill registry.
- `packages/skills`: included skills and sample bundles.

Each layer is intentionally decoupled so the launcher, gateway, core, and UI can
be inspected independently, and the same local stack can be packaged or run from
source with consistent behavior.

## How It Works

1. The launcher starts the runtime.
   - `npm start` runs the gateway directly, which supervises the core API and
     the LiteLLM process.
   - `npm run dev` runs `bin/Hiro.js`, which additionally starts the Go CLI
     and the GraphRAG memory server.
2. The gateway serves the dashboard and proxies requests.
   - Dashboard UI requests are served from the built React app.
   - API calls under `/api/*` are forwarded to the core.
   - WebSocket chat routes and MCP traffic are proxied cleanly through the
     gateway.
   - Webhook routes are mounted for supported external channels.
3. The core manages state and agent behavior.
   - Session history, chat messages, facts, goals, tasks, and model records are
     persisted in SQLite.
   - Tools are registered and executed through a policy-aware tool registry.
   - Skills can be loaded, installed, inspected, and removed.
   - Channel events are normalized and forwarded into the agent response loop.
4. Agent responses are collected and emitted.
   - Chat input may arrive from the dashboard or channel adapters.
   - The runtime constructs prompts, calls the configured model provider, and
     returns structured assistant output.
   - Tool calls, channel replies, and session updates are persisted so the
     runtime can recover state after restart.

## Implemented Runtime Capabilities

- Chat session and WebSocket runtime for dashboard conversations.
- Model/provider management with LiteLLM routing and provider configuration.
- Configurable tool registry and execution for local tools and external helpers.
- Skill installation and management via local, git, npm, and ClawHub-style sources.
- Persistent SQLite-backed memory for sessions, messages, tasks, and goals.
  Additional memory types (habits, profiles, model records) are planned but not
  yet fully implemented.
- MCP server support at `/mcp` with runtime discovery, tool proxying, and
  connector management.
- Channel adapters and webhook routing for real external integrations.
- Health checks, doctor diagnostics, backups, rollback support, migrations,
  audit events, and secret scanning.

## Channels That Are Actually Wired In

The runtime includes functional Node adapters for the following channels:

- Telegram
- Discord
- Slack
- Matrix
- IRC
- OneBot
- MQTT
- LINE
- WhatsApp bridge
- Feishu/Lark webhook flows
- DingTalk webhook flows
- QQ webhook callbacks
- Pico (built-in web chat)

The repository also contains forms and config surfaces for WeChat/WeCom, but the
live runtime adapters for those services are currently partial and require more
provider handshake implementation before they should be treated as fully active.

## What Is Not Automatically Enabled

- External API access is not turned on silently. The default configuration
  stays local and loopback-only unless you explicitly change ports or expose the
  gateway.
- Most channel traffic is disabled until credentials and webhook settings are
  configured. WhatsApp is enabled by default but still requires bridge credentials
  to function.
- Background autonomy and scheduled jobs are gated behind runtime settings.

## Optimizing This Project

### Optimize model usage

- Configure models and providers through the dashboard or `config/litellm.yaml`.
- Keep the LiteLLM proxy running at `127.0.0.1:4000` for local inference and
  consistent model routing.
- Use provider-specific advanced fields only when the chosen provider supports
  them; unsupported options may be ignored by the runtime.
- Pick the smallest model that still meets your prompt needs to reduce latency
  and cost.

### Optimize runtime performance

- Run `npm run doctor` after build to validate local health and configuration.
- Use `npm run verify` and `npm run smoke:gateway` before packaging or release.
- Keep `node_modules` and built outputs up to date with `npm run build`.
- Use `npm run sanitize:local-data` before sharing or archiving the workspace.

### Optimize channel setup

- Configure each channel with explicit credentials and webhook endpoints.
- Use `npm run smoke:channels-ui` to verify adapter readiness.
- Treat probe statuses as authoritative; `ready` means the runtime is configured,
  while `needs_config` means credentials are missing.

### Optimize security and visibility

- Keep the dashboard on `127.0.0.1:18800` unless you intentionally expose it.
- Use optional API key authentication for any external access path.
- Audit runtime behavior using logs, health reports, and the dashboard record
  history.

## Quick Start

```bash
npm install
npm run build
npm run doctor
npm start
```

The launcher prints the dashboard URL after startup. In a default local setup,
the dashboard is served at:

```text
http://127.0.0.1:18800/
```

On first launch:

1. Create a dashboard password.
2. Configure a model provider.
3. Open the chat page or configure a channel.

If you want to use the runtime with external integrations, add the required
credentials and webhook settings before enabling those channels.

## Common Commands

```bash
npm start                 # start the packaged/source runtime
npm run dev               # build, then start
npm run doctor            # run local health checks
npm run lint              # lint packages and dashboard
npm run verify            # test, audit, doctor
npm run verify:release    # release-grade verify/build/package/audit/smoke path
npm run smoke:gateway     # gateway integration smoke
npm run smoke:channels-ui # channel UI/probe smoke
npm run pack:check        # verify packaged runtime contents
npm run sanitize:local-data
```

## Repository Layout

```text
bin/                         CLI entrypoints
config/                      runtime configuration
data/                        local state, logs, databases, backups
docs/                        project documentation
packages/core     agent runtime and core API
packages/gateway  dashboard gateway and process supervisor
packages/config   config schema and security helpers
packages/Hiro-memory   GraphRAG memory system
packages/installer skill installer
packages/skills   bundled skills
packages/ui       React dashboard and Go compatibility backend
packages/Hiro-cli         Go terminal launcher
scripts/                     build, smoke, audit, packaging, cleanup scripts
```

## Runtime Defaults

```text
Dashboard/Gateway: http://127.0.0.1:18800
Core API:          http://127.0.0.1:8000
LiteLLM proxy:     http://127.0.0.1:4000
MCP endpoint:      http://127.0.0.1:18800/mcp
```

These values can be changed in `.env`.

## Release Verification

Before publishing, packaging, or handing off a build, run the following checks:

```bash
npm run lint
npm run verify
npm run build
npm run pack:check
npm run audit:agent
npm run smoke:gateway
npm run smoke:channels-ui
npm audit --omit=dev
```

For local checkouts that may contain generated secrets or runtime state, run:

```bash
npm run sanitize:local-data
```




## License

MIT
