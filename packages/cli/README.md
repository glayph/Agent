# @miki/cli — Agent-Miki command-line runtime

This package publishes the `miki` command. It starts and manages the Agent-Miki runtime through the TypeScript CLI, Gateway lifecycle controller, readiness checks and terminal dashboard. The current CLI path does not require the legacy Go compatibility backend.

```bash
npm install -g @miki/cli
miki
```

Open the printed web UI URL to log in and configure a cloud model or a local llama.cpp model.

## Commands

```bash
miki                    # same as `miki start`
miki start [options]    # start the gateway and dashboard
miki doctor             # environment and runtime diagnostics
miki install            # create data/logs/config workspace directories
miki uninstall          # retain data and remove registration
miki version
miki help
```

Options include `--host <host>`, `--port <port>`, `--debug`, and `--plain`. The plain mode is useful for CI and service managers. In the interactive dashboard, use Up/Down to select, Enter to activate, Tab to focus logs, and `q` to quit.

## How startup works

The published launcher loads the CLI runtime, prepares the selected workspace, and asks the TypeScript lifecycle controller to start the Gateway and its dependent runtime services. Follow the current controller source for the exact startup order; it can vary with package layout and deployment mode. The controller validates ports, propagates runtime environment variables, writes `data/gateway.pid`, streams child logs, polls `/gateway/health`, and supports start, stop, restart, and graceful shutdown. The gateway starts the core backend, serves the built web UI, and proxies API and WebSocket traffic.

## Self-contained package layout

```text
dist/pack/
├── bin/miki.js                 <- published launcher
├── packages/cli/dist/cli.js    <- compiled TypeScript CLI and dashboard
├── packages/gateway/dist/      <- gateway runtime
├── packages/core/dist/         <- core runtime and llama.cpp integration
├── packages/memory/src/        <- memory service
├── packages/ui/frontend/dist/  <- web dashboard
└── runtime-loader.mjs          <- workspace module resolution
```

## TypeScript build

The CLI is compiled using the repository's existing Node.js and TypeScript toolchain:

```bash
npm install
npm run build:cli
node packages/cli/dist/cli.js doctor
```

The root `npm run build` includes this step. Go remains available only as an explicit legacy backend compatibility command (`npm run build:go-backend`); it is not needed to build, package, launch, or operate the Miki CLI.

## Source files

```text
packages/cli/
├── src/cli.ts                   # TypeScript lifecycle CLI and terminal dashboard
├── dist/cli.js                  # compiled CLI artifact
├── agent.js                     # compatibility Node launcher for older consumers
├── scripts/pack-self-contained.mjs
├── scripts/install-tui.mjs
├── package.json
└── tsconfig.json
```

## Environment variables

- `MIKI_WORKSPACE_DIR`: choose the data, log, and configuration workspace.
- `MIKI_GATEWAY_PATH` / `MIKI_GATEWAY_ENTRY`: override the gateway entry file.
- `MIKI_RUNTIME_ROOT`: override the runtime distribution root.
- `MIKI_RUNTIME_LOADER`: override the Node runtime loader.
- `MIKI_NODE`: choose the Node executable used to launch the gateway.
- `GATEWAY_HOST` / `GATEWAY_PORT`: choose the gateway bind address and port.

## Validation

From the repository root:

```bash
npm run build:cli
node packages/cli/dist/cli.js --help
node packages/cli/dist/cli.js doctor
```


## Agent autonomy and permission model

The CLI starts and manages the host runtime; it does not itself provide unlimited model execution. Background decisions and durable work depend on the Gateway/Core supervisor and worker services, provider access, configured permissions and process health. See [the root operating model](../../docs/AGENT_MIKI_OPERATING_MODEL.md) and [idle-mode guide](../../docs/always-active-idle-mode.md). A successful `miki start` means the lifecycle start completed, not that a particular autonomous goal is active or complete.
