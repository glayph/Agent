# Miki Activity Page Functional Repair

Date: 2026-11-06

## Scope

This repair addresses the Activity Page findings documented in `ACTIVITY_PAGE_AUDIT_2026-11-06.md`. Existing features and backend capabilities were retained. This is a source-level repair; no live Gateway session or browser was available for end-to-end verification.

## Changes made

### 1. Learned Rules error handling
- The page now distinguishes loading, empty, and failed API states.
- Rule deletion has a per-row busy state and displays failures instead of leaving an unhandled rejection.
- Manual Activity refresh reloads the rules list.

### 2. Schedules: all types, pagination, and editing
- One-time, interval, and cron schedules are displayed; the previous cron-only filter is removed.
- Creation supports all three types.
- Editing supports title/description on all schedule types, cron expression/timezone/misfire policy for cron, next run/due time for one-time schedules, and next run/interval seconds for interval schedules.
- Pause/resume/cancel controls are shown only for backend-supported task states.
- Added `offset` pagination to the Gateway/core list API; the Activity view can load older pages beyond the first 100 rows.
- Core validates interval bounds (60–31,536,000 seconds) and date-time values before updating.

### 3. Event Triggers
- Added list, create, edit (title/description/filter), enable, and disable controls using existing authenticated Gateway endpoints.
- JSON filter and optional acceptance contract input are validated as objects.
- API and validation failures are displayed in the Activity page.
- A delete action was not added because the available backend contract exposes disable/update, not delete.

### 4. Background Jobs
- Added a details view for the task tree and persisted execution events.
- Kept the existing cancel action.
- Added a manual reconciliation flow for jobs that explicitly need reconciliation. It requires a non-empty evidence object and a structured action-outcome array; the UI warns that external state must be checked independently before submitting.

### 5. Running Goals
- The page now exposes Stop run for goals that have a run ID, using the existing authenticated run-cancellation endpoint.
- Added a direct link to the Monitor execution graph.
- A per-goal pause control was not added because the current backend has no per-goal pause endpoint/semantics.

### 6. Live Tool Call History
- Activity now requests all persisted Monitor runs (not `active_only=1`) and uses the server's compound cursor to page older history.
- Completed/failed historical nodes are shown in Activity's history list.
- Current WebSocket/store state takes precedence when it contains a newer version of a node.
- The Monitor page's existing active-only behavior remains the default for other callers.

### 7. Screen Share: browser-native live MediaStream
- Removed Activity page's periodic PNG/JPEG screenshot polling and image preview.
- Added `navigator.mediaDevices.getDisplayMedia()` with a live `<video>` preview backed directly by the browser `MediaStream`.
- Added explicit start/stop controls, permission/error feedback, duplicate-start protection, and track cleanup when sharing ends or the page unmounts.
- Browser/system permission is required and browser capture generally requires a secure context (HTTPS or localhost).
- **Important limitation:** this implements live screen sharing into the Activity page only. The stream is not forwarded to Miki's model/runtime. The existing computer-control observation path still uses its current screenshot/tool protocol. Forwarding a continuous media stream to the agent requires a supported transport/receiver and model/runtime video-input integration; those components are not present in this source and were not fabricated.

### 8. Refresh and status
- Added a manual refresh control for autonomy status, background jobs, schedules, rules, triggers, and persisted monitor history.
- Existing polling intervals remain, and task-list errors remain visible.

### 9. Tests added/updated
- Monitor history API test verifies Activity can request the full persisted run history while the default remains active-only.
- Activity API tests cover schedule pagination, event-trigger creation, background-job detail/reconciliation, schedule editing, and active-run cancellation.
- Autonomous supervisor tests cover schedule pagination and safe edits for one-time/interval schedules.

## Remaining limitations

- No per-goal pause endpoint exists; Activity exposes stop/cancel only.
- Event triggers can be edited and enabled/disabled, but not deleted with the current backend API.
- The background-job summary list requests up to 50 jobs; it does not yet page every historical job.
- Monitor history pagination lists persisted node metadata, not sensitive tool input/output, which the backend intentionally does not retain.
- The screen stream is local to the Activity page and is not yet delivered to the agent/model.
- Activity-specific component-level browser tests have not been added; the new tests cover API contracts and core schedule behavior.

## Verification

- TypeScript `transpileModule` syntax parsing passed for all changed TypeScript/TSX files.
- Full frontend typecheck/build and automated tests could not be run because dependencies are not installed in the provided runtime. The runtime has Node.js `v22.16.0`; the repository root declares `>=22.19.0`.
- No live Gateway/browser test was performed. Endpoint behavior and screen permission UX still require validation in a running deployment.

## Suggested local verification

Use Node.js `22.19.0` or later, install dependencies, then run:

```bash
npm install
npm run build:all
npm run dev
```

Then check Activity: schedule pagination and editing, trigger create/edit/toggle, background-job details/cancel/reconciliation, learned-rule error handling, Stop run, persisted Monitor history, and screen-share start/stop in a supported secure browser context.
