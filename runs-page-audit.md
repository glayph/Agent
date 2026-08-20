# Runs Page Audit

## Live findings

- The initial list endpoint returned no runs, and the empty state exposed a working Create Manual Run flow.
- A manual run titled `Runs page integration smoke test` with three ordered steps was created successfully. The URL selected the new run and first step; the UI showed `pending`, `0/3 steps`, dependency edges, and one timeline event.
- Export was triggered successfully for the selected run. The UI displayed `Agent run exported.` and the browser initiated a JSON download.
- The created run remained pending with no evidence because the Runs page creates/records the run graph but does not execute the steps itself.

## Code references

- Frontend fetches list, detail, create, and export through `packages/ui/frontend/src/api/agent-runs.ts`.
- Core routes are implemented in `packages/core/src/api/enhancement-router.ts` at GET/POST `/agent/runs`, GET `/agent/runs/:runId`, POST `/agent/runs/:runId/evidence`, and GET `/agent/runs/:runId/export`.
- SQLite persistence uses `agent_runs` with JSON step/timeline/context columns and updates by run ID in `packages/core/src/agent-run.ts`.

Next: verify replay, search/status filtering, refresh, manual validation, and whether Chat-created runs are persisted in this registry.

## Additional live findings

Replay created a second run named `Replay: Runs page integration smoke test` with the same three steps and pending status. Search for `Replay` kept both runs because the original run contains a matching step title; this confirms filtering searches run content, not only the objective. The status menu exposes All, Pending, Running, Completed, Failed, and Skipped. Selecting Pending retained the two pending runs and updated the URL query state to `status=pending`.
Refresh was tested with `q=Replay` and `status=pending`. The page reloaded successfully and preserved both query parameters, the selected replay run, its three-step graph, and its timeline event.

## Additional validation and API findings

- Manual-run form validation was tested with an explicitly empty objective and empty steps; the UI displayed `Objective is required` and `At least one step is required` and did not create a new run.
- A first blank-field attempt through automated form filling did not change the controlled default steps; this was a test-input limitation, not a product defect. An explicit input-event sequence confirmed the real validation path.
- Direct unauthenticated curl requests to the list, detail, and export endpoints returned HTTP 401, which is expected because the dashboard API is authenticated. Authenticated browser-side tests remain the source of truth for those functions.

Timestamp: 2026-08-19.

## Authenticated API and detail findings

- Authenticated browser-side requests returned HTTP 200 for list and export. The list returned three persisted pending runs with three steps each; export returned schema version 2.
- The frontend detail client was incorrect: `getAgentRun()` requested `/api/agent/runs/:id`, which returned HTTP 404/HTML (`Cannot GET`). The backend-served route is `/api/enhancements/agent/runs/:id`, which returned HTTP 200 JSON. The client was corrected to use the enhancement-prefixed route.
- Selecting task-graph step 2 updated the URL to `step=step-2` and changed the evidence panel title to `Run implementation or analysis`, confirming step selection and URL state work.

## Post-fix live verification

- The corrected frontend and gateway-served backend bundle both compiled successfully with Vite and TypeScript.
- After reload, a selected run loaded its detail and selected step correctly through the corrected enhancement-prefixed endpoint; the step-2 evidence panel showed `Inspect the task graph` and the URL preserved `step=step-2`.
- Authenticated evidence recording returned HTTP 201, and step patching returned HTTP 200. The UI then displayed `1/3` completed, `1` evidence, a completed step, a three-event timeline, and the evidence card with passed state.
- Export with populated evidence displayed `Agent run exported.` and browser download history confirmed JSON files for both the original and validation runs.
