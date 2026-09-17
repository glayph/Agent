# @miki/cli — the self-contained Agent Miki npm package

This package publishes a single command: `miki`. Installing it globally
(`npm install -g @miki/cli`) and running `miki` starts the full Agent Miki
runtime — memory service, core, gateway, and web UI — with no other command
needed, and no separate step to run llama.cpp: it is bundled and starts
on demand only if you actually configure/use a local model.

```bash
npm install -g @miki/cli
miki
```

That's it. `miki` opens the terminal dashboard (or, if Go wasn't available
when this package was built, falls back to a headless start with the web UI
still fully usable — see "Go dashboard binary" below). From there, open the
printed web UI URL to log in and configure a cloud model (Gemini, OpenAI,
etc.) or use the bundled local llama.cpp model — either way, `miki` is the
only command you type.

## Commands

```bash
miki                    # same as `miki start`
miki start [--host <host>] [--port <port>] [--debug] [--plain]
miki doctor             # environment + runtime diagnostics
miki install            # register the workspace (data/logs/config dirs)
miki uninstall           # remove workspace registration, keep data
miki uninstall --purge   # also delete data/logs/config
miki version
miki help
```

## What "self-contained" means here

Unlike a typical workspace package that depends on its monorepo siblings
being built alongside it, `@miki/cli`'s published tarball contains a full,
independent copy of everything needed to run:

```text
dist/pack/                        <- everything below this line ships in the npm tarball
├── bin/
│   ├── miki.js                   <- the published `miki` command (orchestrator)
│   ├── miki-doctor.mjs
│   └── miki-config.js
├── packages/
│   ├── memory/src/...            <- memory service (plain JS, no build step)
│   ├── cli/agent.js              <- Node CLI fallback (used if Go wasn't available at build time)
│   ├── config/dist, installer/dist, skills/dist+src
│   ├── core/dist/...             <- includes the bundled llama.cpp native binary, if present
│   ├── gateway/dist/...
│   └── ui/frontend/dist/...      <- the built web UI
├── node_modules/                 <- vendored production dependencies for all of the above
├── config/                       <- default runtime config
└── runtime-loader.mjs            <- resolves @miki/* bare specifiers at runtime
```

`bin/miki.js` resolves all of the above relative to its own location, so it
works correctly no matter where npm installs it.

## How `miki start` works

1. Ensures the memory service (`packages/memory/src/api/server.js`) is
   running, forking it if not.
2. Looks for a compiled Go dashboard binary at `bin/Miki-cli` (or
   `Miki-cli.exe`). If present, launches it — this is what opens the
   interactive terminal dashboard (Bubble Tea) and manages the gateway
   process tree (stop/restart from inside the dashboard actually terminates
   or restarts the gateway, not just detaches).
3. If the Go binary is not present, falls back to the bundled
   `packages/cli/agent.js` (Node CLI), which starts the gateway directly.
   Either path gives you a working gateway + web UI; only the interactive
   terminal dashboard itself is Go-specific.
4. The gateway spawns core, serves the built web UI, and proxies API/WebSocket
   traffic. Local llama.cpp models are started on demand by core
   (`auto_start: true` by default) only if/when you actually select or
   configure one in the web UI — never eagerly at boot, and never via a
   separate command.

`doctor`, `install`, and `uninstall` have no Go equivalent and are always
delegated to the bundled `packages/cli/agent.js`.

## Go dashboard binary

The interactive terminal dashboard requires a Go toolchain **on the machine
that builds/publishes this package** (not on the end user's machine — the
compiled binary ships in the tarball). Build it with:

```bash
node scripts/build-cli.mjs
```

This is called automatically by `npm run build:cli` (part of the repo root's
`npm run build`) and by this package's own `prepack` script
(`scripts/pack-self-contained.mjs`), so a normal `npm publish` from a
Go-enabled machine or CI runner (GitHub Actions' standard runners include Go
by default) produces a package with the full dashboard. If Go isn't
available at build time, packaging still succeeds — `miki` will use the Node
CLI fallback (headless gateway + fully functional web UI) instead of opening
the terminal dashboard.

## Building and packing this package yourself

From the repo root:

```bash
npm install
npm run build                 # builds every workspace package, incl. the Go CLI/backend if Go is available
cd packages/cli
npm pack                      # runs prepack (scripts/pack-self-contained.mjs) automatically
```

`scripts/pack-self-contained.mjs` copies the repo root's `dist/runtime`
bundle (itself produced by `scripts/prepare-runtime-package.mjs`) into
`packages/cli/dist/pack/`, which is exactly what `files` in `package.json`
publishes. Set `MIKI_PACK_SKIP_BUILD=1` to skip the rebuild step if you
already ran `npm run build && node scripts/prepare-runtime-package.mjs`
yourself (e.g. as separate, cacheable CI steps).

## Environment variables

- `MIKI_WORKSPACE_DIR`: choose the data, log, and configuration workspace.
- `MIKI_GATEWAY_PATH` / `MIKI_GATEWAY_ENTRY`: override the gateway entry file.
- `MIKI_RUNTIME_ROOT`: override the runtime distribution root (defaults to
  this package's own bundled `dist/pack`).
- `MIKI_RUNTIME_LOADER`: override the Node runtime loader path.
- `MIKI_NODE`: choose the Node executable used to launch the gateway.
- `GATEWAY_HOST` / `GATEWAY_PORT`: choose the gateway bind address and port.
- `MIKI_INSTALLER=1`: enable Windows installer mode when the native wrapper exists.

## Source files in this package

```text
packages/cli/
├── agent.js                     # Node.js launcher / lifecycle CLI (doctor, install, uninstall)
├── scripts/pack-self-contained.mjs  # prepack: assembles dist/pack/ from the repo's runtime bundle
├── package.json
├── main.go, config.go           # Go terminal entrypoint and argument parsing
├── runtime.go                   # Managed gateway process lifecycle
├── plain.go                     # Non-interactive runtime output
├── tui.go, styles.go            # Bubble Tea terminal dashboard
├── process_unix.go / process_windows.go
└── *_test.go                    # Go regression tests
```

(`bin/miki.js`, `bin/miki-doctor.mjs`, and `bin/miki-config.js` — the actual
published entry points — live at the repo root's `bin/` directory; they get
copied into `dist/pack/bin/` at pack time, since the same launcher is also
used directly from the monorepo root during development via `npm start`.)

## Validation

From the repo root:

```bash
node --check bin/miki.js
node bin/miki.js doctor
```

From this directory:

```bash
node --check agent.js
go test ./...   # requires Go
```
