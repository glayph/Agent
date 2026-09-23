# @miki/cli — the self-contained Agent Miki npm package

This package publishes one command: `miki`. It starts the Agent Miki runtime with a portable TypeScript CLI, managed gateway lifecycle, readiness checks, and an interactive terminal dashboard. No Go toolchain or native CLI binary is required.

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

The published launcher starts the memory service, loads `packages/cli/dist/cli.js`, and asks the TypeScript runtime controller to start the gateway. The controller validates ports, propagates runtime environment variables, writes `data/gateway.pid`, streams child logs, polls `/gateway/health`, and supports start, stop, restart, and graceful shutdown. The gateway starts the core backend, serves the built web UI, and proxies API and WebSocket traffic.

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
