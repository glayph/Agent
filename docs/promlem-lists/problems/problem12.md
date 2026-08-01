
### 105. Active pursue goals are not injected into normal chat turns unless Turn Profile is enabled

- Evidence:
  - `packages/core/src/goals/pursue-goal.ts:238-268` builds the active goal system block with objective, progress, next step, plan, and pursuit policy.
  - `packages/core/src/agent.ts:307-312` defines `_isTurnProfileEnabled()` as `agents.defaults.turn_profile.enabled === true`.
  - `packages/core/src/agent.ts:1612-1616` calls `formatPursueGoalBlock(...)` only inside `if (explicitTurnProfile)`.
  - `packages/core/src/api/launcher-compat.ts:1762-1768` sets the default app config to `turn_profile.enabled: false`.
  - `packages/ui/frontend/src/components/chat/pursue-goal-panel.tsx:87-99` can create an active goal through `/api/goals`, but it does not enable Turn Profile or warn that normal chat turns will ignore the goal unless that separate config is enabled.
  - `packages/core/src/tools/registry/handlers.ts:406-459` exposes goal tools, but those are callable only if the model decides to call them; the active goal context itself is not included in the prompt under default config.
- Impact: a user can successfully create a pursue goal and see it in the dashboard, yet subsequent ordinary chat messages do not receive the active goal instructions by default. The feature looks persisted but does not guide the agent, which makes `/goal` feel non-functional unless the user has separately enabled an unrelated Request Context Policy setting.
- Recommended fix: inject the active pursue goal block independently of Turn Profile, or make goal creation explicitly enable the minimal context required for goal pursuit. Add a regression test that creates a goal under default config and verifies the next chat prompt includes `[ACTIVE PURSUE GOAL]`.

### 106. Heartbeat interval is labeled as minutes, stored as seconds, and slept as milliseconds

- Evidence:
  - `packages/ui/frontend/src/i18n/locales/en.json:1302-1303`, `pt-br.json:1302-1303`, and `zh.json:1302-1303` label the Config heartbeat interval as minutes.
  - `packages/ui/frontend/src/components/config/form-model.ts:143-146` defaults the form to `heartbeatInterval: "30"`.
  - `packages/ui/frontend/src/components/config/config-page.tsx:357-361` parses the number as-is with no minutes-to-seconds conversion.
  - `packages/ui/frontend/src/components/config/config-page.tsx:628-630` saves that value as `heartbeat.interval`.
  - `packages/core/src/api/launcher-compat.ts:1630-1639` maps `heartbeat.interval` directly into runtime `heartbeat.interval_seconds`.
  - `packages/core/src/agent.ts:709-715` passes `heartbeat.interval_seconds` directly to `new HeartbeatEngine(...)`.
  - `packages/core/src/heartbeat.ts:143` logs the value as seconds, but `packages/core/src/heartbeat.ts:167-168` passes it directly into `_sleep(...)`.
  - `packages/core/src/heartbeat.ts:452-464` returns `this.interval` unchanged and `_sleep(ms)` passes the value directly to `setTimeout(..., ms)`.
- Impact: the UI says the default `30` means 30 minutes, the config writer turns it into 30 seconds, and the heartbeat loop actually sleeps 30 milliseconds. That can create a hot background loop running system assessment, memory consolidation, stream-cache cleanup, profile cleanup, and optional auto actions far more frequently than the user configured.
- Recommended fix: pick one unit and enforce it end to end. Prefer storing milliseconds or seconds explicitly in code, convert the UI minutes field before saving, and make `_getAdaptiveInterval()` return milliseconds or multiply by `1000` before `_sleep`. Add tests that a UI value of `30` produces the expected timer delay.

### 107. Heartbeat auto-actions can advance or complete goals without reliable completion evidence

- Evidence:
  - `packages/core/src/heartbeat.ts:203-211` runs `_runAutoActions()` whenever `heartbeat.auto_actions.enabled === true`.
  - `packages/core/src/heartbeat.ts:336-365` builds an autonomous goal prompt and asks the model to take the next step.
  - `packages/core/src/heartbeat.ts:373-403` treats tool execution as successful unless a parsed `tool_result` output contains the substring `"error"` in lowercase text.
  - `packages/core/src/heartbeat.ts:402-405` calls `advanceGoal(goal.id)` after any such "successful" tool-call batch, even if the tool call only inspected state or did not complete the next plan step.
  - `packages/core/src/heartbeat.ts:413-416` marks a goal completed whenever the model response text contains `"completed"`, so text such as "not completed" or "completion is blocked" can still satisfy the substring check.
  - `packages/core/src/memory/repositories/goal.ts:293-303` increments `completed_steps` and can mark the goal `completed` based solely on that counter.
- Impact: when auto-actions are enabled, goal progress can move forward or finish based on weak string heuristics rather than verified plan-step completion. This can silently mark work as done after exploratory tool calls, non-error textual failures, or negative statements containing the word "completed."
- Recommended fix: require structured model output for auto-action status, distinguish inspected/attempted/completed/blocked states, update specific plan steps only after tool evidence is attached, and replace substring checks with explicit status fields validated by schema.

### 108. Context usage "View Details" sends a chat prompt instead of opening the context inspector

- Evidence:
  - `packages/ui/frontend/src/components/chat/context-usage-ring.tsx:184-188` renders the context usage popover action as "View Details".
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:887-891` handles that click by calling `sendMessage({ content: "/context", attachments: [] })` and clearing the composer.
  - `rg -n '/context' packages/ui/frontend/src packages/core/src --glob '!**/*.test.*'` finds only the frontend send path and no backend command handler for `/context`.
  - `packages/ui/frontend/src/components/chat/workspace/asset-panel.tsx:20-31` already has a right-panel tab state with `"assets"` and `"context"`.
  - `packages/ui/frontend/src/components/chat/workspace/asset-panel.tsx:185-196` renders the real context inspector panel at `workspace-inspector-context-panel`, but `handleContextDetail` does not open the right panel or switch that tab.
- Impact: clicking "View Details" on the context meter does not show the context details UI. It submits `/context` as an ordinary chat message to the model, which can waste a turn, pollute session history, and return arbitrary text instead of the structured active-tools/context-window panel the UI already contains.
- Recommended fix: make the context detail action open the workspace inspector and select the context tab. If `/context` is intended as a command, implement an explicit frontend command path or backend command handler and keep it out of normal model prompts.

### 109. Dashboard MCP disable does not disable the in-process MCP tool surface

- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:644-648` exposes an MCP enabled toggle in Config.
  - `packages/ui/frontend/src/components/config/config-page.tsx:621-626` saves that toggle to `tools.mcp.enabled`.
  - `packages/core/src/mcp/config.ts:90` loads `runtime.mcp.enabled` into `runtimeConfig.enabled`.
  - `packages/core/src/api/index.ts:2146-2156` mounts `/mcp` from the process environment flag `ENABLE_MCP`, not from `tools.mcp.enabled`.
  - `packages/core/src/mcp/server.ts:275-292` reloads runtime config but still lists local tools, external tools, and discovery entries without checking `runtimeConfig.enabled`.
  - `packages/core/src/mcp/server.ts:253-271` gates discovery entries only on `runtimeConfig.discovery.enabled`, not on the top-level MCP enabled flag.
- Impact: a user can turn MCP off in the dashboard and save successfully, but an already-enabled in-process `/mcp` endpoint can continue publishing and executing local tools. This is separate from the `ENABLE_MCP=false` gateway issue: the dashboard toggle itself is not a runtime kill switch for the MCP surface it appears to control.
- Recommended fix: make `tools.mcp.enabled === false` unregister all MCP tools/resources/prompts or stop serving `/mcp` sessions, close external connector clients, and send a tool-list changed event. Keep `ENABLE_MCP` as a process-level mount flag and document the distinction if both controls remain.

### 110. Model add/edit accepts invalid API base values and writes them into runtime config

- Evidence:
  - `packages/ui/frontend/src/components/models/model-provider-form-shared.ts:19-20` normalizes `apiBase` only by trimming slashes; it does not validate URL syntax, scheme, or embedded credentials.
  - `packages/ui/frontend/src/components/models/add-model-sheet.tsx:420-425` and `packages/ui/frontend/src/components/models/edit-model-sheet.tsx:371-376` submit that value directly as `api_base`.
  - `packages/core/src/api/launcher-compat.ts:2427-2440` has `validateProviderApiBase()`, but it is called only by test/fetch routes at `:4888`, `:4927`, and `:4967`.
  - The add/update routes at `packages/core/src/api/launcher-compat.ts:4734-4763` and `:4771-4809` normalize, save, sync LiteLLM, and report success without calling `validateProviderApiBase()`.
  - `packages/core/src/litellm-config.ts:211-219` can emit the saved `api_base` into LiteLLM config when it differs from the provider default.
- Impact: the dashboard can save and report success for malformed endpoints such as `not a url`, unsupported schemes, or credential-bearing URLs. The invalid value is then persisted and can break model runtime/LiteLLM after the save path has already shown success.
- Recommended fix: run the same backend `validateProviderApiBase()` on add/update before persisting or syncing runtime config, and add frontend validation only as an early UX layer. Keep the backend as the source of truth and add regression tests for invalid URL, unsupported scheme, embedded credentials, blank/default reset, and valid localhost endpoints.

### 111. Editing a model cannot clear most advanced fields

- Evidence:
  - `packages/ui/frontend/src/components/models/model-provider-form-shared.ts:19-20` returns `undefined` when API Base is cleared.
  - `packages/ui/frontend/src/components/models/edit-model-sheet.tsx:375-389` sends `undefined` for blank `api_base`, `proxy`, `auth_method`, `connect_mode`, `workspace`, `rpm`, `max_tokens_field`, `request_timeout`, `thinking_level`, and `tool_schema_transform`.
  - `packages/core/src/api/launcher-compat.ts:2545-2583` treats missing or `undefined` fields as "keep existing" for those same properties.
  - The update route at `packages/core/src/api/launcher-compat.ts:4781-4797` passes the current stored model into `normalizeIncomingModel()`, so cleared fields are restored from `existing`.
- Impact: a user can blank a saved model proxy, API base, timeout, RPM limit, workspace, auth method, or provider transform in the dashboard and see a save attempt succeed, but the old value remains in backend state and is returned again on reload.
- Recommended fix: distinguish omitted fields from explicit clears. Send `null` or empty strings intentionally from the edit form, have `normalizeIncomingModel()` clear those fields, and add tests covering clearing every optional model field.

### 112. Drive archive downloads can stream unbounded directory trees

- Evidence:
  - `packages/ui/frontend/src/components/drive/drive-page.tsx:1978-1985` sends selected folders or multiple selected entries to `downloadArchiveUrl()`.
  - `packages/ui/frontend/src/api/files.ts:167-170` appends every selected path as a query parameter with no client-side count limit.
  - `packages/core/src/api/file-manager-router.ts:262-270` accepts any non-empty path array and has no max selected-path count.
  - `packages/core/src/api/file-manager-router.ts:623-678` builds a gzip tar stream over the selected relative paths with no total byte limit, file-count limit, depth limit, timeout, or admission check for large directories.
  - The tar filter at `packages/core/src/api/file-manager-router.ts:662-668` only filters node type; it does not bound how much recursive content can be traversed or streamed.
- Impact: an authenticated dashboard request can ask the backend to tar a huge directory tree or many large folders. That can monopolize disk IO, CPU, and a Node response stream for a long time, while the UI has no preflight size, progress, cancellation, or partial failure reporting.
- Recommended fix: add archive preflight that walks selected trees with limits for total files, total bytes, max depth, and elapsed time. Return a clear 413/422 when limits are exceeded, expose estimated archive size/progress to the UI, and require explicit confirmation for large recursive downloads.

### 113. Google Antigravity credential actions overwrite and clear the shared Gemini API key

- Evidence:
  - `packages/ui/frontend/src/api/oauth.ts:3` defines `google-antigravity` as a separate credentials provider.
  - `packages/ui/frontend/src/components/credentials/credentials-page.tsx:107-109` saves and logs out that provider through the same OAuth credential actions as OpenAI/Anthropic.
  - `packages/core/src/api/launcher-compat.ts:3098-3102` reports Google Antigravity login status by reading `GEMINI_API_KEY`.
  - `packages/core/src/api/launcher-compat.ts:5030-5035` saves a Google Antigravity token into `GEMINI_API_KEY`.
  - `packages/core/src/api/launcher-compat.ts:5093-5098` logs Google Antigravity out by clearing `GEMINI_API_KEY`.
  - `packages/core/src/api/launcher-compat.ts:2284-2287` and `packages/core/src/litellm-config.ts:124-126` also use `GEMINI_API_KEY` for the normal Google/Gemini model provider.
- Impact: using the Antigravity credential card can silently replace or delete the Gemini model credential. Logging out of Antigravity can make configured Google/Gemini models unavailable, and saving an Antigravity token can change model-provider authentication even though the UI presents it as a separate credential surface.
- Recommended fix: either make Antigravity explicitly share the Google/Gemini credential in the UI copy and state model, or use a distinct secret name/env var for Antigravity. Logout should only clear the credential it owns and should warn before deleting any shared provider secret.

### 114. Save flows flatten runtime apply failures into generic success/restart messaging

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:5222-5228`, `:5255-5260`, `:5274-5279`, `:5800-5805`, and `:5834-5838` return `runtime_apply_status`, `runtime_apply_error`, and restart metadata after config/tool/web-search saves.
  - `packages/ui/frontend/src/api/channels.ts:83-86` models config save responses as only `status` and `errors`, omitting the runtime apply fields.
  - `packages/ui/frontend/src/components/config/config-page.tsx:575-636` awaits `patchAppConfig(...)` but does not inspect its response, then `:699-705` shows only success or restart-required based on refreshed gateway state.
  - `packages/ui/frontend/src/components/config/raw-config-page.tsx:74-86` discards the raw config save response entirely, then `:96-110` also shows only success or restart-required.
  - `packages/ui/frontend/src/components/channels/channel-config-page.tsx:441-453` ignores the config patch response after saving a channel and uses only `gateway?.restartRequired`.
  - `packages/ui/frontend/src/components/agent/tools/use-tools-page.ts:58-79` and `:91-112` ignore tool/web-search save response status/error details and pass only a boolean into `showSaveSuccessOrRestartToast()`.
  - `packages/ui/frontend/src/lib/restart-required.ts:10-20` can display only success or restart-required; it has no branch for `runtime_apply_status === "failed"` or `runtime_apply_error`.
  - `packages/ui/frontend/src/store/gateway.ts:118-160` does preserve `runtimeApplyStatus` and `runtimeApplyError`, proving the data exists but these save flows do not surface it.
- Impact: when runtime reload or LiteLLM/channel apply fails after a save, the dashboard can label the operation as saved/restart-required instead of showing the actual apply error. Users may believe the new config is active or only needs restart, while the backend has already recorded a concrete runtime apply failure.
- Recommended fix: extend config/tool/channel action response types with runtime apply metadata, check `runtime_apply_status` immediately after save, and show a failure toast/banner with `runtime_apply_error` when present. The restart-required helper should distinguish `applied`, `pending_restart`, and `failed` instead of accepting only a boolean.

### 115. MQTT broker save/start path accepts invalid broker URLs and can leave the adapter stuck disconnected

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/mqtt-form.tsx:55-64` accepts the broker as a plain text field.
  - `packages/ui/frontend/src/components/channels/channel-config-model.ts:180-215` validates only Feishu, DingTalk, and QQ special fields; it has no MQTT broker validation on save.
  - `packages/core/src/api/launcher-compat.ts:3391-3394` reads the saved MQTT broker and `:3413-3415` writes it to `MQTT_BROKER` when non-empty, without validating scheme, host, or port.
  - `packages/core/src/api/channel-runtime-probe.ts:457-468` validates MQTT broker shape only during runtime probe, so the validation exists but is not enforced by save/start.
  - `packages/core/src/channels/mqtt.ts:335-354` marks the bot `started = true` before `connect()`.
  - `packages/core/src/channels/mqtt.ts:380-385` and `:391-393` return on invalid URL/host/port without clearing `started`; `:336` makes later `start()` calls no-op.
- Impact: a bad broker value can be saved, the runtime logs once and never connects, and future start/reload attempts can treat MQTT as already started while no socket exists.
- Recommended fix: validate MQTT broker on save and in runtime config resolution, reject unsupported schemes before writing env/config, and reset `started` or expose failed status when connect cannot begin.

### 116. MQTT QoS setting is shown in the dashboard but outbound responses always publish as QoS 0

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/mqtt-form.tsx:155-163` exposes a `QoS` setting.
  - `packages/core/src/channels/mqtt.ts:266-278` normalizes saved `qos` into runtime config.
  - `packages/core/src/channels/mqtt.ts:501-506` uses `config.qos` only for subscriptions.
  - `packages/core/src/channels/mqtt.ts:155-156` builds outgoing PUBLISH packets with fixed header `0x30`, which is QoS 0 and carries no packet id.
  - `packages/core/src/channels/mqtt.ts:488-497` sends every agent response through that QoS-0 packet builder.
- Impact: setting QoS 1 in the dashboard does not make agent responses at-least-once. The UI implies a delivery guarantee that the backend does not apply to outbound messages.
- Recommended fix: either label the setting as subscription QoS only, or implement QoS 1 outbound PUBLISH packet ids and PUBACK tracking for responses.

### 117. MQTT QoS 2 requests are processed but never acknowledged with the QoS 2 handshake

- Evidence:
  - `packages/core/src/channels/mqtt.ts:210-228` parses incoming PUBLISH QoS as `0 | 1 | 2`.
  - `packages/core/src/channels/mqtt.ts:459-464` sends PUBACK only when `publish.qos === 1`.
  - `packages/core/src/channels/mqtt.ts:464` still passes QoS 2 publishes into `handlePublish()`.
  - `packages/core/src/channels/mqtt.ts:488-497` can send an agent response after processing that QoS 2 request.
  - `rg` finds no `PUBREC`, `PUBREL`, or `PUBCOMP` handling in `packages/core/src/channels/mqtt.ts`.
- Impact: QoS 2 clients or brokers can keep the request in-flight, redeliver it, or stall the session while the agent may already have acted on the message.
- Recommended fix: reject QoS 2 publishes before processing, document supported inbound QoS, or implement the full QoS 2 handshake with request deduplication.

### 118. MQTT keep-alive UI value is sent as seconds but pinged at half that interval

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/mqtt-form.tsx:143-151` exposes `keep_alive` as a numeric Keep Alive setting with placeholder `60`.
  - `packages/core/src/channels/mqtt.ts:266-277` stores the value as `keepAliveSeconds`.
  - `packages/core/src/channels/mqtt.ts:133-138` sends `keepAliveSeconds` directly in the MQTT CONNECT payload as seconds.
  - `packages/core/src/channels/mqtt.ts:509-514` schedules ping requests with `Math.floor(keepAliveSeconds * 500)`, so a configured 60-second keep-alive pings every 30 seconds.
- Impact: the runtime does not honor the configured keep-alive interval. It doubles expected ping traffic and makes broker/session timing behavior differ from what the dashboard and CONNECT packet advertise.
- Recommended fix: compute the ping interval explicitly from the intended policy, such as `keepAliveSeconds * 1000` for exact interval or a documented fraction like `keepAliveSeconds * 750`, and align the UI/help text with that behavior.

### 119. Channel endpoint URL checks are probe-only for WhatsApp, Matrix, and OneBot

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/whatsapp-form.tsx:44-52`, `packages/ui/frontend/src/components/channels/channel-forms/matrix-form.tsx:30-41`, and `packages/ui/frontend/src/components/channels/channel-forms/onebot-form.tsx:53-61` accept endpoint URLs as plain text.
  - `packages/ui/frontend/src/components/channels/channel-config-model.ts:180-215` validates Feishu, DingTalk, and QQ only; it has no save-time validation for WhatsApp `bridge_url`, Matrix `homeserver_url`/`user_id`, or OneBot `server_url`.
  - `packages/ui/frontend/src/components/channels/channel-config-page.tsx:420-445` applies only the required-field validation and then saves the channel with `patchAppConfig(...)`.
  - `packages/ui/frontend/src/components/channels/channel-config-page.tsx:737-745` disables probing while the form is dirty, so the shape checks cannot be run until after the invalid value has already been saved.
  - `packages/core/src/api/channel-runtime-probe.ts:407-454` does contain URL/user-id shape checks for WhatsApp, Matrix, and OneBot, proving the validation exists but lives only in the post-save probe path.
  - `packages/core/src/api/launcher-compat.ts:3288-3295`, `:3371-3381`, and `:3439-3449` sync those saved endpoint values into runtime env state without applying the probe validation.
  - Runtime code then treats the values as usable: WhatsApp marks `bridge_url_configured` from non-empty length at `packages/core/src/channels/whatsapp.ts:379-385`, OneBot normalizes unsupported/raw server URLs at `packages/core/src/channels/onebot.ts:66-80`, and Matrix only strips trailing slashes at `packages/core/src/channels/matrix.ts:69-86`.
- Impact: users can save and get normal save messaging for malformed WhatsApp, Matrix, or OneBot endpoints. The dashboard can only report the URL as bad after the save, and runtime adapters can then fail, retry, or report configured/ready based on non-empty strings.
- Recommended fix: promote the probe URL/user-id validators into the channel save path and frontend field validation. Keep probe checks as diagnostics, but block persistence of endpoint values that the runtime cannot safely use.

### 120. Weixin and WeCom QR binding polling hides provider errors and keeps the UI waiting

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:4002-4023` and `:4044-4059` throw concrete provider errors when Weixin/WeCom QR status polling returns an error code or malformed response.
  - `packages/core/src/api/launcher-compat.ts:4097-4139` catches every Weixin polling error, only updates `flow.updatedAt`, and returns the same flow without setting `status: "error"` or `flow.error`.
  - `packages/core/src/api/launcher-compat.ts:4142-4175` does the same for WeCom polling errors.
  - `packages/ui/frontend/src/components/channels/channel-forms/qr-binding-panel.tsx:84-102` displays backend polling errors only when the HTTP call rejects or when the returned flow has `status === "error"`.
  - `packages/ui/frontend/src/components/channels/channel-forms/qr-binding-panel.tsx:126-131` keeps polling every 2.5 seconds while the flow remains `wait` or `scanned`.
  - `packages/ui/frontend/src/components/channels/channel-forms/qr-binding-panel.tsx:77-81` renders a normal scan/wait message for those non-terminal statuses.
- Impact: if the provider repeatedly returns a real polling error after QR generation, the dashboard can keep showing a normal waiting/scanning state until expiry. Users do not see the actual provider error, and the bind flow looks stalled instead of failed.
- Recommended fix: distinguish transient network timeout from provider/application errors. Record provider failures as `status: "error"` with a redacted message, return that state to the UI, and optionally retry only known transient timeout cases with a visible retry count.

### 121. Credential save and logout flows drop runtime apply failures

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:5022-5048` handles token login by writing the provider env key, calling `applyRuntimeChanges(...)`, and returning `gateway_restart_required`, `runtime_apply_status`, and `runtime_apply_error`.
  - `packages/core/src/api/launcher-compat.ts:5089-5110` returns the same runtime apply metadata after credential logout.
  - `packages/ui/frontend/src/api/oauth.ts:37-47` models `OAuthLoginResponse` without any restart/apply fields, and `packages/ui/frontend/src/api/oauth.ts:93-101` models logout as only `{ status, provider }`.
  - `packages/ui/frontend/src/hooks/use-credentials-page.ts:289-307` saves a token, clears the input, and reloads provider status without checking the token-login response metadata.
  - `packages/ui/frontend/src/hooks/use-credentials-page.ts:320-329` logs out a provider and reloads status without checking the logout response metadata.
- Impact: users can save or remove OpenAI/Anthropic/Antigravity credentials and see the Credentials page refresh, while a concrete runtime reload/apply failure is silently discarded. Provider status may reflect the env/vault value, but the running model/channel runtime can still be using old or failed state.
- Recommended fix: extend OAuth response types with runtime apply metadata, inspect `runtime_apply_status` after save/logout, refresh gateway state, and show the same applied/pending/failed messaging used by config/model flows.
