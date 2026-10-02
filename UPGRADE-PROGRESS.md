# Miki OpenClaw-style upgrade — progress

Rules (from the owner): Miki is a **systemwide agent** — never workspace-scoped, no sandboxing agent.
Wrongly built parts are rebuilt fully (old removed). Each finished step is delivered as a full-project zip; the next step runs in the next session.

## Step 01 — workspace/identity files: DONE (corrected)
Identity files live in `identity/` (SOUL, AGENTS + per-specialist overrides, IDENTITY, USER, TOOLS) — see `identity/README.md`.

Correction applied in this delivery (workspace-scope removed):
- `identity/SOUL.md`, `identity/AGENTS.md`: Miki described as systemwide, not workspace-scoped.
- `config/agent.yaml` (persona prompt, `security.system_access: full`, approval_note, `agents.defaults.system_access: full`), `data/launcher-state.json` mirror.
- `config/tools.yaml`: `workspace_only: false`, `allow_absolute_paths/system_paths: true` for shell/file tools.
- `packages/config/src/schema.ts` + `launcher-compat.ts` defaults: `system_access` = `full`, `restrict_to_workspace` = `false`.
- Enforcement rebuilt: file/shell tools were hard-confined to the install root regardless of config. Now confinement is opt-in only
  (`agent.security.system_access: workspace_only | isolated`) via new `packages/core/src/tools/executor/system-access.ts`
  and `ToolRegistry.applySystemAccessMode()`. SOUL.md write/delete protection and approval gates are unchanged.
- Tests: boundary tests now opt in explicitly; new systemwide-default tests + `system-access.test.ts`.
  Core suite: 118 suites / 768 tests pass; `packages/config` 41 pass.

Known pre-existing issue (untouched): `packages/core/__tests__/tools/computer.test.ts` imports a missing `computer-grid.js`
(module now at `plugins/computer-use/grid.ts`).

## Step 02 — memory system: DONE

New subsystem: `packages/core/src/memory-files/` — OpenClaw-style file memory, **systemwide** (rooted at
the same `identityDir` as step 01, one memory for the whole agent, not per workspace folder):

- `identity/MEMORY.md` — curated long-term facts/decisions (`memory_note` tool, `scope: long_term`).
- `identity/memory/YYYY-MM-DD.md` — running daily notes (`memory_note scope: daily`, and a silent
  pre-compaction "flush" of durable facts, same idea as OpenClaw's compaction-time memory write).
- `identity/memory/YYYY-MM-DD-HHMM-<slug>.md` — one file per finished session (session end, idle
  timeout, or process shutdown), summarized in the background.
- `identity/memory/compactions/*.md` — full archives of context folded into a rolling summary when a
  session's prompt filled up. **Nothing is deleted** — the live session history is untouched; only the
  *prompt view* sent to the model is compacted.

Rebuilt, not patched: the old `_compactMessagesIfNeeded` (`agent.ts`) just truncated old messages —
lossy, and it ran inline on the request path. It's removed entirely and replaced by
`memory-files/compaction.ts`'s `CompactionManager`, which folds older turns into a bounded rolling
summary (topics / decisions & facts / outcomes / tools / files), keeps recent turns verbatim, never
splits a tool result from its assistant call, and archives the summary to
`memory/compactions/*.md` so `memory_search`/`memory_get` can still recover it later.

Also rebuilt: every synchronous SQLite/TKG memory write in `agent.ts` (`logInteraction`,
`logToolCall`, capability-plan, self-improvement failure records) now runs through
`FileMemoryService.background()` — a two-lane (fast/slow) async writer that can never block or fail a
turn. The TKG memory itself (`packages/memory/`) is untouched and keeps working exactly as before;
only its write path moved off the critical path.

New agent-facing tools: `memory_search` (offline BM25, Bengali+Latin aware), `memory_get` (read a
file / line range), `memory_note` (explicit "remember this"). All three are confined to
`MEMORY.md` / `memory/**.md` — never arbitrary files.

Summarization: `summarizer: auto | llm | heuristic` (`config/agent.yaml` →
`agent.memory.files.summarizer`, default `auto`). Heuristic (offline, deterministic) always exists as
the floor; in `auto` mode an LLM call is attempted in the background only when the active model isn't
local (`isLocalModelName`), with a timeout and full fallback to heuristic on any error — so file
memory works with zero network/LLM access. Secrets (API keys, tokens, private keys, "password: ...")
are redacted before anything touches disk.

Config: `agent.memory.files.*` in `config/agent.yaml` (schema added to `packages/config/src/schema.ts`,
fully optional/clamped — a garbled config block falls back to safe defaults, never throws).

Wiring in `agent.ts`: `FileMemoryService` is created once per orchestrator (`this.fileMemory`); its
context block (`MEMORY.md` + a recent-notes index) is appended after the identity files in
`_buildSystemContent` (via `loadIdentityContext(..., fileMemoryBlock)`) and, compact form, in
`_buildSimpleSystemContent`; `deleteSession`/`stopBackgroundTasks`/`close` now summarize/flush memory
before tearing a session or the process down; an idle-session sweeper runs on the same interval as
existing background tasks.

Tests: 8 new suites / 62 tests for `memory-files/*` (store, writer, compaction, summarizer, search,
context, config, service integration — covering redaction, non-blocking writer semantics, non-destructive
compaction, tool-result adjacency, LLM-timeout/failure fallback, Bengali search, path-traversal refusal).
Existing suites re-verified and green: all 44 top-level `packages/core/src/*.test.ts` (274 tests),
`identity/*` (incl. `loader.test.ts` extended for the new memory-block parameter), `tools/registry/*`,
`mcp/contracts/*`, `contextual-tool-pruner`/`adaptive-capability-selector` (already listed `memory_search`
in their fallback tool lists — matches the new tool name with no changes needed there), and all of
`packages/config` (41 tests, schema addition is additive/optional). `agent-memory-tool-logging.test.ts`
was updated (not behavior-weakened) to `await agent.fileMemory.writer.drain()` before asserting on the
now-async SQLite/TKG log calls — the calls themselves, their arguments, and the "never blocks/throws"
guarantees are unchanged, only the timing.

Manual-review note (pre-existing, not a regression): running `agent-memory-tool-logging.test.ts`'s
last case surfaces a caught-and-logged `capability-plan` background write error ("Cannot read
properties of undefined (reading 'writeEvent')") — that test's minimal memory mock only implements
`logInteraction`/`logToolCall`/`getEnhancedSystemPrompt`, not whatever the capability-plan write path
expects; it was already broken before this step (silently, inline, same try/catch), just not exercised
this directly before. Doesn't fail any test or affect a real turn; worth a look whenever that mock is
next touched.

Open question (per master plan step 6 — flagged, not blocking): the sandbox used for this session
could not finish a single `jest` run across *all* core suites (118 suites/768 tests per step 01's note)
within the tool time budget, and background (`nohup ... &`) processes get killed between tool calls
here. Ran everything in scoped batches instead (44 top-level files, `memory-files/*`, `identity/*`,
`tools/`, `mcp/contracts/`, `contextual-tool-pruner`/`adaptive-capability-selector`/`token-budget-manager`,
all of `packages/config`) — all green, but a handful of subdirectories under `packages/core/src/`
(e.g. `autonomy/`, `control/`, `plugins/**`, `observability/`, `security/`, `self-improvement/`,
`skill-governance/`, `system-index/`) were not re-run this session since this step doesn't touch them.
Worth a full `npm test` locally once, outside this sandbox, before moving on.

## Step 03 — model provider & failover: DONE

Full reference: `docs/model-router.md`. Code: `packages/core/src/llm/model-router/`.

New: **`ModelRouter`** — the single entry point for every model call. Lane profiles
(`default`, `complex`, `heartbeat`, `subagent`, `background`, any custom name) with `primary` +
`fallbacks`, per-role bindings (`miki`/`sage`/`forge`/`scout`), credential rotation on the same provider
(secret *names* only, same-provider enforced), then fallback along the chain. Every hop is logged
(secrets redacted), kept in `recentHops()`, emitted via `onHop()` (step-11 seam) and counted in `stats()`.

**Strict explicit override**: a model chosen in the UI/API (`requestedModel`) is tagged
`explicit_override`; if it cannot serve the call the turn fails visibly (`ExplicitModelUnavailableError`,
user text: "…selected explicitly, so no other model was substituted") — never a silent fallback.

Rebuilt, not patched (old code removed):
- `agent.ts` `_resolveTurnModel` (hand-written preference list + `synchronizeLocalRuntimeForModel` calls) →
  `router.selectReady()`; the one-off **BUG-04** "missing key → retry once on local model" block → generic failover.
- `_callLlmApi` now shapes the request only; options are re-derived per candidate model (local vs remote
  tool settings). `achatCompletion` (llm.ts) is a thin wrapper over the default router.
- Memory summarizer and self-improvement cycles → `background` lane via the router.
- Autonomous (heartbeat-driven) turns → `heartbeat` lane (if configured); specialist runs → `subagent` lane + role profile.
- Plugin `model-router.provider-registry` rewritten (it passed `extra` as provider options); now routes via the router.
- `config/agent.yaml`, `data/launcher-state.json`, `scripts/configure-local-model.mjs`: `model_routing` → `model_router.lanes`.
  The old block is still read (auto-migrated to lanes + deprecation warning) when `model_router` is absent.
- `packages/config/src/schema.ts`: lenient `agent.model_router` (a typo can't reject the whole config).

Guard: `llm/model-router/boundary.test.ts` statically fails if any source outside the provider layer calls a provider
directly (mutation-checked). Probes (`completion-health`, `tool-health`) are explicitly allowlisted as non-agent calls.

Tests: 4 new suites for the router (config, failure classifier, router, boundary — 56 tests) + `agent-model-routing.test.ts`
(7 integration tests: lane routing, strict explicit override, mid-turn outage → fallback + hop log, all-down message,
reloadConfig) + 2 schema tests. Provider layer: existing `provider-boundary`, `completion-health`, `tool-health`, plugin adapter all green.
Regression: every `packages/core/src/**` suite passes (agent, api, autonomy, control, identity, llm, mcp, memory-files, plugins,
tools, …). Outside `src/`, the suites `packages/core/__tests__`, `gateway`, `memory`, `config`, `cli`, `installer` have the **same 8 failing
suites on the original Miki.zip and after this step** (diffed: identical set; e.g. `restart-policy.test.ts` needs `vitest`, `computer.test.ts`
imports a moved module, a few Windows/path-specific cases) — pre-existing, untouched. Typecheck: no new errors vs baseline.

Behaviour notes / open questions (non-blocking, defaults chosen):
- Shipped `heartbeat` and `subagent` lanes use `gemini/gemini-3.5-flash-lite` (cheap) with the local model as fallback.
  Change in `config/agent.yaml` if you'd rather keep heartbeat fully local.
- A failover is **sticky for the rest of the turn** (a down primary isn't retried at every tool step); the next turn starts on the primary again.
- Per-attempt deadlines are local 90 s / remote 120 s; the whole chain is capped at 300 s (previously a single 120 s cap — only differs when the first model hangs).
- Learned routing (apply mode only) can reorder within the lane chain; it can't push a model that is in no configured lane.
- Not done here (belongs to later steps): router stats/hops in `doctor`/CLI (step 12), hook-bus events (step 11),
  heartbeat/cron/sub-agent schedulers passing `lane` (steps 08–10). Hooks for all three already exist (`onHop`, `stats`, `lane`/`role` options).
- Credential profiles need a second key stored under e.g. `GEMINI_API_KEY_2`; with none stored, rotation is skipped and failover goes straight to the next model.

## Next: Step 04 — tool execution & permission layer (`04-tool-exec-permissions.md`)


## Step 06 — Gateway / Input-Surface Layer: DONE

OpenClaw-style input normalization: any origin (CLI, IDE, task API, webhook, chat apps)
becomes one `InboundEvent` before queue/agent handling.

### What was built
- New module `packages/core/src/input-surface/`:
  - `types.ts` — `SurfaceId`, `InboundEvent` (`surface`, `session_key`, `payload`, `timestamp`, `sender_meta`)
  - `session-key.ts` — deterministic `resolveSessionKey(surface + conversation/thread + agentRole)`
  - `normalize.ts` — shared normalizer
  - `adapters.ts` — CLI + webhook + JSON adapters for all surfaces; new surface = new adapter only
  - `registry.ts` — `SurfaceAdapterRegistry` / `createDefaultSurfaceRegistry()`
  - `ingest.ts` — **single entry** `ingest(raw, surfaceId, { sink? })` — adapters never call agent core
  - `input-surface.test.ts` — acceptance tests (two dummy surfaces, deterministic session_key)
- `enhancement-router.ts`:
  - `/events/inbound` accepts `surface` or legacy `channel`, routes through `ingest()` then job queue
  - `/runtime/surfaces` lists registered surfaces
- Existing `event-envelope.ts` (channel adapters / delivery) left intact for outbound/delivery paths.

### Behavior contract
1. New surface = register adapter only; no agent-core file changes required.
2. Same `session_key` rules on every surface.
3. Raw events never reach the agent core; only normalized `InboundEvent` is sunk to the queue.

### Acceptance
- [x] CLI + webhook adapters emit the same `InboundEvent` shape
- [x] `session_key` unit-tested deterministic (`cli:conv-1:miki`)
- [x] New surface (`task_api`) added via adapter registration only

### Verify
Manual/runtime check via `tsx` (ALL_CHECKS_PASSED): session keys, dual-surface shape, ingest sink isolation.

## Next: Step 07 — command queue (depends on this layer's `session_key` + `InboundEvent`)

### Step 06 — verify + optimize (re-pass)
Fixes:
- `session_key`: bare legacy `sessionId` promoted via formula; full `surface:thread:role` keys kept
- adapters: `sessionId` → conversationId (not raw session_key); envelope keys stripped from payload
- `channelToSurface`: allocation-free mapping
- CLI/webhook JSON adapters cached (no per-call allocation)
- CLI/webhook default sender for ergonomics; generic adapters still require sender

Runtime verify: **14/14 ALL_CHECKS_PASSED** (deterministic key, dual-surface shape, legacy map, ingest sink isolation, extensibility).

## Step 07 — Command Queue & Concurrency: DONE

Lane-aware command queue with per-`session_key` serialization and four modes
(followup / collect / interrupt / steer). Rebuild (not a patch on ad-hoc lock logic).

### Built
- `packages/core/src/command-queue/`
  - `types.ts` — modes, lanes, config, drop policy, events
  - `resolve-mode.ts` — priority: inline → session → surface → global → `steer`
  - `command-queue.ts` — `CommandQueue` class
  - `command-queue.test.ts` — concurrency + mode + drop acceptance tests
  - `index.ts` — public exports
- Lanes: `main` (cap 32), `subagent` (8), `heartbeat` (2)
- Modes:
  - **followup** — queue behind active run
  - **collect** — debounce + coalesce messages into one turn
  - **interrupt** — AbortController cancels active run, then starts new
  - **steer** — mid-turn inject when hook registered; else `steerFallback` (followup)
- Drop policy: `reject_new` (default) or `drop_oldest`; always logged via events
- Wired: `POST /events/inbound` sink → `commandQueue.enqueue` → job queue
- `GET /runtime/command-queue` diagnostics

### Behavior contract
1. Same `session_key` → never two concurrent active runs
2. Different `session_key` → parallel up to lane cap
3. Modes follow documented behavior
4. Non-interrupt modes never cancel the active run

### Existing code
- `sessionTurnLock` remains for channel/scheduler paths (compatible FIFO)
- `TaskQueue` (persistent agent tasks) unchanged — orthogonal persistence layer

## Step 08 — Heartbeat System: DONE

OpenClaw-style proactive 24/7 loop. Separate from legacy `HeartbeatEngine`
(maintenance pulse). New module uses Step 07 `heartbeat` lane so user main-lane
sessions are never interrupted.

### Built
- `packages/core/src/heartbeat-system/`
  - `types.ts` — config, response types, cycle results
  - `quiet-hours.ts` — quiet window (overnight supported)
  - `checklist.ts` — HEARTBEAT.md parser + `[notify]|[tool]|[memory]|[noop]` prefixes
  - `runner.ts` — `HeartbeatRunner` / `runHeartbeatNow(dryRun)`
  - `scheduler.ts` — interval scheduler
  - `heartbeat-system.test.ts`
- `identity/HEARTBEAT.md` — default checklist
- `config/agent.yaml` — interval 1800s, checklist_path, skip_when_main_busy
- API: `GET /runtime/heartbeat`, `POST /runtime/heartbeat/run` `{ dry_run?: bool }`

### Behavior contract
1. Interval scheduler fires without user input
2. quiet_hours suppresses cycles
3. Heartbeat uses `heartbeat` lane / skipWhenMainBusy — never corrupts main run
4. dry_run reports without side effects

### Response types
no_op · proactive_notify · silent_tool_run · memory_update

### Step 08 — verify + optimize (re-pass)
Fixes / optimizations:
- `dry_run` bypasses quiet_hours and enabled (testing always works)
- concurrent `runNow` serialized (no overlapping cycles)
- scheduler uses setTimeout chain (no stacked intervals; config interval applies next cycle)
- intervalSeconds clamped to ≥ 1
- checklist file read errors → empty list
- hook errors isolated per item (cycle continues)
- role-aware checklist path helper (`identity/agents/<role>/HEARTBEAT.md`)

Runtime verify: **25/25 ALL_CHECKS_PASSED**.

## Step 11 — Hooks / Lifecycle Events: DONE

Lightweight `EventBus` for lifecycle extension seams. Additive emits only —
no existing function signatures broken.

### Built
- `packages/core/src/hooks/`
  - `events.ts` — canonical event names + payload types
  - `event-bus.ts` — `on` / `emit` / `emitAsync`, priority order, timeout, isolation
  - `hooks.test.ts` — exception isolation, order, block, full catalog fire
  - `index.ts` — exports + `getLifecycleBus()` singleton

### Events
session:start|end|reset · session:compact:before|after · workspace:bootstrap ·
gateway:startup|shutdown · message:received|sent · tool:before_call|after_call ·
subagent:spawned|ended · command:new|reset|stop

### Wire points (additive)
- enhancement-router: gateway:startup, workspace:bootstrap, message:received
- command-queue: session:start / session:end
- tool registry executeToolStructured: tool:before_call (blockable) / tool:after_call
- memory compaction: session:compact:before|after (bridged)

### Behavior contract
1. Handler throw/timeout → logged, core continues
2. Handlers must stay request-scoped (no long-lived sockets in hook body)
3. Order: priority DESC, then registration order ASC

## Step 09 — Cron Scheduler: DONE

OpenClaw-style persisted cron jobs (JSON store). Coexists with existing
`TaskScheduler` (SQLite); this module is the Step 09 surface:
`cron_add` / `cron_list` / `cron_run` / `cron_remove`.

### Built
- `packages/core/src/cron/`
  - `types.ts` — job shape, main|isolated, miss policy
  - `store.ts` — `state/cron/jobs.json` atomic persist
  - `schedule.ts` — once + cron next-run (5-field, @hourly, every N)
  - `service.ts` — CronScheduler + convenience API
  - `cron.test.ts`
- API: `GET/POST /runtime/cron`, `POST /runtime/cron/:id/run`, `DELETE /runtime/cron/:id`
- Wired into enhancement-router with CommandQueue

### Behavior
1. Jobs survive restart (reload from jobs.json)
2. delete_after_run removes one-shot after success
3. isolated → session_key `cron:isolated:<id>` on subagent lane (main untouched)
4. missed runs: default skip + log; optional run_on_load

### Verify: 12/12 PASS
