# Hiro-memory — Temporal Knowledge Graph & Event-Driven Stream Architecture

Next-gen memory system for 24/7 autonomous agent execution. Replaces classic GraphRAG with a stateful **Temporal Knowledge Graph (TKG)** backed by SQLite with hourly event chunks, entity-relationship tracking, working memory anchoring, special event highlighting, and automatic consolidation.

```
Hiro-memory/
├── src/
│   ├── cli.js                           CLI entry point (legacy)
│   ├── config.js                        Memory server configuration
│   ├── index.js                         Unified exports (v1 + v2)
│   ├── nodegraphrag.js                  Lightweight v1 wrapper (legacy)
│   ├── temporal-knowledge-graph.js      SQLite-backed TKG engine [NEW]
│   ├── working-memory-anchor.js         Dynamic anchor state [NEW]
│   ├── special-event-highlighter.js     Event importance classifier [NEW]
│   ├── memory-consolidation-daemon.js   Background consolidation daemon [NEW]
│   ├── agent-memory-integration.js      Pre/post execution hooks [NEW]
│   ├── api/
│   │   ├── server.js                    Express server (v1 + v2 routes)
│   │   └── routes.js                    REST API (classic + v2 TKG endpoints)
│   ├── core/                            Classic v1 engine (backward compat)
│   │   ├── memory-manager.js
│   │   ├── graph-store.js
│   │   ├── chunk-engine.js
│   │   ├── vector-index.js
│   │   ├── temporal-engine.js
│   │   └── optimizer.js
│   ├── scripts/
│   │   └── migrate-to-tkg.js           Migration script (v1 -> v2)
│   └── test/
│       ├── test-runner.js               Classic v1 tests
│       └── tkg-test-runner.js           TKG v2 tests [NEW]
├── data/                                Memory persistence (JSON + SQLite)
├── package.json
└── README.md
```

## Key Architecture Components

### 1. Working Memory Anchor (`আমি [Time/Date/CurrentSituation]`)
- Injected into every agent loop
- Contains: current timestamp, active situation, key entities in short-term focus
- Auto-updates on every event write

### 2. Temporal Hourly Chunks
- Time sliced into hourly buckets (`2026-07-21T14`)
- Empty/idle hour tracking creates explicit `EMPTY_CHUNK` entries
- Eliminates time-gap ambiguity in long-running agents

### 3. Entity-Relationship Graph
- Nodes: People, Places, Objects, Questions, Claims, Actions
- Edges: Directed with temporal metadata (`valid_from`, `valid_until`)
- Supports dynamic state updates and edge deprecation

### 4. Special Event Highlighting
- `HighlightSpecialEvent` tagging for critical interactions
- Separate index for instant high-priority retrieval
- Keyword-driven importance classifier (urgent, breakthrough, emotional, decisions)

### 5. Memory Decay & Auto-Consolidation
- Hourly -> Daily rollup after 7 days
- Background daemon fills empty chunks and consolidates automatically
- Archives stale entities/deprecates old edges after 30 days

## API Endpoints

### Classic v1 (backward compatible)
- `POST /api/memory` — Store memory
- `GET /api/memory/:id` — Retrieve memory
- `PUT /api/memory/:id` — Update memory
- `DELETE /api/memory/:id` — Delete memory
- `POST /api/search` — Hybrid search
- `POST /api/context` — Get context
- `GET /api/graph` — Get graph data
- `GET /api/stats` — System stats

### TKG v2 (new)
- `POST /api/v2/event` — Write event to hourly chunk
- `GET /api/v2/anchor` — Get working memory anchor
- `PUT /api/v2/anchor` — Update anchor
- `GET /api/v2/chunks` — List hourly chunks (with ?start/end)
- `POST /api/v2/chunks/fill-empty` — Fill missing empty chunks
- `GET /api/v2/chunks/:id/events` — Get events in chunk
- `GET /api/v2/events/recent` — Recent events (?hours=24)
- `GET /api/v2/special-events` — Special events (?unresolved=true)
- `POST /api/v2/special-events/:id/resolve` — Resolve special event
- `POST /api/v2/entities` — Add/ensure entity
- `POST /api/v2/relations` — Add entity relation
- `POST /api/v2/query` — Query temporal graph
- `GET /api/v2/context` — Assembled context window
- `POST /api/v2/consolidate` — Run consolidation
- `GET /api/v2/stats` — TKG statistics

## Database Schema (SQLite)

- `hourly_chunks` — Hourly time buckets with status (ACTIVE/EMPTY/CONSOLIDATED)
- `events` — Individual events within chunks (with importance/special flags)
- `entities` — Knowledge graph nodes (people, places, concepts)
- `entity_edges` — Directed relationships with temporal windows
- `working_anchor` — Singleton current state
- `daily_summaries` — Consolidated daily narratives
- `special_events_index` — Fast lookup for highlighted events

## Migration

```bash
# Migrate from classic v1 JSON to v2 SQLite
npm run migrate
```
