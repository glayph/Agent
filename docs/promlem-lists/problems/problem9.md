

### 79. Marketplace-installed skills lose third-party metadata after the next skills reload

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:5540-5556` returns a just-installed marketplace skill with `origin_kind: "third_party"`, `registry_name: "skills.sh"`, and `installed_version`.
  - `packages/core/src/api/launcher-compat.ts:2905-2930` copies marketplace skills into `src/skills/marketplace` and updates category indexes, but it does not persist registry origin metadata beside the skill.
  - `packages/core/src/skill-search.ts:4-12` defines `SkillMetadata` without registry/origin fields.
  - `packages/core/src/skill-search.ts:433-443` rebuilds skill metadata only from skill frontmatter/metadata files and the scanned path.
  - `packages/core/src/api/launcher-compat.ts:2731-2734` maps any workspace skill without registry fields to `origin_kind: "manual"`.
  - `packages/ui/frontend/src/components/agent/skills/origin-utils.ts:35-36` trusts `origin_kind` for grouping/filtering in the Skills UI.
- Impact: the install toast/result can show a marketplace skill as third-party, but after cache refresh or page reload the same skill is listed as manual and loses registry/version/link metadata. Installed-marketplace filters, badges, and detail metadata become misleading.
- Recommended fix: persist marketplace origin metadata during `copyInstalledMarketplaceSkill()` and load it in `SkillSearchEngine`, or derive `origin_kind: "third_party"` from the `marketplace` category and persist registry/version fields in a metadata file.

### 80. MQTT channel help text renders mojibake separators

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/mqtt-form.tsx:195`, `:217`, `:232`, `:239`, and `:246` render the literal text `â€”` as the separator before MQTT field descriptions.
  - `packages/ui/frontend/src/components/channels/channel-forms/mqtt-form.tsx:196`, `:218`, `:233`, `:240`, and `:247` place those separators directly beside user-facing MQTT help copy.
- Impact: the MQTT configuration page visibly displays corrupted characters, making the protocol instructions look broken and less trustworthy even when the backend channel is functional.
- Recommended fix: replace the mojibake literal with a normal ASCII separator such as ` - ` or a correctly encoded em dash, and add a text-rendering snapshot/assertion for the MQTT protocol help block.

### 81. Plugin model providers are exposed in the UI but ignored by model normalization and LiteLLM sync

- Evidence:
  - `packages/core/src/plugins/plugin-provider-adapter.ts:14` and `:120-124` define plugin provider metadata including `apiKeyEnvVar`.
  - `packages/core/src/api/launcher-compat.ts:2321-2348` appends installed plugin providers to `provider_options`, and `packages/core/src/api/launcher-compat.ts:4730` sends those options to the frontend.
  - `packages/core/src/api/launcher-compat.ts:2310-2317` resolves unknown providers with `PROVIDER_OPTIONS[3]`, the OpenRouter fallback.
  - `packages/core/src/api/launcher-compat.ts:2359` accepts a raw provider only when `getProviderOption(raw).id === raw`, so plugin provider ids are not recognized by normalization.
  - `packages/core/src/api/launcher-compat.ts:2521-2536` normalizes added/edited models through that static lookup.
  - `packages/core/src/api/launcher-compat.ts:2620-2637` checks credentials and writes LiteLLM config with static `PROVIDER_OPTIONS`, not the dynamic plugin provider list.
  - `packages/core/src/api/launcher-compat.ts:2278-2298` computes API-key env names from provider strings and does not use plugin `apiKeyEnvVar`.
- Impact: a plugin provider can appear in the model provider picker, but adding/testing/syncing a model can silently fall back to OpenRouter/static-provider behavior, ignore the plugin's base URL/auth env, and omit or misconfigure the LiteLLM runtime entry.
- Recommended fix: make provider lookup async/dynamic for model add/edit/test/fetch/sync paths, include plugin provider options in `syncLiteLLMRuntimeConfig()`, and honor plugin `apiKeyEnvVar` when resolving/storing credentials.

### 82. Agent Runs search and pagination only cover the first 100 backend rows

- Evidence:
  - `packages/ui/frontend/src/api/agent-runs.ts:125-128` defaults `listAgentRuns()` to `/api/enhancements/agent/runs?limit=100`.
  - `packages/ui/frontend/src/components/agent/runs/runs-page.tsx:150-153` always calls `listAgentRuns(100)` for the Runs page.
  - `packages/ui/frontend/src/components/agent/runs/run-list.tsx:23` sets a visible page size of 50, and `packages/ui/frontend/src/components/agent/runs/run-list.tsx:54-68` applies search/status filtering and pagination only to the already-loaded array.
  - `packages/core/src/api/enhancement-router.ts:198-199` accepts only `limit` and returns `runRecorder.list(getLimit(req, 50))`; there is no offset, cursor, query, or status parameter.
  - `packages/core/src/agent-run.ts:384-392` reads SQLite runs ordered by `updated_at DESC` with `LIMIT ?`, so older rows are never sent once the fixed limit is exceeded.
- Impact: after more than 100 runs exist, the UI pagination and search look functional but cannot reach or find older runs. Searching for a valid older run can return "no results" because the backend never sent it.
- Recommended fix: add server-side pagination/cursor and filter parameters for runs, return total/next-page metadata, and make `RunList` drive page/search state through the backend instead of filtering a fixed first page.

### 83. Health runtime job actions are only available for the first six jobs

- Evidence:
  - `packages/ui/frontend/src/api/safety.ts:169-195` exposes `cancelRuntimeJob()`, `retryRuntimeJob()`, and `getDeadLetterJobs()` wrappers.
  - `packages/core/src/api/enhancement-router.ts:354-360` returns all runtime jobs and dead-letter jobs from backend routes.
  - `packages/core/src/api/enhancement-router.ts:416-444` implements retry and cancel routes, including retry support for `failed`, `cancelled`, and `dead_letter`.
  - `packages/ui/frontend/src/components/health/health-page.tsx:125-135` computes job counts and dead-letter counts from the full job list.
  - `packages/ui/frontend/src/components/health/health-page.tsx:441-506` renders only `report.jobs.items.slice(0, 6)` and attaches retry/cancel buttons only inside that truncated list.
  - `packages/ui/frontend/src/components/health/health-page.tsx` does not import or call `getDeadLetterJobs()`, despite the API wrapper existing.
- Impact: the Health page can count queued/running/failed/dead-letter jobs that the user cannot see or act on. Any retryable/cancellable job after the first six is operationally stuck from the UI.
- Recommended fix: render a paginated/filterable runtime job table, add a dead-letter tab backed by `getDeadLetterJobs()`, and wire retry/cancel controls for every visible page row.

### 84. Health backup rollback hides older valid backups

- Evidence:
  - `packages/core/src/safety/backup.ts:40` keeps up to 50 backups by default, and `packages/core/src/safety/backup.ts:266-275` returns all backup manifests sorted newest-first.
  - `packages/core/src/safety/backup.ts:290-315` can roll back any valid backup id.
  - `packages/core/src/api/enhancement-router.ts:503` puts only `backups.listBackups().slice(0, 10)` in the full health report.
  - `packages/core/src/api/enhancement-router.ts:532-533` exposes a dedicated `/safety/backups` route that returns the full backup list.
  - `packages/ui/frontend/src/api/safety.ts:130-150` exposes create and rollback helpers, but no frontend helper for the full backup-list route.
  - `packages/ui/frontend/src/components/health/health-page.tsx:355-376` renders rollback buttons only for `report.backups.slice(0, 5)`.
- Impact: after the sixth backup, valid rollback targets are hidden from the Health page; after the eleventh, they are not even present in the full health payload. Users cannot select older restore points through the dashboard even though backend retention keeps them.
- Recommended fix: add a `listBackups()` frontend API wrapper, show a paginated backup table or drawer, and drive rollback from the full `/safety/backups` result instead of the truncated health summary.

### 85. Safe Mode can be entered but not cleared from the API or UI

- Evidence:
  - `packages/core/src/safety/safe-mode.ts:113-124` implements `SafeModeManager.clear(...)`.
  - `packages/core/src/safety/watchdog.ts:89-98` enters safe mode after repeated watchdog failures.
  - `packages/core/src/api/enhancement-router.ts:578-591` also enters safe mode when migrations fail.
  - `packages/core/src/safety/watchdog.ts:104-119` restarts watchdog probes but only returns `safeMode.getState()`; it does not clear safe-mode reasons.
  - Searches under `packages/core/src/api/enhancement-router.ts` show safe-mode status reads and `safeMode.enter(...)`, but no route that calls `safeMode.clear(...)`.
  - `packages/ui/frontend/src/components/health/health-page.tsx:219-226` displays Safe Mode as a status card, and `packages/ui/frontend/src/components/health/health-page.tsx:247-283` offers doctor, backup, scan, and watchdog actions only.
- Impact: once watchdog or migration failures put the workspace into Safe Mode, fixing the underlying problem and restarting probes does not provide a dashboard/API way to acknowledge and clear the degraded state. The system can remain permanently marked unsafe until someone edits internal state manually.
- Recommended fix: add a `POST` or `DELETE /api/enhancements/safety/safe-mode` clear endpoint with audit logging, expose per-module/all clear controls in Health, and include the safe-mode reason list in the UI.

### 86. Health secret scan hides findings after the first four

- Evidence:
  - `packages/core/src/safety/secret-scan.ts:12-16` defines `SecretScanReport.findings` as the full finding array.
  - `packages/core/src/safety/secret-scan.ts:176-220` pushes every match into `findings` and returns the complete report.
  - `packages/core/src/api/enhancement-router.ts:489` includes a full `scanSecrets(workspaceDir)` result in `/health/full`, and `packages/core/src/api/enhancement-router.ts:597-601` returns the full scan report from `/safety/secret-scan`.
  - `packages/ui/frontend/src/components/health/health-page.tsx:519-523` displays the total finding count, but `packages/ui/frontend/src/components/health/health-page.tsx:525-536` renders only `report.secretScan.findings.slice(0, 4)`.
- Impact: if five or more possible secrets are found, the dashboard admits there are more findings but hides their file paths and redacted previews. Users cannot fully triage the security issue from the Health page.
- Recommended fix: render a paginated or expandable findings table backed by the full scan report, keep the total count visible, and add tests covering more than four findings.

### 87. Model Catalog delete reports success when no catalog row was deleted

- Evidence:
  - `packages/ui/frontend/src/api/models.ts:215-222` exposes `deleteCatalog(id)` and treats any 2xx response as success.
  - `packages/ui/frontend/src/components/models/catalog-dialog.tsx:145-158` calls `deleteCatalog(id)`, removes the row from local state, and shows `models.catalog.deleteSuccess`.
  - `packages/ui/frontend/src/components/models/catalog-dialog.tsx:471` fires the delete handler from the confirmation action without revalidating that the entry still exists.
  - `packages/core/src/api/launcher-compat.ts:4999-5004` filters `state.model_catalog` by id, saves state, and always returns `{}`.
  - The backend does not compare the catalog length before/after filtering and does not return 404 for a missing id.
- Impact: stale UI state, double-click races, or concurrent deletes can produce a success toast even though the backend did not delete anything. API clients also cannot distinguish a real delete from a no-op.
- Recommended fix: return 404 when the catalog id is absent, return the deleted id or updated catalog count on success, and make the UI refresh or reconcile state after delete failures.
