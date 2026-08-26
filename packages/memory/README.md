# @miki/memory — Temporal Knowledge Graph Memory for Miki

A local-first, event-driven memory system built on a single SQLite database
(`better-sqlite3`), designed for a 24/7 autonomous agent. Every user
message, agent reply, tool call, and system event flows through one write
gateway that classifies, filters, and stores it; retrieval assembles a
compact, ready-to-inject context string for the LLM.

This package has no HTTP server, no standalone dashboard, and no separate
process. It is consumed directly as a Node module by `packages/core`
(`packages/core/src/memory/memory-bridge.ts`), which is the only integration
point — there is nothing to start or configure separately.

---

## Architecture

```
Agent turn (user msg / agent reply / tool call / system event)
        │
        ▼
   writeEvent()            ← the single memory write gateway
        │
   ┌────┴────┐
   │  noise   │  reject empty / punctuation-only / degenerate content
   │  filter  │  (never rejects real short turns like "hi" or "thanks")
   └────┬────┘
        │
   ┌────┴────┐
   │ category │  classify into one of 4 categories (keyword/heuristic,
   │ classify │  fully offline — no network call, no LLM call)
   └────┬────┘
        │
        ▼
  events / entities tables (SQLite, tagged with memory_category)
        │
        ▼
  getContextWindow() / getEventsByCategory() / getStats()
        │
        ▼
  Context string injected into the next LLM call
```

### The 4 memory categories

Every event and entity is tagged with one of:

| Category       | What lives here                                                   |
|----------------|--------------------------------------------------------------------|
| `long_term`    | Durable facts, identity, static/core knowledge — things that stay true across sessions (people, projects, configuration, preferences, definitions). |
| `daily`        | Scheduling, tasks, day-to-day operational chatter (todo, reminder, meeting, deploy, status). This is also the fallback when nothing else matches. |
| `skill`        | Tool/ability usage. Every `tool_call` / `tool_result` event is always classified here, regardless of content. |
| `rule_emotion` | Guidelines, constraints, and emotional/behavioral context — instructions on how the agent should behave, and emotional content. |

Classification is a pure keyword/heuristic match (see
`_classifyMemoryCategory` in `temporal-knowledge-graph.js`) — deterministic,
offline, and cheap enough to run on every write. A caller that already
knows the right category can force it with
`writeEvent({ ..., metadata: { memory_category: 'long_term' } })`.

`getContextWindow()` tags every recent event with its `[category]`, and
pulls `long_term` facts and `rule_emotion` instructions into their own
sections regardless of how old they are — unlike day-to-day chatter, a
standing instruction or a stated fact shouldn't silently age out of context
after 24 hours.

### The noise filter

`writeEvent()` rejects content before it reaches chunking or entity
extraction if it's empty, whitespace-only, made of nothing but
punctuation/symbols, or a single character repeated. It is deliberately
conservative: ordinary short conversational turns ("hi", "ok", "thanks")
are real conversation and are **not** filtered, since dropping them would
break turn-by-turn continuity. A caller that has already validated its own
content can pass `skipNoiseFilter: true` to bypass the check.

### Secret redaction

Before content is written anywhere — the `events` row, entity extraction,
the working anchor, or a special-event summary — `writeEvent()` runs it
through `_redactSecrets()`. This is unconditional; there is no bypass flag,
because the whole point is that a credential can never survive into a store
that gets replayed into every future LLM system prompt. It matches
credential-*shaped* substrings (GitHub tokens, OpenAI/Anthropic-style keys,
`key=value`/`token:`/`password:`-style assignments with a long unspaced
value) and replaces only the value, not surrounding prose — a sentence that
merely talks about tokens or passwords without containing one is left
untouched. This is pattern-based and deliberately conservative (a few
well-known high-confidence shapes); it is not a substitute for keeping
secrets out of chat content in the first place.

---

## Data model

Everything lives in one SQLite file (`better-sqlite3`, WAL mode). Key
tables:

- **`events`** — every message/tool-call/system-event, tagged with
  `memory_category`, `importance` (0–1), and `is_special` for high-importance
  events.
- **`entities`** — auto-extracted names/concepts, tagged with
  `memory_category`, with access-count-based reinforcement.
- **`entity_edges`** — relationships between entities, with
  similarity-based contradiction detection: a new fact that closely restates
  an existing one reinforces it; a fact that's topically similar but
  different decays the old edge instead of silently overwriting it.
- **`hourly_chunks`** / **`daily_summaries`** — time-bucketed rollups used by
  the consolidation daemon to keep old data compact.
- **`special_events_index`** — an index of high-importance events for fast
  recall.
- **`working_memory_anchor`** — a single row holding "what's going on right
  now" (current situation + key entities), refreshed as the conversation
  moves.

Pre-existing database files are migrated additively on `initialize()` (the
`memory_category` column and its index are added if missing) — no manual
migration step is needed.

---

## Usage (as a module — there is no CLI or server in this package)

```js
const { TemporalKnowledgeGraph, AgentMemoryIntegration } = require('@miki/memory');

const tkg = new TemporalKnowledgeGraph('./data/memory.db');
await tkg.initialize();

const memory = new AgentMemoryIntegration(tkg);

// Before calling the LLM: get a context string to inject as a system message
const contextStr = memory.getEnhancedSystemPrompt(userMessage);

// After the LLM responds: log the turn
memory.logInteraction(userMessage, agentResponse, { sessionId });

// Direct access to the gateway and category-scoped retrieval
tkg.writeEvent({ content: 'Deploy tomorrow before the meeting', source: 'user' });
const skillEvents = tkg.getEventsByCategory('skill', 20);
const stats = tkg.getStats(); // includes eventsByCategory / entities.byCategory
```

There is no first-install data — an empty database starts with zero
events/entities, and memory accumulates purely from what the agent
actually reads and writes as it runs.

---

## Package exports

```js
const {
  TemporalKnowledgeGraph,     // the memory engine + write gateway
  AgentMemoryIntegration,     // pre/post-turn hooks used by packages/core
  WorkingMemoryAnchor,        // "what's happening right now" tracker
  SpecialEventHighlighter,    // importance scoring used internally by writeEvent()
  MemoryConsolidationDaemon   // background hourly/daily rollup + pruning
} = require('@miki/memory');
```

---

## Tech stack

- **Runtime**: Node.js, CommonJS
- **Storage**: `better-sqlite3` (single file, WAL mode) — no other
  dependencies
- **Integration**: consumed directly by `packages/core` via
  `packages/core/src/memory/memory-bridge.ts`; no separate process, no
  network calls anywhere in the write or read path

---

## Testing

```bash
npm test
```

Runs `src/test/tkg-test-runner.js` (unit coverage for the knowledge graph,
including category classification, the noise filter, and schema migration)
and `src/test/integration-phase1.test.js` (multi-turn integration coverage).
