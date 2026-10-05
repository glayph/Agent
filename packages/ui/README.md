# Miki Web

This directory contains the React Web UI and the legacy Go compatibility stub used by the current Miki runtime.

## Architecture

The primary Web UI path is:

```text
React dashboard
      │
      ├── /api/*
      ├── /gateway/*
      └── /miki/ws
      │
      ▼
Node Gateway (packages/gateway)
      │
      ├── Core / Agent
      ├── Memory
      └── Provider integrations
```

The Go code under `packages/ui/backend` is **compatibility/legacy only**. `stub_main.go` is not a full dashboard backend and must not be selected as the primary Web UI server. The files under `packages/ui/backend/api/*.go` are guarded by the `legacy_backend` build tag and remain compatibility code.

The default Node Gateway port is `18800`. The Vite development server must proxy `/api`, `/gateway`, `/miki/media`, and `/miki/ws` to that same gateway origin.

## Runtime Ownership

The Node Gateway owns the Web UI HTTP API and the `/miki/ws` connection. The launcher/supervisor owns process start/restart/stop semantics. A gateway `restart` request therefore reports `pending_restart` when a process replacement is required; it does not claim that the current process has already restarted.

Gateway runtime data is stored under the active workspace data directory when `MIKI_WORKSPACE_DIR`/`MIKI_DATA_DIR` are provided. This keeps auth sessions, model configuration, chat state, and runtime state aligned with the launched workspace.

## Dashboard Capabilities

The current frontend exposes these major pages and flows:

- `/`
  - Chat UI with session history, default model selection, and miki channel messaging.
- `/models`
  - Add, edit, delete, and set the default model.
  - Supports API-key models, OAuth-backed models, and local/CLI-backed models.
- `/credentials`
  - Manage provider credentials.
  - Current built-in flows: OpenAI, Anthropic, and Google Antigravity.
- `/channels/*`
  - Configure supported channels from a shared catalog.
  - Current catalog: `weixin`, `telegram`, `discord`, `slack`, `line`, `onebot`, `wecom`, `whatsapp`, `miki`, `matrix`, `irc`, `mqtt`.
  - Legacy config-only forms remain in source but are no longer surfaced in the default catalog.
  - Includes QR-based binding helpers for WeChat and WeCom.
- `/agent/skills`
  - Browse built-in, global, and workspace skills.
  - Import Markdown skills into the workspace and delete workspace-owned skills.
- `/agent/tools`
  - View tool availability and enable or disable tool switches through config-backed APIs.
- `/config`
  - Edit agent defaults, self-evolution, exec controls, cron controls, heartbeat, device monitoring, launcher networking, and launch-at-login settings.
- `/logs`
  - View the in-memory gateway log buffer and clear it.

The UI currently supports English and Simplified Chinese, plus light and dark themes.

## Runtime Behavior

### Config Resolution

The launcher uses the same Miki config file as the main binary.

- Default app config path: `~/.Miki/config.json`
- Override with environment variable: `Miki_CONFIG`
- Override with a positional CLI argument: `Miki-launcher /path/to/config.json`

Launcher-only settings are stored beside that app config:

- File name: `launcher-config.json`
- Default location: `~/.Miki/launcher-config.json`

That file currently stores:

- `port`
- `public`
- `allowed_cidrs`

If `-port` or `-public` are passed explicitly, the CLI flag wins for that run.
If they are omitted, stored launcher settings are used.

### First-Run Onboarding

If the target config file does not exist, the launcher tries to bootstrap it automatically by running:

```bash
Miki onboard
```

The launcher looks for the main Miki binary in this order:

1. `Miki_BINARY`
2. A `Miki` binary in the same directory as the launcher
3. `Miki` from `PATH`

If onboarding or gateway startup cannot find the main binary, set `Miki_BINARY` explicitly.

### Gateway Management

The launcher/supervisor owns the Node Gateway process. The Node Gateway owns the Web UI API and `/miki/ws`.

- `start` reports the already-running state when the current process is active.
- `restart` reports `pending_restart` when a process replacement is required.
- `reload` applies in-process configuration changes without pretending to restart the process.
- `shutdown` records a request for the launcher/supervisor and then terminates the gateway so the process owner can settle on the real `stopped` state.

### Dashboard Authentication

The Node Gateway and WebSocket use the same `miki_session` cookie backed by the gateway runtime database.

- `/launcher-setup` creates the dashboard password.
- `/launcher-login` creates the authenticated session.
- REST dashboard APIs return `401` when the session is missing or expired.
- WebSocket authentication uses the same session cookie and returns a controlled `authentication_required` event when re-authentication is needed.
- The session is stored in the active runtime data directory, so launcher/gateway restarts use the same session store unless the runtime workspace changes.

### Network Exposure

By default the launcher listens on:

```text
127.0.0.1:18800
```

With `-public` or `public: true`, it listens on all interfaces:

```text
0.0.0.0:18800
```

When public access is enabled:

- the Node Gateway still protects dashboard APIs with password-backed `miki_session` auth
- optional `allowed_cidrs` can restrict which client IP ranges may connect
- the launcher/runtime keeps the configured gateway host and port consistent with the frontend proxy

## Build And Run

### Prerequisites

- Node.js 20.19+ (or 22.13+)
- `pnpm`
- Go 1.26.2+ only when building the legacy Go compatibility stub

### Recommended Runtime

From the repository root:

```bash
npm run build:all
npm start
```

The launcher/runtime starts `packages/gateway/dist/index.js`. The dashboard is served by the Node Gateway. Do not run the Go compatibility stub on the gateway's primary port.

### Frontend Development

```bash
cd packages/ui/frontend
pnpm install
pnpm run dev
```

The Vite proxy derives its target from `VITE_GATEWAY_ORIGIN` or the configured `GATEWAY_HOST`/`GATEWAY_PORT`; otherwise it uses `http://127.0.0.1:18800`. Restart Vite after changing the gateway port.

### Compatibility Stub

The optional Go compatibility stub can be built with:

```bash
npm run build:go-backend
```

It is intentionally separate from the primary dashboard backend and defaults to port `18801` when `GATEWAY_PORT` is not explicitly provided. Its health response identifies itself with `backend_role=compatibility-stub`.

### Minimum Smoke Checks

With an authenticated dashboard session, verify:

```text
GET  /api/health
GET  /api/models
GET  /api/config
GET  /api/sessions
GET  /api/tools
GET  /api/skills
GET  /api/gateway/status
GET  /api/gateway/logs?offset=0
WS   /miki/ws
```

For API/log requests the canonical pagination parameter is `offset`, with `run_id` for run filtering.

## Troubleshooting

### You have to sign in again after the launcher restarts

Existing dashboard sessions do not survive launcher restarts.
That is expected: each launcher process generates a new session value, so old cookies become invalid.
Sign in again with the dashboard password on `/launcher-login`.

### "Start Gateway" stays disabled

The Node Gateway is normally already owned by the launcher/supervisor. If the UI reports that it cannot start, first inspect `/api/gateway/status` and the gateway logs. A `pending_restart` state means the supervisor must replace the gateway process.

### The launcher cannot find `Miki`

Set the main binary explicitly:

```bash
export Miki_BINARY=/absolute/path/to/Miki
```

This affects onboarding and gateway subprocess startup.

### The UI shows connection or 404 errors in development

Confirm that the Node Gateway is listening on the same host/port configured for Vite (default `127.0.0.1:18800`). Do not point Vite at the Go compatibility stub or a Core service directly. Restart Vite after changing the gateway port.

## Related Docs

- Main project overview: [`../README.md`](../README.md)
- Configuration guide: [`../docs/guides/configuration.md`](../docs/guides/configuration.md)
- Providers: [`../docs/guides/providers.md`](../docs/guides/providers.md)
- Troubleshooting: [`../docs/operations/troubleshooting.md`](../docs/operations/troubleshooting.md)
- Official docs site: [docs.Miki.io](https://docs.Miki.io)
