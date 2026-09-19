# 01 — Root and Top-Level Directories

## Root files

```
.
├── .env.example                 # Example environment variables (API keys, ports, bind)
├── .gitattributes               # Git attribute rules (line endings, etc.)
├── .gitignore                   # Ignores node_modules, dist, runtime data, caches
├── LICENSE                      # MIT License (Copyright 2026 Agent Miki contributors)
├── README.md                    # Project overview, architecture, quick start
├── SETUP.md                     # Detailed setup and operational documentation
├── package.json                 # Monorepo root: workspaces, scripts (build, start, model:*, verify)
├── package-lock.json            # npm lockfile
├── pnpm-lock.yaml               # pnpm lockfile (used by some packages/frontend)
├── pnpm-workspace.yaml          # Declares packages/* workspaces
├── tsconfig.json                # Root TypeScript config
├── tsconfig.base.json           # Shared base TS compiler options
├── turbo.json                   # Turborepo pipeline configuration
├── eslint.config.js             # ESLint flat config
├── jest.config.cjs              # Main Jest configuration
├── jest.core.config.cjs         # Core-package specific Jest config
├── jest.release.config.cjs      # Release verification Jest config
└── jest.setup.mjs               # Jest setup / global helpers
```

**Comments**
- `package.json` defines the high-level scripts: `build:all`, `start` (→ bin/miki.js), `model:list|install|status`, `verify`, `dev`, `runtime:24-7`.
- Locks and workspace files support both npm and pnpm usage.
- Test configs are split so core, release and general tests can run independently.

## bin/

```
bin/
├── miki.js                      # Primary Node entry: resolves runtime, starts gateway/core/memory/UI
├── miki-config.js               # Configuration helper / inspector
├── miki-doctor.mjs              # Environment & runtime diagnostics
└── supervisor.ps1               # Windows process supervisor helper
```

**Comments**
- `miki.js` is the main orchestrator. It locates the runtime root, checks required dist artifacts, spawns the Go CLI dashboard when available, and launches the gateway + core services.
- Doctor performs health and dependency checks useful for installation troubleshooting.

## config/

```
config/
├── .env.example                 # Config-level env example
├── agent.yaml                   # Core agent persona, models, memory, security, tools policy
└── tools.yaml                   # Tool permission levels, deny patterns, MCP, web-search providers
```

**Comments**
- `agent.yaml` is the single most important runtime configuration file (persona, model routing, resource limits, security defaults, self-improvement flags).
- `tools.yaml` controls shell/file/computer-use permissions, deny patterns, and web-search provider selection.

## data/

```
data/                            # Runtime data directory (empty in source; created at runtime)
```

**Comments**
- Holds SQLite databases, memory stores, logs, model cache, workspace state. Not committed.

## deploy/

```
deploy/
├── firewall/
│   └── agent-miki-firewall-examples.md   # Example firewall rules
├── linux/
│   ├── install-systemd.sh                # Installs systemd service
│   ├── uninstall-systemd.sh
│   └── systemd/
│       └── agent-miki.service.in         # systemd unit template
├── reverse-proxy/
│   └── nginx-agent-miki.conf.example     # Nginx reverse-proxy example
└── windows/
    ├── Install-AgentMiki.ps1             # Windows installer script
    └── Uninstall-AgentMiki.ps1
```

**Comments**
- Provides production deployment helpers for Linux (systemd) and Windows.
- Reverse-proxy and firewall examples support hardened network exposure.

## docs/

```
docs/
├── provider-gateway.md          # Provider gateway design notes
└── structure/                   # This annotated structure documentation set
    ├── 00-index.md
    ├── 01-root-and-top-level.md
    └── ...
```

## providers/

```
providers/
└── example-provider/
    ├── README.md
    ├── miki.provider.json       # Provider manifest
    └── provider.mjs             # Example external provider implementation
```

**Comments**
- Demonstrates how third-party model providers can be registered via the plugin/SDK boundary.

## scripts/

See [08-build-and-ci.md](08-build-and-ci.md) for the full scripts inventory.
