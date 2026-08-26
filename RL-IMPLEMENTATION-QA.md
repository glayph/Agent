## Runtime UI verification

After rebuilding and restarting the runtime, gateway/core/memory processes started successfully on ports 18800/8000/18700. The dashboard required the existing launcher login, and the configured password authenticated successfully. The chat page loaded with prior smoke history; the earlier exact-string failure and arithmetic success remained visible. The new Agent Control RL status card still requires direct navigation and will be checked in the next browser operation.

The updated Agent Control UI rendered the new Self-improvement learning section successfully. However, its status request returned HTTP 404 for `/api/improvement/status`; the card therefore showed fallback `observe`, policy v1, zero decisions, and no cycles. Browser console confirmed the gateway response was `Cannot GET /api/improvement/status`. This is a route exposure/registration issue, not a UI rendering issue, and must be fixed before final verification.

After the second restart, dashboard authentication passed and the updated chat page loaded. The latest build served the bundled UI successfully. The next visual step is to open Agent Control again and confirm `/api/improvement/status` now returns the durable engine state instead of 404.

The final visual check rendered the new RL status card correctly. It showed `draft`, policy v1, 0 decisions, average reward 0.000, 0 pending drafts, and no cycles yet. Configured Gemini and local LFM model options were visible. A browser console request confirmed HTTP 200 from `/api/improvement/status` with `enabled: true`, `degraded: false`, `behaviorLearning.mode: draft`, `policyVersion: 1`, `explorationRate: 0.1`, `minSamples: 3`, and all due flags true because no cycle has run yet.

A real authenticated `POST /api/improvement/force-reflection` was executed against the restarted runtime. The endpoint returned HTTP 200 with `success: false`, `status: skipped`, a persisted cycle ID, `updated: true`, and reason `no_experiences`. This confirms the API no longer reports a no-op as success and the cycle journal is durable; the empty result is expected because no post-implementation agent turn had yet produced a learning experience.

A live Gemini chat test was sent through the dashboard: `What is 3+3? Answer with exactly 6.` The agent returned `6`, and the UI showed the run as Gemini/gemini-3.5-flash-lite. This produced the first post-implementation agent turn for validating durable experience capture; the memory database will be inspected next.

The first live experience audit exposed two implementation issues: persisted policy mode defaulted to `observe` instead of matching configured `draft`, and a valid one-character answer (`6`) was classified as `unknown`, producing a neutral reward. Both were corrected. The engine now synchronizes persisted mode from runtime config at initialization, and any non-empty response that is not a known failure is classified as success. Unit tests, core typecheck, and core lint pass after the fix.

The final runtime restart required re-authentication and the login passed. The updated chat UI loaded with the prior verified messages, confirming the rebuilt gateway/frontend remained healthy after the corrective changes. Agent Control visual re-check will follow once the route is opened.

Final Agent Control visual verification showed the actual persisted state: `draft` mode, policy v1, 1 decision, average reward 0.050, 0 pending drafts, and reflection `skipped` because the earlier cycle ran before the first experience existed. The UI rendered the new RL section and configured Gemini/LFM model choices correctly. The browser clean screenshot is available at `/home/ubuntu/screenshots/127_0_0_1_2026-08-26_21-21-47_5727.webp`.

Post-fix live Gemini test succeeded: `What is 5+5? Answer with exactly 10.` produced the exact answer `10` in the dashboard. This confirms short valid responses now complete normally; durable experience/policy statistics will be re-read to verify the reward is positive and mode remains `draft`.

Read-only SQLite inspection after the second live turn found 2 durable experiences. The newest model action `model:gemini/gemini-3.5-flash-lite` has outcome `success` and reward `0.75`; policy state is `draft`, policy v1, total decisions 2, and average reward `0.4`. The previous pre-fix short-answer record remains `unknown` with reward `0.05`; it was not rewritten, preserving audit history. The reflection cycle remains correctly journaled as `skipped` with zero inputs because it ran before the first experience.
