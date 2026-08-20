# Agent Miki CLI package

This directory contains the command-line entry point and terminal interface for the Agent Miki runtime. The JavaScript launcher starts the built gateway for npm/desktop-style usage, while the Go companion provides a native terminal dashboard with live runtime controls and logs.

## Commands

```bash
agent start
agent doctor
agent install
agent uninstall
agent uninstall --purge
agent version
agent help
```

`agent uninstall` retains the workspace data by default. Use `agent uninstall --purge` only when deleting the `data`, `logs`, and `config` directories is intentional.

## JavaScript launcher

The Node.js launcher supports Node.js `^20.19.0 || ^22.13.0 || >=24` and resolves the gateway from the sibling `packages/gateway/dist/index.js` build. For an installed or relocated distribution, set `MIKI_GATEWAY_PATH` to the built gateway entry file. The workspace used by install and uninstall can be set with `MIKI_WORKSPACE_DIR`.

The `doctor` command checks the CLI entrypoint, package manifest, gateway build, Node.js runtime, and TCP/IP availability. It exits with an error when `agent start` cannot find a gateway build unless an explicit gateway path is supplied.

## Go terminal interface

The Go companion requires Go 1.25 or newer as declared in `go.mod`. It supports:

```bash
Miki start [--host <host>] [--port <port>] [--debug] [--plain]
Miki help
Miki version
```

In a terminal, `Miki start` opens the Bubble Tea dashboard. In a non-terminal environment, it automatically uses plain mode. Stop, Shutdown, and Restart terminate or restart the managed gateway process tree; they do not merely detach while claiming the service has stopped.

## Environment variables

- `MIKI_INSTALLER=1`: enable Windows installer mode when the native wrapper exists.
- `MIKI_WORKSPACE_DIR`: choose the data, log, and configuration workspace.
- `MIKI_GATEWAY_PATH`: provide an explicit built JavaScript gateway entrypoint to the Node launcher.
- `MIKI_GATEWAY_ENTRY`: provide an explicit gateway entrypoint to the Go terminal interface.
- `MIKI_RUNTIME_ROOT`: set the runtime distribution root used by the Go interface.
- `MIKI_RUNTIME_LOADER`: optionally load a Node runtime loader before starting the gateway.
- `MIKI_NODE`: choose the Node executable used by the Go interface.
- `GATEWAY_HOST` and `GATEWAY_PORT`: choose the gateway bind address and port.

Legacy mixed-case variables remain supported where the runtime already documents them, but canonical `MIKI_*` variables take precedence.

## Package contents

```text
packages/cli/
├── agent.js                     # Node.js launcher and lifecycle CLI
├── package.json                 # npm package metadata and commands
├── main.go, config.go           # Go terminal entrypoint and argument parsing
├── runtime.go                   # Managed gateway process lifecycle
├── plain.go                     # Non-interactive runtime output
├── tui.go and styles.go         # Bubble Tea terminal dashboard
├── process_unix.go              # Unix process-group termination
├── process_windows.go           # Windows process termination
└── *_test.go                    # Go regression tests
```

## Validation

From this directory:

```bash
node --check agent.js
node agent.js doctor
go test ./...
```

The CLI audit verifies install directory creation, non-destructive uninstall, explicit purge deletion, gateway startup with an injected stub, Go runtime lifecycle, occupied-port failure handling, log buffering, configuration parsing, and TUI helpers.
