
### 15. CLI preflight checks only the gateway port, not supervised core or LiteLLM ports

- Evidence:
  - `packages/Hiro-cli/config.go:21-33` exposes only `Host` and gateway `Port` in CLI config.
  - `packages/Hiro-cli/runtime.go:73-77` checks only `r.cfg.Port` before starting the runtime.
  - `packages/Hiro-cli/runtime.go:348-357` passes only `GATEWAY_HOST` and `GATEWAY_PORT` into the spawned runtime.
  - `packages/gateway/src/index.ts:58-61` defaults `CORE_PORT` to `8000` and `LITELLM_PORT` to `4000`.
  - `packages/gateway/src/index.ts:438-464` and `packages/gateway/src/index.ts:705` depend on `CORE_PORT`.
- Impact: `Hiro --port <free-port>` can pass preflight while core port `8000` or LiteLLM port `4000` is occupied. Multiple instances using different gateway ports still collide on the dependent default ports.
- Recommended fix: make the CLI validate and/or allocate all supervised ports, then pass them into the runtime. If automatic allocation is used, surface the selected ports in runtime state and health output.

### 16. Gateway-owned LiteLLM control routes are not authenticated

- Evidence:
  - `packages/gateway/src/index.ts:524-548` applies CORS/security headers but does not authenticate requests.
  - `packages/gateway/src/index.ts:648-690` exposes LiteLLM status, logs, and model-list routes directly under `/gateway/litellm/*`.
  - `packages/gateway/src/index.ts:692-700` exposes `POST /gateway/litellm/restart` directly and calls `restartLiteLLM()`.
  - `packages/ui/frontend/src/api/litellm.ts:68-74` calls `/gateway/litellm/restart` from the authenticated dashboard, but the gateway route itself does not verify the dashboard cookie or an API key.
- Impact: any client that can reach the gateway can read LiteLLM gateway status/log metadata and restart LiteLLM without dashboard authentication. With LAN Access enabled, this becomes a remote network control endpoint.
- Recommended fix: add gateway-side auth middleware for all non-health `/gateway/*` routes. Accept the dashboard session cookie and/or a strong API key, or route these operations through the authenticated `/api` compatibility router.

### 17. Direct core control endpoints are unauthenticated when API-key auth is disabled

- Evidence:
  - `packages/core/src/api/auth-middleware.ts:40-47` enables API-key auth only when `ENABLE_API_KEY_AUTH === "true"`.
  - `packages/core/src/api/index.ts:497-518` mounts optional API-key validation, then exposes direct `/sessions` routes outside the dashboard `/api` router.
  - `packages/core/src/api/index.ts:1320-1368` exposes `POST /tools/:name/call`; it checks session permissions only when the caller supplies `session_id`.
  - `packages/core/src/tools/executor/shell.ts:90-120` treats `TRUSTED_FULL_ACCESS` as open access.
  - `config/tools.yaml:1-6` configures `shell_execute` as `TRUSTED_FULL_ACCESS` with `workspace_only: false`.
- Impact: on the core port, direct API clients can call control endpoints without the dashboard session when API-key auth is off. In this workspace configuration, that can include unrestricted shell execution through `/tools/shell_execute/call`.
- Recommended fix: require authentication for direct core control routes by default, or remove/disable direct non-`/api` control routes in the packaged runtime. If direct API mode is still needed, make strong API-key auth mandatory before mounting tool/session/chat endpoints.

### 18. Non-secret `.env` updates are written without dotenv-safe escaping

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:1400-1404` trims strings but does not reject embedded CR/LF characters.
  - `packages/core/src/api/launcher-compat.ts:2016-2046` writes non-secret values as raw `KEY=value` lines.
  - `packages/core/src/api/launcher-compat.ts:3288-3295` can persist `WHATSAPP_BRIDGE_URL` through that raw writer.
  - `packages/core/src/api/launcher-compat.ts:3476-3496` can persist IRC server/nick/channels values through that raw writer.
- Impact: an authenticated dashboard config value containing a newline can inject extra lines into `.env`, creating hidden runtime config changes after restart.
- Recommended fix: reject CR/LF in `.env` values or write through a dotenv serializer that quotes and escapes values correctly. Apply the same validation before updating `process.env`.

### 19. Dashboard login throttling collapses all gateway clients into one failure bucket

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:405-406` sets an 8-failure limit per 10 minutes.
  - `packages/core/src/api/launcher-compat.ts:1991-2014` keys login failures by `req.ip || req.socket.remoteAddress`.
  - `packages/gateway/src/index.ts:706-715` proxies `/api` to core without `xfwd: true` or another explicit client-IP header strategy.
  - Searching core/gateway shows no `trust proxy` configuration.
- Impact: through the gateway, core sees the gateway connection address instead of the real browser/LAN client. One client can lock out every dashboard user behind the gateway until the failure window expires.
- Recommended fix: forward and trust client IPs deliberately for loopback gateway traffic, then key login throttling by the verified forwarded address. Alternatively move login throttling to the gateway before proxying.

### 20. Runtime job queue API enqueues jobs that no worker consumes

- Evidence:
  - `packages/core/src/api/enhancement-router.ts:141-143` creates a `PersistentJobQueue` for `data/runtime-jobs.json`.
  - `packages/core/src/api/enhancement-router.ts:363-390` exposes `POST /runtime/jobs` and enqueues jobs.
  - `packages/core/src/persistent-job-queue.ts:77-86` provides `dequeue()`, but searching runtime source finds no consumer for the enhancement-router queue.
  - `packages/ui/frontend/src/api/safety.ts:65-80` and `packages/ui/frontend/src/components/health/health-page.tsx:456-516` expose runtime jobs in the health UI.
- Impact: jobs created through the runtime jobs API remain queued indefinitely. The health UI can show/cancel/retry jobs, but there is no backend worker progressing them.
- Recommended fix: either wire a real worker that dequeues and executes supported job types, or remove/disable the enqueue surface and present the queue as read-only telemetry.

### 21. Safety rollback does not remove files added after the backup

- Evidence:
  - `packages/core/src/safety/backup.ts:98-115` copies directories recursively but never clears the destination directory first.
  - `packages/core/src/safety/backup.ts:290-307` rolls back by copying each backup entry over the current workspace path.
  - `packages/core/src/safety/backup.ts:318-337` backs up the whole `config` directory plus selected data files.
- Impact: rollback is not a true restore. If a config file is added after a backup, rolling back to the older backup leaves that new file in place, so runtime configuration can remain polluted by stale files.
- Recommended fix: for directory entries, restore into a temporary directory and atomically replace the destination, or delete the destination directory after creating the pre-rollback backup and before copying the selected backup entry.

### 22. Plugin channel runtime caps stdout but not stderr

- Evidence:
  - `packages/core/src/plugins/plugin-channel-runtime.ts:485-503` enforces `max_output_bytes` using `processState.outputBytes` for stdout.
  - `packages/core/src/plugins/plugin-channel-runtime.ts:519-527` buffers and logs stderr lines without incrementing `outputBytes` or enforcing a size cap.
  - `packages/core/src/plugins/plugin-channel-runtime.ts:680-690` keeps writing JSON messages to the long-running plugin process while it remains active.
- Impact: a plugin channel process can continuously write stderr, growing `stderrBuffer` for unterminated lines or flooding logs without hitting the configured output limit.
- Recommended fix: count stderr bytes toward the same output budget, cap partial stderr buffers, and stop the plugin process when either stream exceeds the configured limit.

### 23. LiteLLM restart helper can turn successful restarts into user-visible failures

- Evidence:
  - `packages/ui/frontend/src/api/litellm.ts:68-78` first posts to `/gateway/litellm/restart`, then posts to `/api/gateway/restart`, and catches failures from either call.
  - In that catch block it posts to `/api/litellm/restart` and always throws `LiteLLM restart requires the gateway process.`
  - `packages/core/src/api/launcher-compat.ts:4419-4429` already exposes authenticated `/api/litellm/restart` for applying a LiteLLM restart.
  - `packages/ui/frontend/src/components/models/litellm-status-panel.tsx:101-114` reports the thrown helper error directly to the user.
- Impact: if the direct gateway LiteLLM restart succeeds but the follow-up gateway restart fails, the UI reports failure and runs a second restart path. The helper also drops the actual failure reason.
- Recommended fix: use one authenticated restart path, return and display its runtime apply status, and only fall back when the selected path is genuinely unavailable.

### 24. Full health report runs heavyweight synchronous checks on every page load

- Evidence:
  - `packages/core/src/api/enhancement-router.ts:471-510` builds `/health/full` by running doctor checks, `scanSecrets(workspaceDir)`, backup listing, migration dry-run, and audit listing in one request.
  - `packages/core/src/safety/secret-scan.ts:53-85` walks configured directories synchronously.
  - `packages/core/src/safety/secret-scan.ts:180-220` synchronously reads candidate files up to 2 MB each.
  - `packages/ui/frontend/src/components/health/health-page.tsx:104-120` loads that full report when the health page mounts.
- Impact: opening the health page can block the Node event loop with filesystem scanning and migration dry-run work. On large logs/docs/config trees, this can slow unrelated API requests.
- Recommended fix: cache full-health components with short TTLs, move secret scanning/migration dry-runs behind explicit actions or background jobs, and make `/health/full` return the latest cached summary.
