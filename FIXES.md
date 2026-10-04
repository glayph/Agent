# API connection fixes

Frontend calls that had no backend route (404 / SPA HTML parsed as JSON):

- `GET /api/agents`, `GET /api/agents/:id/messages` -> new `core/src/api/swarm-router.ts`
- `GET /api/swarm/status` -> same router (agent registry + task queue stats)
- `GET|POST /api/goals`, `PATCH /api/goals/:id` -> new `core/src/api/goals-router.ts` (SQLite `data/goals.db`)
- `DELETE|GET /api/tasks/:id` -> alias added in `core/src/api/index.ts` (gateway only proxies `/api/*`);
  frontend `features/chat/controller.ts` now calls `/api/tasks/:id` directly.
- `agent-message-bus.ts`: bounded recent-message history so the agent activity log has data.

All new routes are protected by `requireHttpAuth` (dashboard session or API key) and mounted
before the launcher compat router, scoped to their own paths so `/api/auth/*` is untouched.

# Step 1: Agent/Core execution wired into the gateway

* New `packages/core/src/engine/*` (agent loop, planner, tool registry, approvals, built-in tools, LLM client); exported as `@miki/core/engine`.
* Gateway chat (`/miki/ws`) now runs the agent loop (plan, tool calls, approvals, cancel) instead of a single completion.
* `/api/control/{capabilities,state,operations,plan,execute,approvals}` and `/api/test` are real (see `docs/AGENT_ENGINE.md`).
* `/api/tasks/:id` (GET/DELETE) and WebSocket `cancel_task` cancel active runs.
* Control endpoints, approvals, `/api/test` and the agent WebSocket require the dashboard session once a password is set.
* `MIKI_DATA_DIR` overrides the gateway data directory.

# Step 2: Files / Drive

* The gateway now mounts the full file manager (`@miki/core/file-manager`) instead of 10 minimal handlers: upload, download, archive download, preview (with Range), conflict-checked write, recursive copy/move.
* `POST /api/files/run` really runs scripts (`packages/core/src/engine/file-runner.ts`): no shell, env allowlist, timeout, output cap, process-group kill, concurrency limit, audit table `file_runs`. The "Execution is disabled by the safe workspace policy" stub is gone; `MIKI_FILE_EXECUTION=false` is the kill switch.
* Protected-path policy: data dir and credential files are hidden/blocked in every route and skipped in archives.
* New agent tools: `file_info`, `file_mkdir`, `file_rename`, `file_move`, `file_copy`, `file_delete`, `file_run` (approval gated).
* `/api/files/*` now requires the dashboard session.
* Core exports added: `@miki/core/file-manager`, `@miki/core/paths`.
