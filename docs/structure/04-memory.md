# 04 — packages/memory (Temporal Knowledge Graph)

Specialized package for persistent, temporal, and cognitive memory used by the 24/7 agent.

```
packages/memory/
├── package.json                 # @miki/memory v2.0.0 — multiple named exports
├── src/
│   ├── index.js                 # Public API re-exports
│   ├── temporal-knowledge-graph.js   # Core TKG implementation
│   ├── graph-cognitive-memory.js     # Cognitive / graph memory layer
│   ├── working-memory-anchor.js      # Working-memory anchors
│   ├── temporary-memory.js           # Ephemeral memory region
│   ├── multi-hop-retriever.js        # Multi-hop retrieval over the graph
│   ├── memory-consolidation-daemon.js # Background consolidation process
│   ├── agent-memory-integration.js   # Integration helpers for core agent
│   ├── special-event-highlighter.js  # Highlights important events
│   ├── selective-memory-engine.js    # Selective retention / pruning
│   ├── learning-store.js             # Learning / procedural store
│   ├── node-graph.js                 # Low-level graph primitives
│   ├── regions.js                    # Memory region definitions & aliases
│   ├── embedding-provider.js         # Embedding providers (hash, noop, real)
│   └── test/                         # Unit & integration tests
│       ├── tkg-test-runner.js
│       ├── integration-phase1.test.js
│       ├── deep-audit.test.js
│       ├── graph-cognitive-memory.test.js
│       ├── selective-memory-engine.test.js
│       ├── learning-store.test.js
│       └── memory-prompt-budget.test.js
```

**Key concepts**
- **Temporal Knowledge Graph (TKG)** — primary long-term memory structure with temporal edges.
- **Regions** — durable vs temporary regions; canonical region names and aliases.
- **Consolidation daemon** — periodically consolidates and prunes memory.
- **Multi-hop retrieval** — follows graph paths for richer context.
- **Working-memory anchors** — keep important recent context active.
- **Selective engine + learning store** — control what is retained and learned.

**Comments**
- Exported as multiple entry points so core can import only the pieces it needs.
- Designed for long-running agents (24/7 policy scripts exist at repo root).
- Tests cover graph integrity, consolidation, retrieval and prompt-budget limits.
