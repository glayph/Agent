# Instruction Prompt: Reactive → Full Autonomy (Miki)

**Target:** Transform Agent Miki from a **user-driven (reactive)** runtime into a **continuously autonomous** agent that initiates work from its own objectives, not only from chat messages.

**Audience:** Implementers (human or coding agent) working on `https://github.com/glayph/Agent` (`main`).

**Principle:** Config flags and SOUL text are not autonomy. Autonomy exists only when a **scheduler + goal queue + agent engine** run without a user message, with durable state and safe limits.

---

## A. Problem inventory (current defects)

Treat every item below as a **must-fix** gap unless marked optional.

### A1. No proactive execution loop

1. Agent engine runs only on inbound chat / WebSocket / control HTTP — never on a timer.
2. `npm start` launches gateway + UI only; it does **not** start heartbeat, cron, or background goal pursuit.
3. `npm run runtime:24-7` is a **process supervisor** (restart on crash), not an autonomous cognition loop.
4. There is no in-process service that periodically calls `AgentEngine.run(...)` with a self-chosen goal.

### A2. Heartbeat is config-only

5. `config/agent.yaml` has `heartbeat.enabled: true` and `identity/HEARTBEAT.md`, but **no HeartbeatService** is constructed or started from gateway/core boot.
6. `heartbeat.auto_actions.enabled: false` and `max_actions_per_cycle: 0` — even a future runner would take **zero** proactive actions.
7. Heartbeat lane is documented as non-interrupting; no isolation from the main chat session is implemented in runtime code.

### A3. Autonomy block is declarative dead config

8. `autonomy.enabled: true` and sub-flags (`background_tasks`, `memory_maintenance`, `research`, `project_maintenance`, `self_evaluation`) have **no matching scheduler modules** that enqueue work.
9. `autonomy.hints.projects / researchTopics / knowledgeTopics` are empty and unused by any worker.
10. `auto_mode_switch` (escalate on idle / unfinished objectives) is not wired to real objective counters.

### A4. No durable goal / objective agency

11. Goals API (`goals-router`) is a thin SQLite CRUD surface; nothing **pursues** pending goals on a schedule.
12. No “Miki’s own will” store: no persistent list of self-generated intentions, curiosity items, or unfinished commitments separate from user chat.
13. `/agent/runs` UI is a **stub** (no list/create API); background runs cannot be observed or steered.
14. `/api/agents` and `/api/swarm/status` return empty stubs; specialist autonomy has no live registry.

### A5. Identity vs behavior mismatch

15. `identity/SOUL.md` describes a systemwide autonomous agent; runtime behavior is still “wait for user.”
16. No identity field or runtime flag for **drive / initiative** (how strongly Miki should self-start work when idle).
17. Heartbeat checklist items (`[notify]`, `[tool]`, `[memory]`) are never parsed or executed.

### A6. Safety defaults block unsupervised continuity

18. Risky tools still require approval paths that have no non-interactive policy for heartbeat/autonomy lanes.
19. Without an **autonomy approval policy** (allowlist, budget, audit-only for safe tools), a naive always-on loop would either stall on approvals or be unsafe.
20. Channels (Telegram, etc.) are mostly disabled — no external continuous stimulus either.

### A7. Self-improvement is observe-only

21. `self_improvement` intervals exist; `auto_apply_optimizations: false` and evolution `mode: observe` prevent closed-loop self-change.
22. Control page may display improvement stats, but nothing schedules reflection cycles in the background.

### A8. Operational gaps

23. No single boot path: “start Miki = always-on autonomy + chat.”
24. No metrics for: last heartbeat, objectives completed while idle, blocked-by-approval count, autonomy lane vs chat lane.
25. Docs claim autonomy features that the tree does not execute (config theater).

---

## B. Target behavior (definition of done)

When finished, Miki must:

1. **Stay alive** under supervisor or systemd (`runtime:24-7` or equivalent).
2. **On an interval** (heartbeat), read checklist + objective queue and optionally run the agent engine **without** a new user message.
3. **Maintain its own objectives** (self-generated and user-assigned), persist them, and work the highest-priority unfinished item when idle.
4. **Prefer initiative when idle** longer than `autonomy.auto_mode_switch.escalate_idle_mins_at_least` (or configured drive level).
5. **Never starve the user session**: chat/control requests preempt or pause the autonomy lane (`skip_when_main_busy: true` must be real).
6. **Respect safety**: autonomy lane uses an explicit tool allowlist + budgets; destructive actions still gated unless operator policy says otherwise.
7. **Expose truth in UI**: real runs list, heartbeat status, current self-objective, last autonomous action.
8. **SOUL-aligned**: autonomy is an expression of local-first agency, not silent cloud dependency.

---

## C. Required changes (what + how)

### C1. Boot: start autonomy with the gateway

**What:** Gateway (or launcher) must start background services after HTTP/WS is up.

**How:**

- Add `packages/core/src/autonomy/` (or `packages/core/src/runtime/`):
  - `heartbeat-service.ts` — interval timer from `heartbeat.interval_seconds`
  - `objective-store.ts` — SQLite/file store for goals + self-intentions
  - `autonomy-scheduler.ts` — picks next work item, calls `AgentEngine`
  - `autonomy-policy.ts` — tool allowlist, token/turn budgets, approval mode for autonomy lane
- From `packages/gateway/src/index.ts` (or `agent-runtime.ts` mount): after `AgentEngine` + tools are ready, call `startAutonomyRuntime(deps)`.
- Wire shutdown: clear intervals, flush objective state, emit `autonomy.stopped`.

**Default start:** `npm start` should enable autonomy when `autonomy.enabled` and `heartbeat.enabled` are true. Keep `runtime:24-7` for OS-level restart only.

### C2. Heartbeat runner (execute checklist)

**What:** Parse and run `identity/HEARTBEAT.md` on the heartbeat lane.

**How:**

- Parser for lines with optional tags: `[notify]`, `[tool]`, `[memory]`, `[noop]`.
- Each cycle:
  1. If `skip_when_main_busy` and an active chat/control run exists → skip or defer.
  2. Record health snapshot to memory/metrics.
  3. If `auto_actions.enabled` and `max_actions_per_cycle > 0`, map checklist items to tool calls or a short `AgentEngine` run with `lane: "heartbeat"`.
- Config change (required for real autonomy):

```yaml
heartbeat:
  enabled: true
  interval_seconds: 300          # start tighter than 1800 for verification; tune later
  auto_actions:
    enabled: true
    max_actions_per_cycle: 3
```

### C3. Objective queue = Miki’s own will

**What:** Durable objectives that Miki can create and pursue without a chat turn.

**How:**

- Extend goals store (or new `data/objectives.db`) with fields:
  - `source`: `user` | `self` | `heartbeat` | `system`
  - `priority`, `status`, `last_pursued_at`, `evidence`
  - `intent_text` (natural language goal)
- On idle (no user run for N minutes), scheduler:
  1. Load highest-priority `pending`/`active` objective.
  2. If none: **generate** one self-objective from SOUL + hints + recent memory (LLM call with small budget), mark `source: self`, enqueue.
  3. Run `AgentEngine` with that goal, `lane: "autonomy"`, separate session id (`miki-autonomy` or per-objective).
- Persist run id into real runs table (see C5).
- Cap self-generated objectives per day to avoid loops.

**“Own will” rules (encode in prompt + policy):**

- Prefer unfinished user commitments over new curiosity.
- Prefer local health, memory integrity, and project hints over random web activity.
- Do not invent destructive goals.
- Write a one-line “why I chose this” into the objective record (audit).

### C4. Autonomy lane on AgentEngine

**What:** Engine supports a non-chat lane with budgets and events.

**How:**

- Extend run options: `lane: "chat" | "heartbeat" | "autonomy" | "control"`.
- Per-lane limits (env or config): turns, tool calls, tokens.
- Emit events: `autonomy.cycle_start`, `autonomy.objective_selected`, `autonomy.cycle_end` on WS for monitor UI.
- Approval policy for `lane !== "chat"`:
  - Safe/read tools: auto-allow if `tools.auto_approve_safe`.
  - Destructive: queue approval or skip with logged `denied` unless operator sets autonomy risk policy.

### C5. Real runs + agents APIs (remove stubs)

**What:** Background work must be visible and queryable.

**How:**

- Replace gateway stubs:
  - `GET /api/agents` — registry of specialists / active lanes
  - `GET /api/agents/:id/messages` — recent autonomy/chat traces
  - `GET /api/swarm/status` — real counts from objective + run queues
- Implement runs store used by `AgentEngine` completion:
  - list/filter by status, lane, query
  - wire `/agent/runs` UI to this API (replace empty shell)
- Ensure every autonomy/heartbeat engine run creates a run row.

### C6. Identity: formalize initiative

**What:** SOUL and config must agree that Miki **seeks** useful work when idle.

**How:**

- Add to `config/agent.yaml` under `autonomy`:

```yaml
autonomy:
  enabled: true
  initiative:
    enabled: true
    idle_start_minutes: 5
    max_self_objectives_per_day: 12
    prefer_user_backlog: true
```

- Add a short, human-edited section to `identity/SOUL.md` or `identity/IDENTITY.md` (do not let the model rewrite SOUL):
  - Miki maintains continuity: unfinished work is resumed without being asked.
  - When idle, Miki selects the next responsible objective and acts within policy.
- Heartbeat system prompt snippet: “You are on the autonomy lane. Advance one concrete objective. Do not wait for the user.”

### C7. Scheduler features mapped from config flags

Implement workers gated by existing flags:

| Flag | Worker behavior |
|------|-----------------|
| `background_tasks` | Drain objective queue |
| `memory_maintenance` | Periodic reindex / forget noise / snapshot |
| `research` | Only if `hints.researchTopics` non-empty |
| `project_maintenance` | Only if `hints.projects` non-empty |
| `self_evaluation` | End-of-cycle score + log; optional draft notes |
| `auto_mode_switch` | Raise concurrency/budgets when unfinished ≥ N or idle ≥ threshold |

### C8. Self-improvement closed loop (optional phase 2)

- Schedule reflection per `reflection_interval_minutes` on autonomy lane.
- Keep `auto_apply_optimizations: false` until draft notes are reviewable in UI; then allow gated apply.

### C9. Single-session Chat UI constraint

- Autonomy must **not** open parallel chat sessions in the UI.
- Use internal session ids; surface results as run records + optional “Miki acted while idle” notice in the single chat thread (one system card), not a second chat.

### C10. Tests and verification

1. Unit: checklist parser; objective priority; lane budgets.
2. Integration: start gateway → wait one heartbeat interval (use short test interval) → assert run row + metric.
3. Idle initiative: no user messages → self-objective created and pursued once.
4. Preemption: start chat run during heartbeat → heartbeat skips or yields.
5. UI: `/agent/runs` shows autonomy runs; heartbeat status endpoint returns `lastCycleAt`.

---

## D. Implementation order (mandatory sequence)

1. **Runs store + API** (so later work is observable).  
2. **HeartbeatService** with metrics only (no tools) → prove timer lives.  
3. **Enable auto_actions** with read-only tools only.  
4. **Objective store + scheduler** calling `AgentEngine` on `lane: autonomy`.  
5. **Self-objective generation** when queue empty and idle.  
6. **Replace agents/swarm stubs**.  
7. **UI**: runs list + autonomy status.  
8. **Docs**: update `docs/AGENT_ENGINE.md` with autonomy lane; remove config theater.  
9. **Push to `main`** with tests green.

---

## E. Explicit non-goals (do not confuse with autonomy)

- Keeping the process up (`runtime:24-7`) alone is **not** autonomy.  
- Filling config YAML without runners is **not** autonomy.  
- Chat ReAct on user messages is **not** 24/7 autonomy.  
- Empty `/api/agents` stubs are **not** a multi-agent system.

---

## F. Acceptance checklist

- [ ] Gateway boot starts heartbeat when `heartbeat.enabled`.
- [ ] `auto_actions.enabled: true` with `max_actions_per_cycle >= 1` executes at least one safe action or engine micro-run per cycle when not busy.
- [ ] Idle period creates or pursues a `source: self` or `source: user` objective without a new user message.
- [ ] Chat traffic preempts or defers autonomy lane.
- [ ] `/agent/runs` lists autonomy and chat runs from a real store.
- [ ] `/api/swarm/status` and `/api/agents` are non-stub or removed from UI.
- [ ] Audit log records autonomy decisions (“why this objective”).
- [ ] SOUL/IDENTITY and config both describe initiative; runtime matches them.

---

## G. One-line mission for the implementing agent

**Wire a real heartbeat + objective scheduler into gateway boot, give Miki a durable self/user objective queue and an autonomy-lane AgentEngine path with budgets and visibility, and stop treating YAML flags as a substitute for a running loop.**
