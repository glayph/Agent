# Deep Audit Live Findings

## Initial runtime

- The integrated runtime started successfully on Linux.
- Gateway: `http://127.0.0.1:18800`.
- Core target: `127.0.0.1:8000`, reported healthy.
- Memory stub: `http://127.0.0.1:18700`.
- Dashboard setup and login forms accepted a temporary test password and reached the protected dashboard.

## Agent Control page

- Route: `/control`.
- The page exposes active-model and resource-profile selects, refresh, and backend shutdown controls.
- It reports a typed capability inventory, sanitized runtime state, model/runtime management, active model selection, model state, supported runtime configuration, tool enablement, and runtime reload.
- The visible active model entries were mostly marked `unconfigured`; no dashboard-registered tools were exposed at the time of inspection.
- Sanitized state redacted token-like configuration values and showed workspace-only access, sandbox mode, audit logging, approval-required destructive tools, and heartbeat enabled with auto-actions disabled.

## Automation Center page

- Route: `/agent/automations`.
- The overview rendered successfully with zero configured workflows, zero active schedules, and links to Automations, Create, History, and Connections.
- The page provides a `Create automation` action and clearly states that only active workflows can create linked runs.

## Automation creation validation

- The create form renders with a default `steps` state and a default recurring schedule, but `objective` starts empty even though its placeholder looks like usable content. Submitting without entering an objective correctly produced `Objective and at least one step are required.` This is valid required-field behavior, not yet a defect; the UI could be clearer by marking the objective required and distinguishing placeholders from values.
- The first attempted save did not create a workflow because objective was empty. Next validation will enter a real objective and verify persistence.


## Valid workflow and manual run

- Entering a real objective allowed the automation to save successfully.
- The list page showed one configured, active Research workflow with two ordered steps and a linked Run.
- The `Run now` action created a second linked Run marked `Pending · manual`; this confirms the UI reaches the backend, although completion and failure handling still need verification.


## Baseline validation

- The complete production build passed, including the frontend bundle and workspace builds.
- The repository acceptance check reported no failures; live mode also returned HTTP 200 from `/gateway/health`, with `status: ok` and `coreHealthy: true`.
- The 24/7 readiness check passed and resolved the built gateway entrypoint.
- The local LFM smoke test failed with `fetch failed` because no local llama.cpp endpoint was listening at the default address. This is an environment-readiness gap, not yet a code defect.
- Execution history later showed the manual workflow run as `Completed` and the scheduled run as `Pending`, which is consistent with the scheduled date being in the future.


## Models and Tools surfaces

The Models page rendered successfully and showed provider catalogs for Google Gemini, OpenAI, and OpenRouter. The Gemini entries were unconfigured, while the dashboard displayed masked OpenAI credentials already present in the runtime configuration. The page also exposed local speech-to-text readiness and install controls without automatically downloading a model. This confirms the UI can distinguish configured from unconfigured providers, but local LFM was not represented as a ready endpoint in this clean runtime.

The Tools page rendered a large guarded registry. It exposed filesystem, shell, browser, computer, model, workflow, runtime, admin, skill, connection, and search tools with risk labels and enable/disable switches. The page correctly described shell and file mutation as high risk and retained separate controls for remote connections and model management. No obvious UI exception appeared in the rendered page.


## Memory search

The Memory page rendered with one active chunk, 48 postings, and one retrieval trace. Searching for the natural-language phrase `capability plan` returned `0 selected · 0 candidates`, even though the visible chunk contained a capability-plan record. This is a likely search/indexing or tokenization defect and will be traced in the memory API and backend implementation.


## Repair and restart

The dashboard memory route was patched to pass all canonical regions explicitly for operator searches, while leaving agent-context region inference unchanged. A focused regression test was added and the full memory package test suite passed. Core and gateway rebuilt successfully, and the restarted runtime reported a healthy core and gateway. The restart correctly required a new dashboard login, which succeeded with the temporary test credential.


## Memory search repair verified

After rebuilding and restarting, the same dashboard search for `capability plan` returned one selected candidate from the previously visible `day_to_day/system` chunk, with a bounded token usage and a recorded score. The live regression confirms the route-level region-filter bug is fixed.


## Additional live findings

The Health page initially reported `degraded` because the secret scan found 15 possible leaks, most of which were test fixtures, environment labels, or the local adapter sentinel; the Doctor card also warned that Go was unavailable. The Agent Flow itself reported 9/9 components ready, the core and memory were healthy, 53 tools were registered, 38 skills were loaded, and the queue had no stalled or dead-letter jobs. The scanner was therefore producing a noisy health status despite a clean runtime, which motivated the context-aware placeholder refinement.

The Models page’s persisted state contained repeated identical Gemini records. Startup deduplication was added, and the API now also prevents adding an already configured duplicate while still allowing a seeded unconfigured model to be configured through the add form. The live post-restart model page will be checked after returning to the route.


## Model catalog diagnosis and repair

The repeated Gemini cards were traced to a default-identity mismatch: stored records used the internal `google` provider while the configured default used the supported `gemini/` alias. Each `/models` request therefore thought the default was missing and prepended another record. The runtime identity logic now preserves the `gemini/` alias for stored Gemini defaults, startup normalization removes exact duplicate records, and the add endpoint allows initial configuration of an unconfigured seeded entry but rejects a truly configured duplicate. Launcher compatibility tests passed with 68 tests.


## Final live validation

After the final rebuild and restart, the Health page reported `healthy` with Doctor `pass`, zero secret findings, 9/9 Agent Flow components ready, 53 registered tools, 38 skills, zero queued or dead-letter jobs, and two healthy watchdog probes. The optional Go CLI was clearly reported as unavailable without downgrading core health. The Models page showed one Gemini Flash Lite card, one Gemini Flash card, and one Gemini 3.6 Flash card, with no repeated default cards. The final Health dashboard screenshot was copied to `final-health-dashboard.webp`.
