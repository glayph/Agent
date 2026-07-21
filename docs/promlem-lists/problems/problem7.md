
### 54. Devices and USB monitoring settings do not start any runtime integration

- Evidence:
  - `packages/ui/frontend/src/i18n/locales/en.json:1304-1307` exposes Enable Devices and Monitor USB copy.
  - `packages/ui/frontend/src/components/config/config-sections.tsx:1367-1382` renders Devices enabled and Monitor USB switches.
  - `packages/ui/frontend/src/components/config/config-page.tsx:632-634` saves `devices.enabled` and `devices.monitor_usb`.
  - `packages/ui/frontend/src/components/config/form-model.ts:408-415` loads the devices config.
  - `packages/core/src/api/launcher-compat.ts:1588` reads `agentYaml.devices`, `packages/core/src/api/launcher-compat.ts:1623` writes it back, and `packages/core/src/api/launcher-compat.ts:1778-1780` defines defaults.
  - `packages/config/src/schema.ts:312` accepts `devices` as a generic JSON record.
  - `rg -n "\\bdevices\\b|monitor_usb|usb|hardware|device" packages/core/src packages/config/src` finds no core USB watcher or device integration runtime beyond config compatibility and unrelated examples/tests.
- Impact: enabling device integrations or USB monitoring in the dashboard does not watch plug/unplug events, mount hardware tools, or alter runtime behavior.
- Recommended fix: add a devices manager with explicit platform support and OS-specific USB event watchers, or hide the settings until that runtime exists.

### 55. Edited external MCP server settings do not reconnect existing clients

- Evidence:
  - `packages/ui/frontend/src/components/config/config-sections.tsx:728-944` lets users edit MCP server enabled state, transport type, URL, headers, command, args, and env.
  - `packages/ui/frontend/src/components/config/config-page.tsx:625` saves the server list as `tools.mcp.servers`.
  - `packages/core/src/mcp/config.ts:85-103` loads `runtime.mcp.discovery` and `runtime.mcp.servers`.
  - `packages/core/src/mcp/server.ts:275-284` periodically reloads runtime config, calls `connectorManager.updateConfig(runtimeConfig)`, and lists external tools.
  - `packages/core/src/mcp/connectors.ts:94-100` only replaces the in-memory config reference.
  - `packages/core/src/mcp/connectors.ts:133-136` reuses an existing client by `config.name` without comparing URL, headers, command, args, or env.
  - `packages/core/src/mcp/connectors.ts:108-131` creates the transport only when no client with that name exists.
- Impact: after changing an MCP server URL, command, header, env, or args while keeping the same name, the runtime can keep using the old transport until process restart. The dashboard can show updated settings while tools still call the previous server.
- Recommended fix: hash normalized server connection config, close and recreate changed clients on update, remove clients for disabled/deleted servers, and emit a tool-list change when external tools are refreshed.

### 56. Telegram Base URL and Proxy settings do not affect the running bot

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/telegram-form.tsx:86-87` saves the Telegram API base as `base_url`.
  - `packages/ui/frontend/src/components/channels/channel-forms/telegram-form.tsx:97-102` exposes and saves a Telegram `proxy` value.
  - `packages/ui/frontend/src/components/channels/channel-config-model.ts:80` stores non-common channel fields such as `base_url` and `proxy` under `settings`.
  - `packages/core/src/api/launcher-compat.ts:1100-1101` uses flattened `base_url` for the Telegram live probe.
  - `packages/core/src/channels/telegram.ts:87-88` reads `settings.api_root` or `raw.api_root`, not `settings.base_url` or `raw.base_url`.
  - `packages/core/src/channels/telegram.ts:158-159` constructs `Telegraf` with only `telegram: { apiRoot: config.apiRoot }`; no proxy agent/config is passed.
  - `rg -n "base_url|proxy" packages/core/src/channels/telegram.ts` finds no Telegram runtime use of either saved field.
- Impact: a custom Telegram API endpoint can pass the dashboard live probe but the actual bot still uses the default API root unless `api_root` is set by some other path. The proxy field is purely cosmetic, so users behind a proxy cannot make the bot use it from the channel form.
- Recommended fix: normalize the UI field to `api_root` or make the runtime accept `base_url`, and wire `proxy` into Telegraf/HTTP transport with validation and tests.

### 57. Telegram Typing, Streaming, and Placeholder controls are inert or mismatched

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/telegram-form.tsx:120-124` saves Typing as an object `{ enabled: checked }`.
  - `packages/core/src/channels/telegram.ts:91` reads `settings.typing ?? raw.typing` as a boolean; an object falls back to `true` in `booleanOrDefault`.
  - `packages/ui/frontend/src/components/channels/channel-forms/telegram-form.tsx:131-133` exposes a Telegram Streaming config.
  - `packages/ui/frontend/src/components/channels/channel-forms/streaming-config-field.tsx:52-91` lets users set `enabled`, `throttle_seconds`, and `min_growth_chars`.
  - `packages/core/src/channels/agent-response.ts:19-30` collects the full agent response before the channel replies.
  - `packages/core/src/channels/telegram.ts:212-219` calls `collectAgentResponse(...)` and then replies with final split messages, not incremental streaming.
  - `packages/ui/frontend/src/components/channels/channel-forms/telegram-form.tsx:139-160` exposes Placeholder enable/text controls.
  - `rg -n "streaming|placeholder" packages/core/src/channels/telegram.ts packages/core/src/channels/agent-response.ts` finds no runtime handling for these Telegram settings.
- Impact: turning Telegram Typing off still sends typing actions, and enabling streaming or placeholder text does not change outbound Telegram behavior. The channel form suggests richer chat behavior than the adapter implements.
- Recommended fix: store `typing.enabled` in the shape the runtime expects or update the runtime to read the nested object, and either implement incremental channel streaming/placeholder messages or hide those controls for Telegram.

### 58. Advanced model fields are saved but omitted from LiteLLM runtime config

- Evidence:
  - `packages/ui/frontend/src/api/models.ts:14-28` defines advanced model fields: `proxy`, `auth_method`, `connect_mode`, `workspace`, `rpm`, `max_tokens_field`, `request_timeout`, `thinking_level`, `tool_schema_transform`, `streaming`, `extra_body`, and `custom_headers`.
  - `packages/ui/frontend/src/components/models/add-model-sheet.tsx:420-441` submits those advanced fields when adding a model.
  - `packages/ui/frontend/src/components/models/edit-model-sheet.tsx:371-392` submits those advanced fields when editing a model.
  - `packages/core/src/api/launcher-compat.ts:2478-2489` returns the stored advanced fields to the frontend.
  - `packages/core/src/api/launcher-compat.ts:2549-2596` persists the same advanced fields into the launcher model state.
  - `packages/core/src/litellm-config.ts:9-14` defines the runtime LiteLLM model input with only `model_name`, `provider`, `model`, `api_base`, and `enabled`.
  - `packages/core/src/litellm-config.ts:204-219` emits only `model`, `api_key`, and sometimes `api_base` into `litellm_params`.
  - `packages/core/src/litellm-config.ts:226-227` writes those limited params to each LiteLLM model entry.
- Impact: advanced model edits appear saved in the UI but do not affect the LiteLLM proxy. Request timeout, RPM, custom headers, extra body, streaming preference, provider-specific thinking/tool transforms, workspace, and proxy are not applied to runtime model calls.
- Recommended fix: extend `LiteLLMStoredModel` and `buildLiteLLMConfig()` to map each supported advanced field to valid LiteLLM config keys, and hide or provider-gate fields that cannot be expressed.

### 59. Session Scope setting is saved but ignored by channel session IDs

- Evidence:
  - `packages/ui/frontend/src/components/config/form-model.ts:82-109` defines session scope options: per-channel-peer, per-channel, per-peer, and global.
  - `packages/ui/frontend/src/components/config/config-sections.tsx:1150-1170` renders the Session Scope selector.
  - `packages/ui/frontend/src/components/config/config-page.tsx:600` saves the selected scope as `session.dm_scope`.
  - `packages/core/src/api/launcher-compat.ts:1772` defines the default `dm_scope` value.
  - `packages/config/src/schema.ts:307` accepts `session` as a generic JSON record, with no typed behavior.
  - `rg -n "dm_scope|per-channel-peer|per-channel|per-peer" packages/core/src` finds no core runtime use outside launcher defaults.
  - `packages/core/src/channels/telegram.ts:116-122`, `packages/core/src/channels/discord.ts:369-379`, `packages/core/src/channels/slack.ts:271-279`, and other channel adapters build fixed session IDs directly before calling `collectAgentResponse`.
- Impact: changing Session Scope in Config does not merge or split conversation memory as advertised. Users selecting global, per-channel, or per-peer still get each adapter's hardcoded session strategy.
- Recommended fix: introduce a shared session-scope resolver that reads `session.dm_scope` and make every channel adapter call it instead of hand-building session IDs.

### 60. Discord Proxy setting is saved but ignored by the adapter

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/discord-form.tsx:82-88` exposes a Discord Proxy input and saves `proxy`.
  - `packages/ui/frontend/src/components/channels/channel-config-model.ts:80` stores non-common channel fields such as `proxy` under `settings`.
  - `packages/core/src/channels/discord.ts:44-51` defines `DiscordRuntimeConfig` without any proxy field.
  - `packages/core/src/channels/discord.ts:74-98` resolves token, allow list, mention behavior, trigger prefixes, and reconnect, but never reads `settings.proxy` or `raw.proxy`.
  - `packages/core/src/channels/discord.ts:211` opens the gateway with `new WebSocket(DISCORD_GATEWAY_URL)`.
  - `packages/core/src/channels/discord.ts:410-413` sends REST requests with plain `fetch()` against `DISCORD_API_BASE`.
  - `rg -n "proxy" packages/core/src/channels/discord.ts` finds no Discord runtime proxy use.
- Impact: users can configure a Discord proxy in the dashboard, but Discord gateway/API traffic still connects directly. Deployments that require an HTTP/SOCKS proxy for Discord access will fail even though the UI setting is saved.
- Recommended fix: add proxy support to `DiscordRuntimeConfig` and wire it into both the WebSocket gateway client and REST fetch transport using a maintained proxy agent, or remove the field from the Discord form until it is implemented.

### 61. WeChat Proxy setting is saved but ignored by QR binding and runtime helpers

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/weixin-form.tsx:105-112` exposes a WeChat Proxy input and saves `proxy`.
  - `packages/ui/frontend/src/components/channels/channel-config-model.ts:80` stores non-common channel fields such as `proxy` under `settings`.
  - `packages/core/src/api/launcher-compat.ts:1460-1464` defines the shared QR helper as plain `fetch(targetURL, ...)` with only headers and timeout.
  - `packages/core/src/api/launcher-compat.ts:3986-3992` fetches the WeChat QR code through that helper.
  - `packages/core/src/api/launcher-compat.ts:4002-4017` polls WeChat QR status through the same direct helper.
  - `packages/core/src/api/channel-runtime-probe.ts:153-157` maps WeChat account/token/env fields, but has no proxy field.
  - `rg -n "settings\\.proxy|raw\\.proxy|\\.proxy|proxy" packages/core/src/api/launcher-compat.ts packages/core/src/api/channel-runtime-probe.ts` only finds unrelated model proxy fields.
- Impact: users can configure a WeChat proxy, but QR binding and readiness/probe paths still connect directly to WeChat endpoints. Environments that need a proxy cannot use the saved dashboard field.
- Recommended fix: thread `settings.proxy` into the QR binding HTTP client and any future WeChat runtime transport with validation, or remove the proxy field until transport support exists.

### 62. Feishu random reaction emoji setting is saved but never used

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/feishu-form.tsx:168-174` exposes `random_reaction_emoji` as an editable list.
  - `packages/ui/frontend/src/components/channels/channel-config-model.ts:80` persists that field under channel `settings`.
  - `packages/core/src/channels/feishu.ts:14-23` defines `FeishuRuntimeConfig` without any reaction or emoji field.
  - `packages/core/src/channels/feishu.ts:87-129` resolves app credentials, Lark/Feishu base URL, verification/encryption, allow list, and group trigger settings, but never reads `random_reaction_emoji`.
  - `rg -n "random_reaction_emoji|reaction|emoji" packages/core/src packages/ui/frontend/src/components/channels` only finds the Feishu form references.
- Impact: changing the Feishu random reaction emoji list in the dashboard has no runtime effect. The adapter never sends reactions or uses the configured emoji list.
- Recommended fix: implement Feishu reaction sending with the configured emoji list, or remove the setting from the form until the adapter supports it.

### 63. Discord Mention Only switch shows the opposite default state

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/discord-form.tsx:103-115` renders the Mention Only switch with `checked={asBool(groupTriggerConfig.mention_only)}`.
  - `asBool(undefined)` returns `false`, so a fresh Discord config with no `group_trigger.mention_only` displays the switch as off.
  - `packages/core/src/channels/discord.ts:80-97` resolves `mentionOnly: groupTrigger.mention_only !== false`, so the same missing value is treated as on.
  - `packages/core/src/channels/discord.ts:120-128` then ignores non-mention/non-prefix messages when `mentionOnly` is true.
- Impact: the dashboard can show Mention Only disabled while the Discord bot still requires mentions or configured prefixes. Users will think the bot should answer normal messages, but backend filtering rejects them.
- Recommended fix: make the Discord form default match the runtime (`groupTriggerConfig.mention_only !== false`) or change the runtime default to false and migrate existing configs intentionally.

### 64. Pico channel token field is disconnected from WebSocket authentication

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-config-model.ts:135-136` treats Pico `token` as a required channel field.
  - `packages/ui/frontend/src/components/channels/channel-config-fields.ts:37` marks Pico `token` as a channel secret, so the generic channel form can save it.
  - `packages/core/src/api/index.ts:406-415` authenticates Pico Bearer tokens only against `launcherRuntimeAuth.getPicoToken()`.
  - `packages/core/src/api/launcher-compat.ts:3197-3209` backs that runtime auth token with `state.pico_token`, not `channels.pico.settings.token`.
  - `packages/core/src/api/launcher-compat.ts:5439-5442` rotates only `state.pico_token` in `/pico/token`.
  - `packages/core/src/api/launcher-compat.ts:5452-5459` writes `channels.pico.settings.token` only during `/pico/setup`, and the exported frontend helpers in `packages/ui/frontend/src/api/pico.ts:28-37` are not called anywhere else in the UI.
  - `packages/core/src/api/channel-runtime-probe.ts:239` marks Pico `token` configured unconditionally, so the probe can report token readiness without validating the saved channel token.
- Impact: changing the Pico token in the channel config page does not change Bearer authentication for `/pico/ws`. Rotating the Pico token through the backend endpoint can also leave saved channel config stale, while readiness still looks configured.
- Recommended fix: use one source of truth for Pico auth. Either drive WebSocket auth from the saved channel secret or make `/pico/token` update the saved channel config/vault and expose the setup/rotation UI clearly.

### 65. Pico Streaming controls are saved but ignored by the WebSocket handler

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-config-page.tsx:641-650` passes `supportsStreaming={channel?.name === "pico"}` into the generic form.
  - `packages/ui/frontend/src/components/channels/channel-forms/generic-form.tsx:97-99` shows the Streaming config when `supportsStreaming` is true.
  - `packages/ui/frontend/src/components/channels/channel-forms/generic-form.tsx:387-391` saves Pico streaming settings through `onChange("streaming", value)`.
  - `packages/core/src/api/index.ts:839-891` always sends `typing.start`, a placeholder `message.create`, and incremental `message.update` events while streaming agent chunks.
  - `rg -n "channels\\.pico|pico.*streaming|settings\\.streaming|raw\\.streaming|streaming" packages/core/src/api/index.ts packages/core/src/api/launcher-compat.ts packages/core/src/api/channel-runtime-probe.ts` finds no Pico runtime read of the saved streaming config; only setup/model-related references appear.
- Impact: turning Pico Streaming off, changing throttle seconds, or changing minimum growth chars in the dashboard does not alter WebSocket chat behavior. The handler streams and placeholders exactly the same way.
- Recommended fix: read `channels.pico.settings.streaming` in the Pico WebSocket handler and apply enabled/throttle/min-growth behavior, or remove the controls from Pico config until implemented.

### 66. Chat message Edit/Delete actions only mutate local UI state

- Evidence:
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:628-639` submits message edits through `editMessage(...)`.
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:1000-1002` wires visible message Edit/Delete actions to `handleEditMessage` and `deleteMessage`.
  - `packages/ui/frontend/src/hooks/use-pico-chat.ts:71-73` exposes `sendMessage`, `deleteMessage`, and `editMessage` from the Pico chat controller.
  - `packages/ui/frontend/src/features/chat/controller.ts:444-448` deletes a message only by filtering the in-memory chat store.
  - `packages/ui/frontend/src/features/chat/controller.ts:450-482` edits a message only by mapping the in-memory chat store.
  - `packages/ui/frontend/src/features/chat/history.ts:42-61` reloads messages from persisted session history through `getSessionHistory(sessionId)`.
  - `rg -n "deleteChatMessage|message\\.delete|delete.*message|messages/:" packages/ui/frontend/src packages/core/src` finds no frontend API call or backend route that deletes/updates an individual persisted chat message.
- Impact: users can edit or delete a message in the chat UI, but the change is not saved. Switching sessions, reconnecting, or reloading history can bring the original message back.
- Recommended fix: add persisted message update/delete endpoints and call them from the chat controller, or label these actions as local-only and keep them out of persisted session history flows.

### 67. Chat Fork From Here creates only a visual fork, not a backend conversation fork

- Evidence:
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:869-873` wires the visible Fork action to `forkFromMessage(messageId)`.
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:1000-1003` passes that fork action into the chat message list.
  - `packages/ui/frontend/src/features/chat/controller.ts:485-511` clones messages up to the selected point, generates a new local session id, updates the local chat store, and reconnects.
  - `packages/ui/frontend/src/features/chat/controller.ts:351-365` sends future Pico messages with only `type`, request id, `payload.content`, and media URLs; it does not send the cloned fork history.
  - `packages/core/src/api/index.ts:853-862` runs the backend agent loop with only `sessionId` and the latest `messageForAgent`.
  - `rg -n "forkChatSessionFromMessage|copy.*session|clone.*session|create.*session" packages/ui/frontend/src/features/chat packages/core/src` finds no backend session-copy operation.
- Impact: after users click Fork From Here, the UI shows earlier messages in a new session, but the backend memory for that new session is empty. The next assistant reply does not actually have the forked context, and a history reload can drop the locally cloned pre-fork messages.
- Recommended fix: add a backend fork endpoint that copies selected session messages into a new session and returns the new session id, then have the UI switch to that persisted fork before reconnecting.

### 68. Chat Retry trims the UI but does not roll back backend session memory

- Evidence:
  - `packages/ui/frontend/src/components/chat/workspace/chat-message-list.tsx:96-100` exposes Retry when connected and not currently typing.
  - `packages/ui/frontend/src/features/chat/controller.ts:516-576` finds the nearest user message, slices local messages back to the retry point, sets `isTyping`, and sends a new Pico message.
  - `packages/ui/frontend/src/features/chat/controller.ts:351-365` sends only the retried content and media URLs, with no rollback marker or target message id.
  - `packages/core/src/api/index.ts:853-862` passes only `sessionId` and the latest message into `orchestrator.runAgentLoop(...)`.
  - `packages/core/src/agent.ts:915-929` immediately appends the retried user message and then reloads existing persisted messages for that same session.
  - There is no individual persisted message delete/update route in the backend to remove the assistant/user messages that the UI trimmed.
- Impact: Retry looks like it re-runs from an earlier point, but the agent can still see the old persisted assistant response and later messages in backend memory. This can make retries contaminated by the exact output the user tried to replace.
- Recommended fix: implement retry as a persisted branch/rollback operation, or create a new forked session with copied history up to the retry point before sending the retried message.

### 69. Workspace Asset delete only hides the row in the current panel

- Evidence:
  - `packages/ui/frontend/src/components/chat/workspace/asset-row.tsx:107-134` presents a destructive Delete action for each asset.
  - `packages/ui/frontend/src/components/chat/workspace/asset-panel.tsx:28-31` keeps deleted asset ids in local component state.
  - `packages/ui/frontend/src/components/chat/workspace/asset-panel.tsx:49-56` handles delete by adding the id to that local set and calling `onDeleteAsset`.
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:880-884` implements `onDeleteAsset` as a toast only.
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:294-319` derives workspace assets from current chat message attachments/tool output rather than from a persisted asset store.
  - `rg -n "deleteAsset|onDeleteAsset|assets.*delete" packages/ui/frontend/src/components/chat packages/core/src/api` finds no API call or backend delete route for chat workspace assets.
- Impact: users can confirm Delete on an asset, but the underlying attachment/file is not deleted and the removal is not persisted. The asset can reappear when the asset panel state resets or chat history is reloaded.
- Recommended fix: implement a persisted asset delete/remove endpoint and update the source message/asset record, or change the action copy to indicate it only hides the item locally.
