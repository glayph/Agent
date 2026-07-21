
### 37. Model Catalog add-selected can create unconfigured models

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:4952-4984` fetches upstream models and stores catalog entries with `api_key_mask`, not a secret reference or reusable API key.
  - `packages/ui/frontend/src/components/models/catalog-dialog.tsx:144-153` calls `addModel({ model_name, provider, model, api_base })` without an `api_key`.
  - `packages/core/src/api/launcher-compat.ts:4720-4768` only stores a provider key when the `POST /models` body includes a non-masked `api_key`.
  - `packages/core/src/api/launcher-compat.ts:2460-2497` marks API-key providers unavailable/unconfigured when no env or vault secret exists.
- Impact: after fetching a model catalog with a one-off key, "Add selected" can report success but create unavailable models unless the provider key already exists elsewhere.
- Recommended fix: require selecting an existing credential, persist a secret reference during catalog fetch, or block catalog add when the target provider credential is unavailable.

### 38. Web Search is configurable and listed as a tool, but has no executable handler

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:757-787` defines `WEB_SEARCH_DEFAULT`.
  - `packages/ui/frontend/src/components/agent/tools/web-search-tab.tsx:47-85` exposes a full Web Search settings page.
  - `packages/ui/frontend/src/components/agent/tools/tool-library-tab.tsx:220` special-cases a tool named `web_search`.
  - `packages/core/src/api/launcher-compat.ts:5706-5748` fabricates a `web_search` tool row if the orchestrator tool registry does not provide one.
  - `packages/core/src/tools/registry/executor.ts:283-338` registers builtin handlers such as `direct_download_search`, but not `web_search`.
  - `packages/core/src/tools/registry/handlers.ts:297-355` has direct download and system index handlers, but no Tavily, SerpAPI, native search, or `web_search` handler.
- Impact: the Tools page can show and configure Web Search, but agent tool execution cannot call it. Direct execution would fail with a missing registry handler.
- Recommended fix: implement and register `web_search` against the configured native/Tavily/SerpAPI provider, or hide the Web Search tool/configuration until it is wired.

### 39. Skill import UI accepts ZIP files that the backend always rejects

- Evidence:
  - `packages/ui/frontend/src/components/agent/skills/skills-page.tsx:75` advertises `.md,.zip,text/markdown,text/plain,application/zip,application/x-zip-compressed`.
  - `packages/ui/frontend/src/components/agent/skills/use-skills-page.ts:249-269` treats `.zip` and zip MIME types as valid imports.
  - `packages/ui/frontend/src/components/agent/skills/use-skills-page.ts:279` proceeds to `importMutation.mutate(file)` for those files.
  - `packages/core/src/api/launcher-compat.ts:5567-5578` rejects every import whose filename does not end in `.md` with "Only Markdown skill imports are supported in this build."
- Impact: users can select or drop a ZIP file as if it is supported, then the backend always fails the import.
- Recommended fix: implement ZIP extraction and validation in `/api/skills/import`, or remove ZIP acceptance from the UI and validation copy.

### 40. Skill marketplace availability is gated by fake tool rows

- Evidence:
  - `packages/ui/frontend/src/components/agent/hub/use-hub-marketplace.ts:44-53` derives marketplace search/install availability from `/api/tools` rows named `find_skills` and `install_skill`.
  - `packages/ui/frontend/src/components/agent/hub/use-hub-marketplace.ts:68-82` actually calls skill API endpoints through `searchSkills` and `installSkill`, not tool execution.
  - `packages/core/src/api/launcher-compat.ts:5706-5745` fabricates `find_skills` and `install_skill` tool rows when they are missing from `orchestrator.tools.getToolDefinitions()`.
  - `packages/core/src/api/launcher-compat.ts:5760-5808` toggles those names by writing `state.tool_state`, without registering or unregistering executable handlers.
  - `rg` finds no `registerHandler("find_skills")`, `registerHandler("install_skill")`, or MCP tool contract named `find_skills` or `install_skill`.
- Impact: disabling these fake tool rows blocks marketplace UI even though the backend API can still search/install. Enabling them suggests agents can call tools that do not exist.
- Recommended fix: gate the marketplace on API route health and permissions, and only show tool rows for real executable tool definitions.

### 41. WeChat and WeCom channels can probe ready without a mounted runtime adapter

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:479-492` marks `weixin` and `wecom` as `runtime_status: "functional"`.
  - `packages/core/src/api/launcher-compat.ts:5376-5414` only exposes QR binding routes for `/weixin/flows` and `/wecom/flows`.
  - `packages/core/src/channels` contains adapters for WhatsApp, Telegram, Slack, QQ, OneBot, MQTT, Matrix, LINE, IRC, Feishu, Discord, and DingTalk, but no `weixin.ts` or `wecom.ts`.
  - `packages/core/src/api/index.ts:491-495` mounts webhook routers for LINE, WhatsApp, Feishu, DingTalk, and QQ, but no `/webhooks/weixin` or `/webhooks/wecom`.
  - `packages/core/src/api/index.ts:311-319` starts managed runtimes for Telegram, Discord, Slack, Matrix, IRC, OneBot, and MQTT only.
  - `packages/core/src/api/channel-runtime-probe.ts:292-319` trusts catalog runtime status, and `packages/core/src/api/channel-runtime-probe.ts:560-610` can pass mock send without real provider traffic.
- Impact: WeChat/WeCom can appear runtime-ready after config/QR flow checks, but the app has no mounted message adapter or webhook runtime to receive and handle messages.
- Recommended fix: mark these channels `config_only` or `partial` until real adapters/webhooks are mounted, or implement the missing runtime handlers.

### 42. Config reset and save do not clear removed runtime secrets

- Evidence:
  - `packages/core/src/api/launcher-compat.ts:5267-5273` resets config by committing `defaultAppConfig(workspaceDir)`.
  - `packages/core/src/api/launcher-compat.ts:3888-3905` `commitConfig()` sanitizes/saves config and calls `syncConfigToRuntimeFiles()`.
  - `packages/core/src/api/launcher-compat.ts:3219-3496` writes env/vault-backed runtime values only inside truthy `if (value)` blocks for channel tokens, webhooks, and provider settings.
  - `packages/core/src/api/launcher-compat.ts:1190-1338` `extractRuntimeSecretsToVault()` writes incoming secrets to vault and strips them from config, but does not delete prior vault secrets when a config omits or clears them.
  - `packages/config/src/secret-vault.ts:339-351` supports deleting env-backed secrets by setting an empty value, but reset/save paths do not call it for removed runtime secrets.
- Impact: Reset or clearing fields in the UI can remove visible config while old credentials remain in the vault/process env and continue to affect probes or runtime behavior after reload.
- Recommended fix: diff old and new secret fields during config commit, delete removed vault/env keys explicitly, and expose clear-secret semantics in the UI.

### 43. Dashboard chat reconnect never uses the backend resume protocol

- Evidence:
  - `packages/core/src/api/index.ts:969-1017` supports a legacy websocket message of `type: "resume"` with `checkpoint_id` and `last_sequence`.
  - `packages/core/src/api/index.ts:1090-1128` saves stream chunks under generated checkpoint IDs.
  - `packages/ui/frontend/src/features/chat/controller.ts:144-145` opens only `/pico/ws?session_id=...`.
  - `packages/ui/frontend/src/features/chat/controller.ts:153-169` handles `onopen` by marking the socket connected; it never sends `resume` and does not track checkpoint/sequence.
  - `rg -n "checkpoint|last_sequence|resume" packages/ui/frontend/src` finds no dashboard chat resume usage.
  - `packages/core/src/api/index.ts:781-944` implements the Pico websocket path without checkpoint storage or resume handling.
- Impact: if the dashboard socket drops during a response, reconnect opens a fresh Pico socket and the in-flight assistant response cannot replay or resume, even though resume code exists elsewhere.
- Recommended fix: implement checkpoint IDs and resume handling on the Pico/dashboard path, or remove the unused resume path and provide explicit retry/recover UX.

### 44. Session delete failure is hidden and local history metadata is removed early

- Evidence:
  - `packages/ui/frontend/src/components/chat/session-history-menu.tsx:399-411` removes the session from local pinned and renamed storage before calling `onDeleteSession(sessionId)`.
  - `packages/ui/frontend/src/components/chat/session-history-menu.tsx:414-420` closes the delete dialog immediately and does not await deletion.
  - `packages/ui/frontend/src/hooks/use-session-history.ts:88-104` catches `deleteSession(id)` errors and only logs to `console.error`.
  - `packages/ui/frontend/src/api/sessions.ts:88-98` correctly throws `SessionApiError` when the backend delete request fails.
- Impact: if backend deletion fails, the user sees no error, the dialog closes, and any local pin/rename metadata for that session is already lost. The session can reappear on reload with local display state silently reset.
- Recommended fix: make session deletion awaitable, show a toast/error state on failure, and only remove local pinned/renamed metadata after the backend confirms deletion.

### 45. Turn Profile modes and allow lists are saved but not enforced

- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:302-317` exposes the Request Context Policy enable toggle.
  - `packages/ui/frontend/src/components/config/config-sections.tsx:359-393` exposes History Context and System Context mode selectors.
  - `packages/ui/frontend/src/components/config/config-sections.tsx:398-456` exposes Skills and Tools modes plus custom allow-list textareas.
  - `packages/ui/frontend/src/components/config/config-page.tsx:77-101` builds a `turn_profile` patch including `skills.allow` and `tools.allow`.
  - `packages/ui/frontend/src/components/config/config-page.tsx:586-596` saves the patch under `agents.defaults.turn_profile`.
  - `packages/core/src/agent.ts:187-192` only types the runtime turn profile sections as `{ mode?: string }` and drops allow-list fields.
  - `packages/core/src/agent.ts:926-929` always loads previous messages with `this.memory.getMessages(...)` regardless of `history.mode`.
  - `packages/core/src/agent.ts:931-935` always builds the full system content regardless of `system_prompt.mode`.
  - `packages/core/src/agent.ts:938-947` always exposes the pruned/all tool schema regardless of `tools.mode` or `tools.allow`.
  - `packages/core/src/agent.ts:1612-1656` only uses `turn_profile.enabled` to include dynamic state blocks; it does not apply the saved mode or allow-list policy.
- Impact: users can configure turn-level history, system, skill, and tool policy in the dashboard, but the agent still receives history/system context and all selected tools as before. Custom tool/skill allow lists are especially misleading because they are saved and reloaded by the UI but never enforced by execution.
- Recommended fix: add a turn-profile resolver in `runAgentLoop` that conditionally omits history/system content, filters skills/tools by mode and allow list, and prevents execution for filtered tools. If this policy is not intended, remove the controls and stored fields.
