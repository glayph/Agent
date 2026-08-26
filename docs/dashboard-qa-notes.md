# Dashboard QA Notes

## Browser chat regression

The rebuilt dashboard was exercised at `http://127.0.0.1:18800/` after a clean canonical-root 24/7 runtime restart. The selected dashboard model was `openai/gpt-4o`.

The original browser reproduction produced `Running -> Ready` with no assistant message and no assistant row in `data/session-history.db`, even though the provider completion event was logged. Source tracing showed that `AgentOrchestrator.runAgentLoop()` returned early when the provider response had no `choices[0]`, bypassing assistant history persistence and emitting no visible `stream_chunk`.

The fix adds `buildEmptyModelResponse()` and persists/emits an actionable assistant fallback whenever the provider returns an empty choice or an otherwise empty final response. A focused regression test covers the helper. A browser recheck using `Reply with exactly: browser-chat-patched-ok` showed the visible assistant message: `The openai/gpt-4o model returned an empty response. No assistant answer was produced; please retry or choose a different configured model.` The UI reached `Ready`, displayed `Inspector`, showed four messages, and `data/session-history.db` contained the assistant row with the same content.

## Dashboard static serving regression

After rebuilding, a runtime launched with `MIKI_RUNTIME_ROOT` pointing to the data directory returned `Dashboard not found` even though the source checkout contained `packages/ui/frontend/dist/index.html`. The gateway previously used only the runtime static path. The fix serves the packaged runtime dashboard first and falls back to the source checkout path. A clean runtime restart with canonical source/runtime/workspace roots returned HTTP 200 for `/launcher-login` and loaded the dashboard successfully.

## Model default synchronization

The `/api/models` route now materializes a runtime default model missing from the saved model catalog, preserving canonical provider routing and making the selected model visible to the dashboard. A focused launcher regression test confirms that an absent `openai/gpt-5-nano` runtime default is returned as a default model row.

## Current limitation

The configured `openai/gpt-4o` test endpoint returned an empty completion in this sandbox. The dashboard now reports that condition visibly and persists it, but this does not certify model quality or direct Gemini/local LFM behavior.

## Health and Models pages

The Health page rendered successfully. Agent Flow reported 9/9 ready, gateway ports matched with zero pending restart fields, core/memory/model/tools were ready, and the runtime queue was empty. The page truthfully reported degraded status because the repository secret scan found 15 possible test/example secret patterns and the doctor reported that Go is unavailable; these are evidence/fixture findings rather than a runtime crash. The page exposed usable actions for doctor, backup, secret scan, watchdog reset, and rollback.

The Models page rendered successfully. OpenAI had two ready models with a masked configured credential and `openai/gpt-4o` marked Default; Gemini and OpenRouter catalog rows were visible but not configured. The local voice section clearly reported that no speech model was installed and exposed non-automatic install actions. No credential was shown in clear text.

## Credentials and Config pages

Credentials rendered successfully. The OpenAI entry was shown as connected with a masked token, while Google Antigravity/Gemini was explicitly not logged in. Reveal, save, and logout controls were present; no clear secret was exposed in the page text.

Config rendered successfully with the expected launcher, agent, runtime, MCP, command-safety, scheduled-command, and device sections. The workspace directory matched the canonical root, the service port was 18800, and safety toggles were visible. The page described restart semantics for launcher-level changes and exposed Raw Config and Save controls. No accidental submission or external side effect was performed.

## Channels and Tools pages

The Channels route opened the Miki/Web channel configuration page and correctly marked it Functional. It exposed disabled-by-default enablement, masked token input, type, streaming output, save/reset, and a local runtime probe. No channel was enabled and no outbound probe was run.

The Tools page rendered a large registered-tool library with status filtering and per-tool enable/disable switches. Shell and filesystem tools were explicitly labeled high risk, while web search and browser tools had their expected lower/medium risk labels. The page exposed tool settings without executing a side effect.

## Runs and Automations pages

Runs loaded successfully and truthfully showed that no persisted agent runs were recorded in the canonical-root runtime. Refresh, export, replay, and New Run controls were present; no manual run was created because that would add an unnecessary side effect to the QA dataset.

Automations loaded successfully and showed zero configured workflows, zero active schedules, and clear links for creation, management, history, and connections. The empty state was coherent and did not imply that scheduling had been validated on a target host.

## Memory and Agent Control pages

Memory rendered successfully with selective retrieval statistics, search, filters, reindex, and chunk inspection. The inspector explicitly stated that secrets and credential values are not shown. Existing historical test records were visible, including prior failed/fixture interactions, which is useful evidence rather than an unreported clean production dataset.

Agent Control rendered successfully. The active model selector showed the configured `openai/gpt-4o`, resource profile was Balanced, and the typed capability inventory described read-only inspection, model activation/health, narrow schema-validated configuration patches, tool enablement, and runtime reload. It explicitly excluded raw credentials, arbitrary destructive controls, and generic process control. The page did show “No dashboard-registered tools are currently exposed” in the control summary even though the Tools page reported registered tools; this appears to be a capability-scope display distinction and was not acted upon without a reproducible control failure.

## Logs and Skills pages

Logs rendered with 79 lines and exposed auto-scroll, copy, clear, and gateway log stream controls. The visible log entries showed provider completion and channel-disabled diagnostics without clear API-key disclosure. No clear operation was used.

Skills rendered successfully but reported zero available skills and zero installed plugin contracts in the canonical-root launcher state, while Health’s flow summary had previously reported the built-in skill loader as ready. The page’s empty state was explicit and its marketplace readiness section correctly showed zero candidates/ready/publishable entries. This is a state/catalog distinction, not a crash, and no import/install was performed.

## Hub and Drive pages

The Hub page rendered a clear skill-discovery empty state with a search box and no configured registry results. The Drive page rendered the System drive summary, free-space metric, Workspace and Home locations, and a refresh/actions surface. The workspace path matched `/home/ubuntu/agent-miki-work/Agent-main`; no file mutation was performed.

## Validation commands

`npm run verify` passed all five verification steps, including backend and frontend tests and the doctor checks. The doctor remained WARN because Go is unavailable; the checks otherwise passed, including runtime artifacts, config/data writability, SQLite, secret vault, provider key detection, dependency audit, and migration dry-run.

`npm run acceptance -- --live` passed the runtime-file and live gateway-health checks and reported Linux/Windows deployment assets, health watcher, and network safety as ready. It intentionally left target-host STT, credentialed channels, external MCP, reboot recovery, and soak checks as not_run.

`npm run health:watch -- --once` exited successfully.

The OpenAI-compatible model smoke passed with the sandbox-approved bare model id `gpt-5-mini` and returned `miki model smoke test`. An initial prefixed `openai/gpt-5-mini` invocation was rejected by the proxy as an unsupported model; this is an invocation convention, not a runtime claim about gpt-4o. The dashboard-selected gpt-4o returned an empty completion, which is now surfaced honestly by the UI.

`npm run task:quality` could not run because the expected `test-results` input directory was absent. This means the four-task quality gate is not certified by this pass and remains a release blocker until task result artifacts are generated and evaluated.

## Control model selection recheck

The Agent Control page was revisited and `openai/gpt-4o-mini` was selected from the configured-model dropdown. The page showed the active model changed to `openai/gpt-4o-mini` and displayed an “Agent control change applied and verified” confirmation. This was a local configuration change made for QA; no external delivery or destructive operation was performed.

## Alternate configured model chat

Using Agent Control, `openai/gpt-4o-mini` was selected and hot-applied. A live dashboard prompt then produced a visible and persisted empty-response diagnostic naming `openai/gpt-4o-mini`; the UI displayed the assistant message instead of silently dropping the turn. This confirms the new guard works across both configured OpenAI dashboard models, while also confirming that this sandbox endpoint did not produce substantive chat content for either model.
