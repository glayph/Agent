# 03 — packages/core (Agent Engine)

`@miki/core` owns the Agent execution engine and reusable runtime/domain logic. It does not own a second memory implementation, and Agent-facing provider access is routed through `@miki/gateway`.

```text
packages/core/
├── package.json
├── tsconfig.json
└── src/
    ├── api/                  # Core API routers and application composition
    ├── autonomy/             # Goal management and autonomous supervision
    ├── control/               # Agent control plane
    ├── engine/               # Planning, execution, tool loop, LLM client contracts, token budgets
    ├── hooks/                # Lifecycle event definitions and dispatch
    ├── mcp/                  # MCP contracts and tool connectivity
    ├── messaging/            # Message adaptation and formatting
    ├── observability/        # Audit log, error handling and metrics
    ├── permissions/          # Permission governance
    ├── plugins/
    │   ├── browser/          # Browser plugin implementation
    │   ├── code-execution/   # Code execution plugin implementation
    │   ├── computer-use/     # Computer control plugin implementation
    │   └── providers/
    │       ├── sdk/          # Provider plugin contracts, loader and registry
    │       ├── builtin/      # Built-in provider implementations
    │       │   ├── gemini/
    │       │   └── llama.cpp/
    │       │       ├── source/    # Complete vendored llama.cpp source tree
    │       │       ├── native/    # Bundled native executable artifacts
    │       │       ├── runtime/   # Local llama.cpp process lifecycle
    │       │       └── index.ts   # Built-in llama.cpp provider plugin
    │       └── openai-compatible-adapter.ts
    ├── runtime-fetch/        # Runtime fetch helpers
    ├── self-improvement/     # Learning and self-improvement loops
    ├── services/             # Shared services, e.g. speech and web search
    ├── sessions/             # Session history and session state
    ├── plugins/skills/       # Skill catalog, manager and installer
    └── tasks/                # Durable task state, workers and retry orchestration

packages/memory/src/
├── core/                     # Temporal Knowledge Graph and canonical memory runtime
└── file-memory/              # File-backed notes, search, compaction and memory tools
```

## Provider communication boundary

- Provider adapters, registry and built-in implementations are owned by `packages/core/src/plugins/providers/`.
- The Agent-facing `ProviderGateway` is owned by `packages/gateway/src/providers/` and is the Gateway boundary through which Agent runtime requests reach the provider registry.
- Agent runtime code must not instantiate provider SDK clients or access `providerRegistry` directly.
- The complete llama.cpp CMake source tree lives under `providers/builtin/llama.cpp/source/`. `scripts/build-llama.mjs` configures and builds the `llama-server` target from this source on every Core/Agent build; existing native binaries never skip source compilation.

## Memory ownership

All persistent memory implementations belong to `packages/memory/`, including the TKG runtime and the file-memory service. Core and Gateway consume these features through the `@miki/memory` package exports. Do not add memory implementation folders under `packages/core/src/`.
