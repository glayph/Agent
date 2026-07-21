
### 96. Manual tools.yaml disabled tool state is not imported and can be overwritten by the dashboard

- Evidence:
  - `packages/core/src/tools/registry/executor.ts:250-270` enforces disabled tools from `config/tools.yaml` via `tool_state`, `disabled_tools`, and disabled permission levels.
  - `packages/core/src/tools/executor/file-security.ts:89-101` does the same for file tools.
  - `packages/core/src/api/launcher-compat.ts:1527-1575` reads `config/tools.yaml` at startup, but it only pulls runtime exec fields and shell permission details into dashboard config; it does not import root `tool_state` or `disabled_tools`.
  - `packages/core/src/api/launcher-compat.ts:3175-3178` initializes `state.tool_state` to `{}` when launcher state has none.
  - `packages/core/src/api/launcher-compat.ts:3220-3232` later syncs runtime files from `state.config` and that in-memory `state.tool_state`.
  - `packages/core/src/api/launcher-compat.ts:1653-1720` rewrites `config/tools.yaml` with `next.tool_state = toolState` and `next.disabled_tools = Object.entries(toolState).filter(...)`, so any manually configured disabled tools missing from launcher state are dropped.
  - `packages/core/src/api/launcher-compat.ts:5690-5698` reports the Tools page status from `state.tool_state` rather than the currently enforced `config/tools.yaml`.
- Impact: an operator can disable a tool directly in `config/tools.yaml` and the runtime will enforce it, but the dashboard can still show the tool as enabled. The next config save or tool toggle can rewrite `tools.yaml` from empty launcher state and silently re-enable tools that were intentionally disabled outside the UI.
- Recommended fix: import `tool_state` and `disabled_tools` from `config/tools.yaml` into launcher state during startup, compute `/api/tools` status from the same runtime tools config that the executor reads, and preserve unknown/manual disabled entries when syncing dashboard config.

### 97. Secret scan reports pass after scanning only a narrow subset of workspace files

- Evidence:
  - `packages/core/src/safety/secret-scan.ts:44-45` limits candidates to text extensions under only `config`, `docs`, and `logs`.
  - `packages/core/src/safety/secret-scan.ts:79-92` adds only `.env`, those three directories, and top-level text files directly under `data`; it does not scan source folders such as `packages`, `scripts`, `bin`, test fixtures, or root project files like `package.json`.
  - `packages/core/src/safety/secret-scan.ts:95-106` filters the already-narrow candidate list and never widens it to the repository tree.
  - `packages/core/src/safety/doctor.ts:306-317` marks the doctor secret-scan check as pass when this limited scan has no findings.
  - `packages/core/src/api/enhancement-router.ts:489-492` includes the same limited scan in the Health full report, and `packages/core/src/api/enhancement-router.ts:597-601` exposes it as the manual secret-scan action.
  - `bin/Hiro-doctor.mjs:120-148` has a separate CLI implementation with an even narrower candidate list: `.env`, `config`, and `docs`.
  - Running `node scripts/run-verify.mjs --help` in this workspace executed the verify pipeline and its doctor step reported `secret_scan` pass with `scannedFiles: 4`, despite the repository containing hundreds of source and script files.
- Impact: Health and doctor can say "No likely secret leaks found" while most of the project was never inspected. A leaked key in `packages/`, `scripts/`, frontend source, backend tests, or other root project files will be missed, and the dashboard summary makes the result look comprehensive.
- Recommended fix: make the scanner traverse the workspace with an explicit denylist for `node_modules`, `dist`, `.git`, generated backups, binary/media files, and oversized files. Share one implementation between the CLI doctor and core Health scanner, and show both scanned and skipped counts with skip reasons.

### 98. Drive write restrictions can be bypassed through a symlinked or junction ancestor

- Evidence:
  - `packages/core/src/api/file-manager-router.ts:183-192` checks write scope with `isPathInside(workspaceDir, targetPath)`, which is a lexical `path.relative` check rather than a realpath/ancestor walk.
  - `packages/core/src/api/file-manager-router.ts:218-230` allows an existing target after `lstat(targetPath)` if the final path itself is not a symlink.
  - `packages/core/src/api/file-manager-router.ts:251-259` rejects only the final filesystem node passed to `assertSafeFilesystemNode`; it does not inspect each ancestor.
  - Existing-file routes call those checks before mutating: write at `packages/core/src/api/file-manager-router.ts:1039-1057`, rename at `:1090-1101`, run/open at `:1154-1163`, and delete at `:1167-1185`.
  - A local repro with a workspace directory junction to an outside temp directory showed `path.relative(workspace, workspace/linkout/owned.txt)` is lexically inside, `lstat(workspace/linkout/owned.txt)` reports the outside file rather than the junction, and writing that path changed the outside file content.
- Impact: when system write is disabled, Drive blocks direct outside writes, but an existing file under a workspace symlink/junction ancestor can still be overwritten, renamed, deleted, or opened through the dashboard file manager. This bypasses the workspace-only safety model for common Windows junctions and POSIX symlinks.
- Recommended fix: resolve and validate the real path of the target and every ancestor before any read/write/delete/run operation, reject paths whose resolved location leaves the workspace when system write is disabled, and add regression tests for existing files under symlinked/junction directories.

### 99. Session history pagination still loads every session and every message before slicing

- Evidence:
  - `packages/ui/frontend/src/api/sessions.ts:54-63` sends `offset` and `limit` to `/api/sessions`.
  - `packages/ui/frontend/src/hooks/use-session-history.ts:5-35` implements incremental loading with `LIMIT = 20`, `offset`, `hasMore`, and an `IntersectionObserver`.
  - `packages/core/src/api/launcher-compat.ts:4484-4507` reads `offset`/`limit`, but first calls `orchestrator.memory.relational.getAllSessions()` and maps every session.
  - `packages/core/src/api/launcher-compat.ts:4489-4500` calls `getMessages(session.id)` for each session just to compute the first message and count.
  - `packages/core/src/api/launcher-compat.ts:4504-4507` applies `slice(safeOffset, safeOffset + safeLimit)` only after all sessions and their messages have been loaded.
  - `packages/core/src/memory/repositories/session.ts:229-254` already has SQL summary helpers, but they also lack `LIMIT`/`OFFSET` parameters and the compat route does not use them.
- Impact: the UI looks paginated, but each "load more" request can do O(total sessions + total messages) backend work. Large chat histories can make the history menu slow or timeout even when the frontend asks for only 20 rows.
- Recommended fix: add a paginated SQL summary query with `LIMIT` and `OFFSET`, compute title/preview/message count in SQL for only the requested page, return a total or `has_more`, and update both direct and compat session APIs to share it.

### 100. Verify scripts ignore `--help` and unknown flags, then run the full pipeline

- Evidence:
  - `package.json:39-40` exposes `npm run verify` and `npm run verify:release` through `scripts/run-verify.mjs` and `scripts/run-release-verify.mjs`.
  - `scripts/run-verify.mjs:1-21` never reads `process.argv`; it always runs JS tests, frontend tests, Go tests, production audit, and doctor.
  - `scripts/run-release-verify.mjs:1-35` also never reads `process.argv`; it always runs tests, audit, lint, build, doctor, pack check, and smoke suites.
  - Running `node scripts/run-verify.mjs --help` in this workspace executed the full verify pipeline and ended with `Verification passed in 52.9s` instead of printing usage.
  - `scripts/frontend-pnpm.mjs:10-60` shows the repo already uses explicit argument handling and usage output for helper scripts, so this behavior is inconsistent with the local script style.
- Impact: developers and automation wrappers cannot safely ask the verify commands for usage. Mistyped flags are silently ignored, and a harmless-looking help request can trigger long-running tests, audits, doctor checks, and release work.
- Recommended fix: add a shared argument parser for verify scripts, implement `-h`/`--help`, reject unknown flags, and document any intentional flags such as `--skip-external`, `--no-smoke`, or release-only modes.

### 101. Several functional channel allowlists are enforced by runtime but not configurable from the dashboard

- Evidence:
  - `packages/core/src/channels/line.ts:84` reads `settings.allow_from ?? raw.allow_from`, and `packages/core/src/channels/line.ts:114-121` rejects LINE events whose user/group/room ID is not in `allowedIds`.
  - `packages/ui/frontend/src/components/channels/channel-forms/line-form.tsx:27-64` renders only token and channel secret fields; it has no `allow_from` field.
  - `packages/core/src/channels/dingtalk.ts:107` reads `settings.allow_from ?? raw.allow_from`, and `packages/core/src/channels/dingtalk.ts:229-236` enforces conversation/sender/staff allowlists.
  - `packages/ui/frontend/src/components/channels/channel-forms/dingtalk-form.tsx:28-65` renders only webhook URL and client secret; it has no `allow_from` field.
  - `packages/core/src/channels/qq.ts:97` reads allowlists and `packages/core/src/channels/qq.ts:174-184` enforces user/channel/group/guild allowlists, but `packages/ui/frontend/src/components/channels/channel-forms/qq-form.tsx:27-53` renders only bot ID and token.
  - `packages/core/src/channels/matrix.ts:104` reads allowlists and `packages/core/src/channels/matrix.ts:124-128` enforces room/sender allowlists, but `packages/ui/frontend/src/components/channels/channel-forms/matrix-form.tsx:30-70` renders only homeserver, user ID, and access token.
  - `packages/core/src/channels/irc.ts:133` reads allowlists and `packages/core/src/channels/irc.ts:194-204` enforces nick/channel allowlists, but `packages/ui/frontend/src/components/channels/channel-forms/irc-form.tsx:22-92` renders server, port, nick, channels, TLS, and passwords only.
- Impact: operators can use the dashboard to enable these functional channels, but cannot configure the runtime-supported allowlist filters from the same UI. The safest deployment shape is therefore unreachable for LINE, DingTalk, QQ, Matrix, and IRC unless the operator manually edits config files or environment variables.
- Recommended fix: expose `ChannelArrayListField` for `allow_from` in those channel forms, reuse the existing parser/placeholders, add form serialization tests for each channel, and verify saved allowlists are enforced by the runtime resolver tests.

### 102. Group trigger prefixes are supported by several channel runtimes but missing from their custom forms

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-forms/generic-form.tsx:337-366` already has a `group_trigger.prefixes` editor, but many functional channels bypass the generic form with custom forms.
  - `packages/core/src/channels/discord.ts:82-96` reads `group_trigger.prefixes`, and `packages/core/src/channels/discord.ts:126-128` allows prefixed Discord group messages, but `packages/ui/frontend/src/components/channels/channel-forms/discord-form.tsx:101-116` exposes only the mention-only toggle.
  - `packages/core/src/channels/feishu.ts:95-128` reads `group_trigger.prefixes`, and `packages/core/src/channels/feishu.ts:305-310` accepts prefixed group messages when mention-only is enabled, but `packages/ui/frontend/src/components/channels/channel-forms/feishu-form.tsx:153-174` exposes mention-only and random reaction emoji only.
  - `packages/core/src/channels/onebot.ts:154-176` reads `group_trigger.prefixes`, and `packages/core/src/channels/onebot.ts:197-199` requires a mention or prefix for group events, but `packages/ui/frontend/src/components/channels/channel-forms/onebot-form.tsx:109-124` exposes only the mention-only toggle while its hint says "respond only when mentioned or prefixed."
  - `packages/core/src/channels/qq.ts:83-99` reads `group_trigger.prefixes`, and `packages/core/src/channels/qq.ts:187-199` uses prefixes to pass group messages, but `packages/ui/frontend/src/components/channels/channel-forms/qq-form.tsx:27-53` has no group trigger section.
  - `packages/core/src/channels/irc.ts:133-138` reads `group_trigger.prefixes`, and `packages/core/src/channels/irc.ts:211-213` uses prefixes for channel messages, but `packages/ui/frontend/src/components/channels/channel-forms/irc-form.tsx:22-92` has no group trigger section.
- Impact: users can turn on or rely on mention-only behavior, but cannot add the prefixes that the backend already supports for Discord, Feishu, OneBot, QQ, or IRC. Group channels can therefore ignore `/ask`, `!bot`, or similar command-style prompts even though the runtime has support for them.
- Recommended fix: add the same `group_trigger.prefixes` array editor to the custom forms that expose mention-only or support group routing, preserve existing `mention_only` values when editing prefixes, and add runtime/form serialization tests for each affected channel.

### 103. Channel live outbound send checks can report `passed` without sending anything

- Evidence:
  - `packages/ui/frontend/src/components/channels/channel-config-page.tsx:755-779` exposes a Telegram live test button, and `packages/ui/frontend/src/components/channels/channel-config-page.tsx:798-804` displays `send_check.status` as a compact "Send: passed/skipped/failed" badge.
  - `packages/core/src/api/launcher-compat.ts:5355-5357` runs real extra live checks only for Telegram and only for the `mode=live` probe.
  - `packages/core/src/api/channel-runtime-probe.ts:476-490` appends an `outbound_send` pass/fail check based solely on `buildMockSendCheck`.
  - `packages/core/src/api/channel-runtime-probe.ts:594-601` skips live send checks unless `Hiro_CHANNEL_ALLOW_LIVE_SEND=true`.
  - `packages/core/src/api/channel-runtime-probe.ts:604-609` returns `status: "passed"` for live mode with the message "provider call remains adapter-controlled"; it does not call Telegram, Discord, Slack, LINE, DingTalk, or any outbound adapter.
  - `packages/core/src/api/launcher-compat.test.ts:1351-1373` codifies the behavior: configured probes can have `send_check.status === "passed"`, and live probes without the allow flag are merely skipped.
- Impact: a dashboard probe can show `Send: passed` even though no message was delivered to the provider. This is misleading for setup validation because webhook/auth shape may be valid while outbound reply permissions, destination IDs, API rate limits, or provider-side send failures remain untested.
- Recommended fix: rename the current check to "send contract" or "send preflight" unless it actually sends, and implement provider-specific live send paths behind an explicit destination/confirmation gate. The UI should show whether a real provider request was made, skipped, or only contract-validated.

### 104. The chat `/goal` shortcut opens a panel but traps the composer instead of starting a goal

- Evidence:
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:131-133` treats only the exact input `/goal` as the goal command.
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:562` sets `showGoalCommandPanel` directly from the composer input.
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:621-624` makes `handleSend` return early whenever `showGoalCommandPanel` is true.
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:763-767` also disables `canSubmit` while `showGoalCommandPanel` is true, so pressing the send button or Ctrl/Cmd+Enter does nothing.
  - `packages/ui/frontend/src/components/chat/chat-page.tsx:1008-1016` renders `<PursueGoalPanel />` above the composer but passes no callback to clear the `/goal` input or auto-open the create dialog.
  - `packages/ui/frontend/src/components/chat/pursue-goal-panel.tsx:49-60` owns its `open` state internally and initializes the create dialog closed.
  - `packages/ui/frontend/src/components/chat/pursue-goal-panel.tsx:87-99` clears only the panel's internal objective/details/steps state after create; it cannot clear the chat composer input that keeps `showGoalCommandPanel` true.
- Impact: typing `/goal` appears to activate the feature, but it does not submit a command, does not open the create-goal dialog, and leaves the composer stuck in a disabled shortcut state. Even after creating a goal through the small panel button, the `/goal` text can remain in the composer and keep normal chat sending blocked until the user manually deletes it.
- Recommended fix: handle `/goal` as an explicit command action: consume and clear the composer input, auto-open the goal dialog, and provide a close/cancel path that restores normal chat input. Add a UI test for typing `/goal`, pressing Enter, creating a goal, and immediately sending a normal follow-up message.
