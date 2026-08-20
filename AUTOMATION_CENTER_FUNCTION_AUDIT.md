# Automation Center Function Audit

Audit date: 2026-08-20.

## Live findings

1. The Overview route `/agent/automations` renders successfully with summary cards and links to Overview, Automations, Create, and Execution history.
2. The Automations route `/agent/automations/list` renders successfully with list/detail selection, Run now, Disable, schedule information, and latest execution evidence.
3. The Create route `/agent/automations/create` renders successfully, but the default recurring value is `0 9 * * 1`. Submitting a harmless sample objective without changing this value returned `Unsupported schedule expression: 0 9 * * 1` and did not create a record. The backend parser accepts only `@hourly`, `@daily`, `@weekly`, `every N minutes`, and `every N seconds`.
4. Switching Create to one-time mode with an empty `datetime-local` field and submitting returned `cronExpression or runAt is required`. This is a backend error surfaced by the UI rather than a client-side validation message.
5. The Execution history route `/agent/automations/history` renders successfully, lists executions, and shows Open Runs links with run IDs.
6. The History empty-state copy says `Run this automation from the Overview page`, but the Overview page has no Run now control; Run now is on the Automations management page.
7. History's `View automation` link always points to `/agent/automations/list` without preserving the selected automation ID, so it does not open the same automation context.

## Code findings

- `packages/ui/frontend/src/features/agent/automations/automation-create-page.tsx` defaults `cronExpression` to `0 9 * * 1`, while `packages/core/src/scheduler.ts` supports only a narrow custom schedule DSL.
- The same Create component does not validate an empty one-time `runAt` before calling the API.
- `packages/ui/frontend/src/features/agent/automations/automation-history-page.tsx` has the inaccurate empty-state text and non-contextual management link.
- `packages/core/src/automation.ts` exposes `runNow()` without checking automation status. The current UI disables Run now for paused/disabled entries, but the authenticated API can still accept a direct run-now request for a disabled automation.
- `AutomationManager.cancel()` disables the schedule but does not cancel an already-running execution; there is no execution-cancel endpoint or UI state for this distinction.
- Facebook and YouTube targets are selectable in Create but remain metadata-only; no real platform adapters or publishing receipts are implemented.

## Verified implementation status

The multi-view route layout itself is working after adding the parent Outlet and `/agent/automations/` index child route. Frontend bundle build completed successfully.

8. Live Automations management view currently shows three disabled smoke-test automations. The selected disabled automation's Run now and Disable buttons are correctly disabled in the DOM. This is UI-safe, although the backend `runNow` method still lacks a status guard for direct API callers.

9. In live History, selecting `Miki internal lifecycle smoke test` and clicking `View automation` navigated to `/agent/automations/list` without an ID/search parameter. The management view reset to `Supported schedule smoke test`, confirming the selected automation context is not preserved.
10. Live History contains older failed executions with `Cannot read properties of undefined (reading 'complexity')` and `Cannot read properties of undefined (reading 'id')`, plus pending historical executions from before the lifecycle fixes. Newer verified executions are completed.

11. A live Open Runs URL loaded the matching completed Agent Run and selected the expected run detail, task graph, and evidence. The Runs normalizer adds `step=step-1` when the History link leaves `step` empty; this is expected behavior, not a failure.
12. Automation completion currently synthesizes the same generic `Automation task completed successfully` manual evidence for every non-completed step in `onExecutionCompleted`; step-level evidence is not derived from the actual agent result, so the evidence can overstate what was independently verified.
13. The frontend has no edit/update workflow even though the backend exposes PATCH `/api/automations/:id`; after creation, users cannot change objective, steps, schedule, target, approval mode, timezone, or retry count from the UI.
14. The Create page exposes `Publish automatically`, Facebook Page, and YouTube options, but the core automation domain only stores these values and does not execute an approval gate or platform adapter.

## Prioritized remediation

| Priority | Finding | Recommended fix |
|---|---|---|
| P0 | Create defaults to unsupported standard cron syntax | Replace the default with `every 1 day` or `@daily`, rename the field from Cron expression to Schedule expression, and show accepted examples. |
| P0 | One-time empty schedule reaches the API and shows a backend error | Add client-side required validation for `runAt`; use a clear message such as `Choose a date and time for the one-time run`. |
| P1 | No edit/update workflow | Add an Edit view that calls the existing PATCH endpoint and preserves the selected automation ID in the route search state. |
| P1 | History View automation loses context | Link to `/agent/automations/list?automation=<id>` and initialize the management page from that parameter. |
| P1 | History empty-state points to the wrong action | Point users to `/agent/automations/list` or add Run now to Overview. |
| P1 | Approval and publishing choices are metadata-only | Disable publish options until adapters and approval state transitions exist, or clearly label them as planned. |
| P1 | Generic completion evidence can overstate verification | Record actual executor output and per-step evidence; do not synthesize success evidence for every step. |
| P2 | Direct API run-now can bypass disabled status | Enforce `automation.status === "active"` in `AutomationManager.runNow()`. |
| P2 | Disable does not stop an already-running execution | Add a cancellation state and cooperative cancellation signal for active Agent Runs. |
| P2 | Old failed/pending smoke-test runs clutter the production-like view | Add an explicit archive/filter mechanism; do not delete evidence automatically. |

## Overall conclusion

The multi-view frontend routing is working. The highest-impact current failure is the Create form’s unsupported default schedule, followed by missing one-time validation and missing edit/context-preserving navigation. The external publishing controls should not be presented as operational until typed adapters, approval transitions, idempotency, and platform receipts are implemented.

## Remediation completed — August 20, 2026

The main P0/P1 issues identified in the live audit were remediated. The Create/Edit workflow now defaults to the supported `@daily` schedule, validates one-time timestamps on the client, rejects past timestamps on the server, and exposes Facebook/YouTube as unavailable until real adapters are configured. Existing automations can be opened through the Edit workflow, and Overview, History, management, and edit navigation preserve `automationId` context.

Automation lifecycle handling was hardened by persisting scheduled task IDs on executions, propagating cancel into pending/running executions, and making lifecycle callbacks idempotent so a stale completion callback cannot overwrite a cancelled execution. Unsupported targets are rejected in all scheduler and manual execution paths.

Verification completed after remediation: `npm run build:all` passed, the frontend bundle build passed, `npm run dev` completed its workspace setup check, the Create view rendered the supported `@daily` default, the one-time form displayed `Choose a date and time for the one-time run.` without creating a record, and the live management view opened an existing automation in the populated Edit form. External platform adapters and real approval/publishing remain intentionally unavailable and are clearly labelled in the UI.

## Remaining intentional limitations

Facebook and YouTube publishing still require OAuth credentials, typed platform adapters, rate-limit handling, idempotency receipts, and post-publication verification. The existing Run remains the source of step-level evidence; the automation layer records lifecycle metadata and a linked run rather than claiming independent external verification.


## Browser-first platform connection verification

The browser-first provider foundation was live-tested through the authenticated Chat and Connections UI. Explicit token instructions are intercepted before ordinary agent execution; raw credentials are sent only to the authenticated vault-intake boundary and are not added to chat history or model context. A temporary Telegram credential was created for the test, displayed only in masked form, and revoked. The official browser handoff was corrected to open synchronously before asynchronous session creation so browser popup blocking does not prevent setup.

The platform connection store now receives the shared encrypted workspace vault. Revoking a connection removes the local metadata reference and deletes credentials stored under the `platform/<provider>/...` namespace. An isolated test verified that the dummy encrypted credential is absent after revoke. Provider-side access must still be revoked in the official provider console when applicable.

Facebook, YouTube, X, Telegram, WhatsApp and other provider descriptors remain connection-foundation entries. Real publishing adapters, OAuth callback validation, platform-specific permission checks, and provider-side publication receipts are intentionally not claimed until implemented per provider.
