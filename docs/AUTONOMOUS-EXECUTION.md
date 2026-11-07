# Miki autonomous execution workflow

This implementation extends the existing AgentEngine and durable task runtime. It does not create a second goal database or remove existing autonomy, tool, browser, computer, plugin, recovery, or memory features.

## Run lifecycle

1. The Gateway captures the user goal and creates the existing durable task record.
2. Unless planning is explicitly disabled or a checkpoint already carries a plan, the planning model creates an `AgentPlan` before execution starts. The planner chooses the number of steps and tools; there is no natural-language keyword router.
3. `AgentEngine` executes the plan through its existing tool registry and run loop. Each tool action is associated with the active plan step where possible.
4. When `agent.verify_actions` is enabled (default: `true`), a separate LLM completion checks the result of each successful tool call. A generic tool success flag is not enough to mark a step complete. A step reaches `done` only when the action verifier returns `verified`; ambiguous or unavailable verification is sent back to the agent as a request for more evidence.
5. The existing answer self-check remains a separate optional final-response check.

## User steering and recovery

Messages received while a run is active are assigned stable message IDs and stored in the SQLite `miki_agent_steer_inbox` table before they are queued in memory. They are supplied to the model at the next turn, and the corresponding run checkpoint is persisted immediately after delivery. On a resumed run, unconsumed messages are restored from SQLite. Existing user-stop, tool interruption, task checkpoint, and crash-recovery behavior remains in place.

## Temporary plan and todo files

The backend collector writes the latest plan and todo snapshot while a run is active:

- `<MIKI_DATA_DIR>/Runtime/Goals/<run-id>/plan.md`
- `<MIKI_DATA_DIR>/Runtime/Goals/<run-id>/todo.md`
- `<MIKI_DATA_DIR>/Runtime/Goals/<run-id>/goal.json`

When `MIKI_DATA_DIR` is not set, the Gateway's existing default data directory is `<project>/data`. A completed run removes its temporary goal directory. Failed, cancelled, or otherwise unfinished runs retain it for recovery and inspection.

## Independent cache collector

The `RunArtifactCollector` is a Gateway-side event observer, not an Agent tool. Its asynchronous writer stores JSONL records under `<MIKI_DATA_DIR>/Cache/` in `events`, `user-input`, `plans`, `todo`, `actions`, `verification`, and `recovery` categories. Writes are queued separately from the model/tool loop, use restrictive file permissions where supported, and redact common credential fields and inline credential assignments. The collector is flushed on Gateway shutdown.

The cache is an observation dataset; it does not train or modify a model by itself. Any future learning pipeline should consume reviewed/filtered cache records through the existing learning/evaluation workflow.

## Turbo execution and boundaries

The existing Turbo Mode remains enabled for ordinary registered tools when the configured guest sandbox and approval settings permit it. This change does not remove the runtime's hard capability denials, learned block rules, host/guest boundary, audit logging, provider limits, or host resource admission. Provider outages, authentication failures, unavailable capabilities, and resource pressure are reported/recovered through the existing retry and supervisor paths rather than bypassed.

## Verification commands

```bash
npm install
npm run build:all
npm run test:agent-core
npm run test:gateway
npm run dev
```

The repository requires Node.js `>=22.19.0`. The implementation environment should use a matching Node.js release before the full build/test suite is considered authoritative.
