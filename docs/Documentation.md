# Hiro Documentation

[README](README.md) | [Feature Notes](feature.md) | [Release Checklist](RELEASE_CHECKLIST.md) | [Troubleshooting Matrix](TROUBLESHOOTING_MATRIX.md)

This document is the central guide for the Hiro repository. It
consolidates setup, runtime architecture, deployment guidance, channel
configuration, and MCP client setup into one reference document.

## Overview

Hiro is a local agent stack built around a TypeScript runtime and
a browser dashboard. The runtime is launched from the repository root, starts
the gateway, brings up the core API and LiteLLM proxy, then serves the dashboard
and API surfaces from one local entry point.

The default posture is local and auditable. File and shell work are scoped to
the workspace unless the configuration is changed. Destructive actions are
guarded. External channels remain disabled or unready until credentials and
provider-side setup are supplied.

## Main Components

| Path                              | Purpose                                                                 |
| --------------------------------- | ----------------------------------------------------------------------- |
| `bin/Hiro.js`                  | Root Node entrypoint. Resolves the runtime and starts the Go launcher.   |
| `bin/Hiro-doctor.mjs`          | Doctor helper used by health and verification commands.                  |
| `packages/Hiro-cli`            | Go terminal launcher with TUI/plain modes.                               |
| `packages/gateway`     | Express gateway, process supervisor, dashboard server, proxy layer.      |
| `packages/core`        | Agent orchestration, API, memory, tools, skills, MCP, safety, channels.  |
| `packages/config`      | Config schema, validation, CORS and secret helpers.                      |
| `packages/installer`   | Skill installer and source adapters.                                     |
| `packages/skills`      | Bundled skill catalog.                                                   |
| `packages/ui/frontend` | React dashboard.                                                         |
| `packages/ui/backend`  | Go compatibility backend used by the packaged dashboard path.            |
| `config`                          | Runtime YAML files and tool configuration.                               |
| `data`                            | Local databases, logs, backups, generated secrets, and runtime state.    |
| `scripts`                         | Build, test, smoke, audit, packaging, and cleanup scripts.               |

## Quick Start

### Requirements

- Node.js `^20.19.0 || ^22.13.0 || >=24`
- npm
- Go `1.26.2` or newer
- A model provider key or LiteLLM-compatible setup for real chat/model calls

### Install and configure

```bash
npm install
copy .env.example .env
```

Set useful defaults in `.env`:

```text
CORE_HOST=127.0.0.1
CORE_PORT=8000
GATEWAY_HOST=127.0.0.1
GATEWAY_PORT=18800
LITELLM_BASE_URL=http://127.0.0.1:4000/v1
ENABLE_API_KEY_AUTH=true
API_KEY_SECRET=<strong-secret>
ENABLE_MCP=false
```

### Build

```bash
npm run build
```

This compiles TypeScript, builds the dashboard, builds Go artifacts, builds the
CLI, and assembles `dist/runtime`.

### Start

```bash
npm start
```

The launcher starts the gateway and prints the dashboard URL. Default local URL:

```text
http://127.0.0.1:18800/
```

On first launch:

1. Create a dashboard password.
2. Add a model provider or credential from `/models` or `/credentials`.
3. Open `/` for chat.
4. Use `/health` if anything fails during startup.

### Everyday commands

```bash
npm start
npm run dev
npm run doctor
npm run lint
npm run verify
npm run smoke:gateway
npm run smoke:channels-ui
npm run pack:check
npm run clean
```

`npm run verify` runs JavaScript tests, frontend tests, Go tests, dependency
audit, and doctor checks with migrations and secret scanning.

## Runtime Architecture

### Runtime shape

```text
Hiro.js
  -> Go CLI launcher
  -> Gateway
  -> Core API
  -> LiteLLM proxy
  -> React dashboard
```

### Public local endpoints

```text
Dashboard:      http://127.0.0.1:18800/
Gateway health: http://127.0.0.1:18800/gateway/health
Core health:    http://127.0.0.1:18800/api/health
Full health:    http://127.0.0.1:18800/api/enhancements/health/full
MCP:            http://127.0.0.1:18800/mcp
```

### Runtime flow

```text
user
  -> bin/Hiro.js
  -> Hiro-cli
  -> gateway
  -> React dashboard
  -> LiteLLM proxy
  -> core API
```

From the dashboard, browser requests normally go through the gateway:

```text
Dashboard -> /api/*      -> Core compatibility API
Dashboard -> /hiro/ws    -> Gateway WebSocket relay -> Core chat runtime
Webhook   -> /webhooks/* -> Core channel handlers
MCP       -> /mcp        -> Core MCP session manager
```

### Dashboard routes

| Route             | Use                                                      |
| ----------------- | -------------------------------------------------------- |
| `/`               | hiro/Web chat                                            |
| `/drive`          | Workspace file browsing                                  |
| `/models`         | Provider and model management                            |
| `/credentials`    | Provider credential flows                                |
| `/channels`       | Channel catalog                                          |
| `/channels/$name` | Channel configuration and probes                         |
| `/agent/hub`      | Skill marketplace/search                                 |
| `/agent/skills`   | Installed skills                                         |
| `/agent/tools`    | Tool registry and web-search configuration               |
| `/agent/runs`     | Agent run records, task graph, evidence                  |
| `/config`         | Structured config editor                                 |
| `/config/raw`     | Raw config editor                                        |
| `/health`         | Doctor, backups, migrations, jobs, watchdog, secret scan |
| `/logs`           | Runtime logs                                             |
| `/system-index`   | Workspace indexing and search                            |

### Core API groups

- health and status: `/health`, `/status`, `/system/health`, `/system/stats`,
  `/metrics`
- chat and sessions: `/chat`, `/hiro/ws`, `/ws/chat`, `/sessions`
- tasks and goals: `/tasks`, `/tasks/scheduled`, `/goals`, `/goals/next`
- models and providers: `/models`, `/models/active`, `/models/by-provider`,
  `/providers`
- tools and skills: `/tools`, `/tools/:name/call`, `/api/skills`
- operations: `/api/enhancements/*`
- MCP: `/mcp`

## Configuration

Primary files:

- `config/agent.yaml` controls agent behavior, workspace limits, memory,
  channels, tools, heartbeat, concurrency, MCP, and resource profile settings.
- `config/litellm.yaml` controls LiteLLM model routing.
- `config/tools.yaml` controls tool behavior.
- `.env` stores local environment values and secrets.
- `.env.example` is the safe template for new environments.

The default agent config keeps access workspace-scoped, enables audit logging,
requires confirmation for destructive actions, and keeps external autonomy
behind explicit settings.

## Deployment and packaging

### Build for release

```bash
npm install
npm run verify:release
```

For a build-only path:

```bash
npm run build
npm run pack:check
```

The assembled runtime is written to `dist/runtime` and includes compiled package
output, bundled skills, dashboard assets, Go backend artifacts, the Go CLI
binary, config files, and the runtime loader.

### Environment guidance

For exposed deployments, set strong local secrets:

```text
ENABLE_API_KEY_AUTH=true
API_KEY_SECRET=<strong-secret>
LITELLM_MASTER_KEY=<strong-secret>
Hiro_ALLOWED_ORIGINS=http://localhost:18800,http://127.0.0.1:18800
```

For local development, `ENABLE_API_KEY_AUTH=false` is acceptable, but do not
use that setting for a publicly reachable deployment.

### Logs and state

Runtime state is stored locally in `data/` and `config/`.

Before sharing a workspace:

```bash
npm run sanitize:local-data
```

## Channels

Channel UI and runtime surfaces are present, but production readiness depends on
provider-side setup and valid credentials.

### Probe modes

| Mode      | Enablement                                                                    | External traffic                      | Use                                        |
| --------- | ----------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------ |
| Mock      | default                                                                       | none                                  | CI, local config validation, release gates |
| Sandbox   | `Hiro_CHANNEL_SANDBOX_PROBES=true`                                         | provider sandbox only when configured | pre-production provider validation         |
| Live      | `Hiro_CHANNEL_LIVE_PROBES=true`                                            | reachability only by default          | production readiness validation            |
| Live send | `Hiro_CHANNEL_LIVE_PROBES=true` and `Hiro_CHANNEL_ALLOW_LIVE_SEND=true` | live outbound send                    | manual production smoke only               |

Probe responses include `check_mode`, `latency_ms`, `send_check`, and a
redacted `failure_code` when a check fails.

### Required fields

| Channel         | Required configuration                                                                  |
| --------------- | --------------------------------------------------------------------------------------- |
| Telegram        | bot token, webhook secret when webhooks are enabled                                     |
| Discord         | bot token, application/client id, public key for interactions                           |
| Slack           | bot token, signing secret, app token when socket mode is used                           |
| Feishu/Lark     | app id, app secret, verification token or encrypt key                                   |
| DingTalk        | app key, app secret, robot code or webhook signing secret                               |
| QQ              | app id, bot token, signing secret                                                       |
| Matrix          | homeserver URL, access token, room id                                                   |
| IRC             | server, port, nick, target channel                                                      |
| OneBot          | HTTP or WebSocket endpoint, access token when configured                                |
| MQTT            | broker URL, client id, topic, credentials when required                                 |
| LINE            | channel access token, channel secret                                                    |
| WhatsApp bridge | bridge URL, access token, phone/account identifier                                      |
| Weixin          | app id, app secret, token, encoding AES key when encrypted webhooks are enabled         |
| WeCom           | corp id, agent id, secret, token, encoding AES key when encrypted callbacks are enabled |

Secrets must be configured through the runtime config or credential store and
must not be committed. API responses and audit details redact known secret
fields before returning to the dashboard.

### Channel setup flow

1. Configure provider credentials in the dashboard or runtime config.
2. Run the channel probe in mock mode and fix required-field failures.
3. For sandbox-capable providers, set `Hiro_CHANNEL_SANDBOX_PROBES=true`
   and rerun the probe.
4. For production readiness, set `Hiro_CHANNEL_LIVE_PROBES=true` and verify
   reachability without enabling live outbound send.
5. Enable `Hiro_CHANNEL_ALLOW_LIVE_SEND=true` only for intentional manual
   production smoke.

Disabled channels can be saved without credentials and remain visible in the
dashboard as disabled or needing configuration.

### Webhooks

Expose webhooks only through the authenticated gateway or a trusted reverse
proxy. Configure provider callback URLs to the gateway route for the selected
channel, keep signing secrets enabled, and rotate tokens after any failed
security review.

## MCP client setup

Hiro exposes MCP through the gateway at:

```text
http://127.0.0.1:18800/mcp
```

MCP is disabled by default because it exposes tool execution. Set
`ENABLE_MCP=true` only when MCP clients should connect, and set a unique
16+ character `API_KEY_SECRET` before starting the runtime.

### Client configuration

Use streamable HTTP transport and send the MCP session id returned by
`initialize` on later requests. Every MCP request must also include either the
`X-API-Key` header or the `Authorization` bearer header with the configured
API secret.

```json
{
  "name": "Hiro-local",
  "transport": {
    "type": "http",
    "url": "http://127.0.0.1:18800/mcp"
  }
}
```

If the gateway requires launcher authentication, bootstrap or sign in before
opening the MCP session from the same client context. Launcher authentication
does not replace the API key required by `/mcp`.

### Permission model

Tool permission state is persisted per session. The state contains current
decisions and a timeline of grants, denies, revokes, and policy changes.
Denied tool calls return a structured denial object with the tool name, decision,
reason, policy source, and session id when available.

### Smoke check

1. Start Hiro with `ENABLE_MCP=true` and a strong `API_KEY_SECRET`.
2. Send `initialize` to `/mcp` with the API key header.
3. List tools and verify risk metadata is present.
4. Call a low-risk read-only tool.
5. Attempt a denied high-risk call from a restricted session and confirm the
   structured denial is returned and audited.

## Operational data

Common local state:

- `data/core_backend.log`
- `data/litellm_proxy.log`
- `data/audit.db`
- `data/agent-runs.db`
- `data/runtime-jobs.json`
- `data/backups/`

Use `npm run sanitize:local-data` before sharing a checkout that may contain
local state or generated secrets.

## Release gates

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

Expected result: the dashboard starts, core health is reachable through the
gateway, full health returns a report, MCP is available unless disabled,
channel probes return explicit states, and package checks confirm required
runtime files.
