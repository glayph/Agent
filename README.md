# Miki — Autonomous AI Agent

Miki is an autonomous, tool-using AI agent with a web dashboard. The Node.js Gateway is the application composition root: it hosts the Agent runtime, serves the dashboard and API, and coordinates Core, Memory, model providers, channels, and runtime services.

A model invocation is finite. Autonomous follow-up work is initiated by host-side services such as the `AutonomousSupervisor` and durable goal/task workers; it is not the model recursively calling itself. The available tools, authorization state, credentials, process health, provider limits, and configured execution lane determine what Miki can actually do at any moment.

## Start here

- [Agent-Miki operating model](docs/AGENT_MIKI_OPERATING_MODEL.md): authoritative explanation of identity, real capabilities, tool discovery, autonomous execution lanes, verification, and safety boundaries.
- [Autonomous execution workflow](docs/AUTONOMOUS-EXECUTION.md): plan/run/checkpoint/recovery lifecycle.
- [Always-active idle mode](docs/always-active-idle-mode.md): supervisor scheduling, ambient permissions, and live status.
- [Architecture](docs/ARCHITECTURE.md): package boundaries and source-of-truth modules.
- [Project structure index](docs/structure/00-index.md): annotated repository structure.
- [Upgrade TODO and verification record](docs/MIKI_AGENT_AND_CHAT_TOPBAR_UPGRADE_TODO.md): implementation checklist and test results.

## Requirements

- Node.js `>=22.19.0` (check with `node -v`).
- npm; the root `package-lock.json` is the canonical workspace lockfile.
- Git.
- Optional, depending on enabled features: Chrome/Chromium for browser automation, ffmpeg for media work, and Python for selected integrations.

## Install and build

Run from the repository root. Do not use `--ignore-scripts`; the native SQLite dependency requires its install lifecycle script.

```bash
npm ci
npm run build:all
```

`build:all` runs the architecture/layout contract, native SQLite check, workspace builds, frontend production build, CLI build, and bundled-skill validation. The native llama.cpp integration is built as part of the Core build when the native build path is enabled. Read the specific error output before deciding whether a failed build is environmental or a code defect.

## Configure

Copy the environment template and add only the provider/runtime settings you need:

```bash
cp config/.env.example .env
```

Miki reads the project-root `.env` and, when present, `config/.env`; environment variables already supplied by the process take precedence. Common settings:

| Variable | Purpose |
| --- | --- |
| `MIKI_PROVIDER`, `MIKI_MODEL` | Default model provider and model |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI fallback configuration when no dashboard model is selected |
| `MIKI_MODEL_PATH` | Local GGUF model path for the local llama.cpp runtime |
| `GATEWAY_HOST` | Gateway bind address; default is `127.0.0.1` |
| `GATEWAY_PORT` | Gateway port; default is `18800` |
| `MIKI_VAULT_KEY` | Optional passphrase for the secret vault |

Inspect `config/.env.example`, `config/agent.yaml`, and `config/tools.yaml` for the complete supported configuration. A documentation entry does not enable a feature or grant permission.

## Run

```bash
npm start
```

Open `http://127.0.0.1:18800` unless the host or port was changed. Configure a model in the Models page or through the supported environment variables, then check Health and Agent Activity before expecting background work to proceed.

## What autonomy means

Miki can plan and execute multi-step tasks, use registered tools, maintain eligible durable goals, recover supported interrupted work, and make later decisions through host-side supervision when the corresponding services are running and enabled. It is not an unlimited background process: machine power, process lifetime, provider quota/rate limits, network availability, model context/output limits, OS permissions, authorization, cancellation, and approval gates still apply. The ambient decision lane is narrower than the tracked goal-execution lane; see the operating model and idle-mode guide before changing permissions.

## Credentials and data

Credentials are stored in the runtime data root's secret vault. Keep the vault data and its key/passphrase together in a secure backup. Never commit `.env`, vault contents, API keys, session cookies, or runtime databases. If the vault key is lost, encrypted credentials may not be recoverable.

## Tests and diagnostics

```bash
npm run test:architecture-layout
npm run test:agent-core
npm run test:gateway
npm --prefix packages/ui/frontend run test
npm --prefix packages/ui/frontend run lint
npm run build:all
```

Run only the checks relevant to your change during iteration, then the full verification path before release. Use `npm run runtime:24-7:check` to inspect the continuous-runtime policy and `npm run test:recovery-chaos` for the recovery fault suite where the host supports it.

## Troubleshooting

- **Missing SQLite bindings:** run `npm rebuild better-sqlite3` or repeat `npm ci` with install scripts enabled.
- **Missing `dist` artifacts:** run `npm run build:all`.
- **Port already in use:** select another `GATEWAY_PORT`.
- **No model configured:** add a model in the dashboard or set a supported provider/model and credential pair.
- **Vault locked:** verify the passphrase or restore the key file that belongs to the vault.
- **Autonomy appears idle:** inspect `/api/autonomy/status`, the Activity page, provider health, pause/enable state, and the configured ambient/goal permissions. A running Gateway alone is not proof that an autonomous decision or goal is currently progressing.

## Historical repair notes

Dated audit and repair reports under `docs/` are retained as historical records. They explain what was investigated at the time; they are not a guarantee that every item remains current. For current behavior, use the source files linked by the [operating model](docs/AGENT_MIKI_OPERATING_MODEL.md) and the tests adjacent to those modules.
