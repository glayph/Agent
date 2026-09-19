# 05 — Gateway, Config & Installer

## packages/gateway

Lightweight Express gateway that fronts the core agent and serves the UI.

```
packages/gateway/
├── package.json                 # @miki/gateway
├── tsconfig.json
├── __tests__/
└── src/
    ├── index.ts                 # Express app setup, proxy, static, health
    ├── websocket-relay.ts       # WebSocket relay to core
    ├── runtime-utils.ts         # Path rewriting, MCP proxy helpers
    ├── shutdown.ts              # Graceful shutdown & process tree termination
    └── ...
```

**Comments**
- Proxies HTTP and WebSocket traffic to the core API.
- Serves the built frontend static files.
- Handles CORS, API-key / origin / CIDR authentication, health checks.
- Manages clean shutdown of child processes.

## packages/config

Shared foundation used by almost every other package.

```
packages/config/
├── package.json                 # @miki/config — exports ., ./security, ./schema
├── tsconfig.json
└── src/
    ├── index.ts                 # Main re-exports
    ├── config.ts                # Settings loading & validation
    ├── schema.ts                # Config schema
    ├── types.ts                 # Shared TypeScript types
    ├── security.ts              # CORS, CIDR, API-key helpers, bind policy
    ├── secret-vault.ts          # Secret resolution / vault
    ├── user-config.ts           # User-level overrides
    ├── env-compat.ts            # Environment variable compatibility layer
    ├── default-model.ts         # Default model helpers
    └── *.test.ts                # Unit tests
```

**Comments**
- Single source of truth for runtime configuration shape.
- Security helpers enforce public-bind policy, origin checks and timing-safe comparisons.
- Secret vault supports loading credentials without hard-coding them.

## packages/installer

Workspace and runtime installation helpers.

```
packages/installer/
├── package.json
├── jest.config.cjs
├── __tests__/
└── src/
    └── (installer logic for registering data/logs/config dirs)
```

**Comments**
- Used by `miki install` / `miki uninstall` to create or remove the on-disk workspace layout while optionally preserving user data.
