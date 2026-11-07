# Miki Activity Page Audit

Date: 2026-11-06  
Scope: Static source audit of Activity route, React view, API client, Gateway routes, and adjacent monitor store. No live Gateway session, browser interaction, database state, or runtime logs were available. No source code was changed in this audit.

## Executive summary

The Activity page is implemented and several core controls are wired to authenticated backend endpoints. However, it is not a complete operational activity console. It combines autonomy status, recent goals, background jobs, live tool calls, desktop screenshot, cron schedules, and learned permission rules, while omitting several backend capabilities and presenting some failures as empty data.

## Findings

### P1 — Learned Rules API errors are silently presented as an empty list

File: `packages/ui/frontend/src/features/activity/activity-view.tsx` (loadRules, around lines 229-232)

`loadRules` catches every error and discards it. The UI then renders the same "No rules yet" state used for a genuine empty result. A network/auth/server failure is therefore indistinguishable from no saved rules.

The delete button also uses `forgetLearnedRule(...).then(loadRules)` without a catch or per-row busy/error state. A failed delete can become an unhandled rejected promise with no visible explanation.

### P1 — Scheduled Tasks view silently hides non-cron tasks

File: `packages/ui/frontend/src/features/activity/activity-view.tsx` (loadScheduledTasks)

The client fetches `/api/autonomy/tasks?limit=100` and then filters the response to `schedule_type === "cron"`. The backend enqueue route supports due-at/one-time and interval schedules as well as cron. Consequently, one-time and interval tasks may exist in the backend but never appear in this Activity list. The section is labelled Scheduled tasks but only renders cron tasks.

The list is capped at 100 and has no pagination or indication that more tasks exist.

### P1 — Event triggers are supported by the backend but absent from Activity UI

Backend routes exist for listing, creating, updating, and disabling `/api/autonomy/triggers`. Activity API client and view do not call these routes. Users cannot inspect or manage event-trigger automations from this page, despite the backend capability being present.

### P1 — Background Job details/reconciliation backend capabilities are not exposed

Backend exposes `GET /api/background-jobs/:id` with task tree and events, and `POST /api/background-jobs/:id/reconcile`. Activity UI only lists summary jobs and supports cancellation. It does not expose details, event history, or reconciliation flow for jobs flagged `needsReconciliation`. Such jobs show a warning but no action to resolve it in this page.

### P2 — Running goals are read-only in Activity

The page displays active goal title/progress and up to five recent runs, but provides no goal detail view, pause/cancel action, run event timeline, or retry/recovery action from this page. This is a functional scope gap, not proof that those operations are unavailable elsewhere.

### P2 — Live Tool Calls is not a durable activity history

The page derives the list from `monitorAtom.nodes`, sorts by `updatedAt`, and displays only the latest 20 nodes. It is driven by the Monitor websocket/store and the copy explicitly describes statuses as persisting in this browser. It is not a server-backed searchable run history; after a fresh browser/session or event-stream disconnect, historical tool calls may not be available here. The disconnected message correctly says new calls cannot be confirmed.

### P2 — Screenshot auto-refresh is slow under capture failures and not a true one-second cadence

The capture loop schedules the next frame only after the current request settles, then waits the configured 1 second. The Gateway screenshot route itself applies a 20-second AbortSignal timeout. Therefore a slow or failed screenshot can delay the next frame by up to roughly 20 seconds plus the interval. This is single-flight behavior (avoids overlapping captures), not an infinite hang under the current Gateway route. The UI has no explicit stale-frame age warning, and the last successful screenshot remains displayed after a later capture error.

### P2 — Status, background jobs, and scheduled tasks refresh at different intervals

Autonomy status and background jobs poll every 5 seconds; scheduled tasks poll every 30 seconds; learned rules load only once on mount and after successful deletion. There is no visible manual refresh control. A recently changed schedule or permission rule may therefore remain stale until a page reload/action, and task updates can lag by 30 seconds.

### P2 — Scheduled task edit/delete controls have limited status coverage

The UI offers pause/resume/cancel/edit only for `scheduled` and `paused` statuses. It does not provide controls or explanatory actions for failed, completed, running, or other statuses. This may be correct for immutable/running tasks, but the page does not explain why controls are absent.

### P2 — No Activity-specific integration test coverage found

The feature folder contains tests for `createLiveCaptureLoop`, but no tests were found for ActivityView API loading/error states, schedule filtering, event trigger visibility, background-job reconciliation, learned-rule deletion failure, or the UI action flows. This increases regression risk.

## What is currently wired and appears implemented in source

- Autonomy status read from `/api/autonomy/status`, refreshed every 5 seconds while page is visible.
- Background job list from `/api/background-jobs`, refreshed every 5 seconds; cancellation calls DELETE.
- Cron schedule create, update, pause, resume, and cancel endpoints are called from the UI.
- Screenshot capture calls `/api/autonomy/screenshot`; Gateway uses `computer_screenshot` and a 20-second abort timeout.
- Learned permission rules are loaded and can be deleted through `/api/permissions/rules`.
- Live tool-call list subscribes indirectly to the existing Monitor store/websocket state.

## Recommended repair order

1. Show explicit loading/error/empty states separately for learned rules; handle delete failures visibly and prevent double-submit.
2. Render all schedule types (once, interval, cron), label/filter them clearly, and add pagination or a visible truncation indicator.
3. Add Activity UI for event triggers (list/create/edit/enable/disable) using existing backend routes.
4. Add background job detail drawer/page using existing detail endpoint; provide safe reconciliation UI for `needsReconciliation` with evidence and explicit confirmation.
5. Add goal detail and supported pause/cancel/retry controls only where backend semantics permit; otherwise explain the state.
6. Add durable server-side run/activity history rather than treating Monitor browser state as the Activity history source.
7. Display screenshot age and stale status; optionally make capture interval configurable while retaining single-flight behavior and backend timeout.
8. Add manual refresh and consistent refresh/error indicators for each section.
9. Add ActivityView integration tests for API failures, empty states, filtering, and each action flow.

## Verification limits

This report is based on source inspection only. It does not establish that every endpoint succeeds in a live deployment, that the user has permissions for every action, or that a specific UI bug was reproduced. No build, browser test, or live API test was run during this audit.
