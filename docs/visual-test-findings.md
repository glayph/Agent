# Agent Miki Visual Test Findings

**Test date:** 2026-08-27

The local Agent Miki runtime was started on `127.0.0.1:18800` with the dashboard password supplied by the project owner. The first-run setup page rendered successfully, accepted the password confirmation, and redirected to the sign-in page. Sign-in then opened the authenticated Agent Workspace.

The authenticated home screen visibly rendered the Miki brand, Agent Workspace header, Ready status, active-agent/event counters, navigation links for Chat, Drive, Hub, Agent Control, and Runs, a Plugins button, a command palette control, a Pursue Goal action, and the message composer. The home state correctly reported that no AI model was configured, so chat execution was not attempted without a valid provider/model configuration.

Screenshots captured by the browser during this pass are stored initially under `/home/ubuntu/screenshots/` and will be copied into this repository's documentation evidence directory before delivery.

## Additional visual observations

The Drive route rendered a System workspace with a visible workspace location, path field, refresh control, and actions menu. The Hub route rendered the Discover Skills view with a capability search input, command-palette shortcut, and a Shutdown Backend control. Both routes loaded without a blank page or HTTP-level failure.

## Control and runs observations

Agent Control rendered a self-improvement panel in draft mode with zero decisions and zero pending drafts, safe controls for active model and resource profile, and a sanitized capability inventory. It explicitly showed all listed models as unconfigured and did not expose raw credentials.

Runs rendered its search, refresh, export, replay, and New Run controls and a truthful empty state stating that no agent runs were recorded. This is consistent with the absence of a configured model and with the decision not to fabricate a run.

## Plugin visual observations

The Plugins panel rendered a modular capability navigation with Catalog, Providers & Models, Credentials, Channels, Skills, Tools, Memory, Configuration, Automation, Health, and Logs. The Catalog route rendered provider, channel, and capability tiles with visible status counts. The catalog reported 32 ready, 4 partial, and 12 core items in this runtime snapshot; Gemini was visibly partial and llama.cpp Local was listed as functional at catalog level, while the control page correctly showed the models as unconfigured for actual use.

## Models visual observations

The Models page rendered a clear warning that the default model is not configured. It listed the local llama.cpp model and three Gemini model entries, each marked not configured, while exposing Add Model, Saved Catalogs, API-key edit, delete, and default-selection controls. The page therefore provides model administration UI but correctly blocks actual chat until a valid provider is configured.

## Credentials and provider documentation observations

The Credentials page rendered two supported provider cards: Google Gemini and local llama.cpp. Both were visibly not logged in, with controls to configure each provider. It stated that secrets use a protected credential flow and are not sent to the model as plain chat content.

OpenCode's official Zen documentation states that Zen is an optional AI gateway, that users obtain an API key by logging in, and that OpenCode model identifiers use the `opencode/<model-id>` format. The provided OpenCode key did not include an endpoint, so no OpenCode request was sent without a verified base URL.

## Channels and Skills observations

The Channels route defaulted to the Web/Miki channel and rendered an enable switch, secret token field with show control, type field, streaming-output switch, runtime probe, reset, and save controls. No secret was entered.

The Skills route rendered **39 skills** with search, type filter, sort, grouped/grid view, and per-skill View controls. It also rendered plugin marketplace readiness counters, all zero because no installed plugin contracts are registered. This current result differs from the earlier audit snapshot of 38 skills; the latest runtime snapshot is recorded without treating either count as callable-skill proof.

## Tools and Memory observations

The Tools page rendered a searchable Tool Library with risk labels and enable/disable switches for filesystem, shell, web/browser, computer, model, workflow, configuration, goal, and skill-related tools. The page visibly distinguished high-risk actions such as shell execution, file write, and file delete from lower-risk reads.

The Memory page rendered selective retrieval, Refresh and Reindex controls, search, region filters, chunk inspector, and truthful zero-state counters for chunks, postings, graph edges, and retrievals. It stated that memory is scope-fixed and credential values are not shown.

## Configuration and Automation observations

The Config page rendered launcher, agent, runtime, MCP, command, cron, and device sections. It visibly exposed workspace restriction, bypass restriction, blacklist, command timeout, scheduled-command, heartbeat, and evolution controls; no configuration was changed during the visual pass.

The Automation Center rendered zero configured workflows, active/paused/disabled counters, no active schedules, history, create, connections, and manage-schedules navigation. Its empty state was truthful and clearly offered workflow creation without creating one automatically.

## Health and Logs observations

The Health page rendered an overall healthy state, passing doctor checks, safe mode off, two backups, zero secret findings, agent-flow readiness details, model-provider status, memory state, tool counts, queue/delivery counters, and a visible gateway restart requirement for a process-bound setting. It also exposed Run doctor, Create backup, Secret scan, and watchdog recovery controls.

The Logs page rendered a 28-line gateway log stream with Auto-scroll, Copy, and Clear controls. Logs showed core startup, provider plugin registration, memory initialization, MCP disabled due to missing API_KEY_SECRET, disabled channel adapters due to absent credentials, and capability plugin startup. No credential value was displayed.

## Chat execution observation

A harmless three-item checklist request was submitted through the authenticated local chat UI. The message was accepted and the workspace recorded three messages/run context. The UI then reported that the Gemini credential was missing or rejected and instructed the operator to add a valid key before retrying. It did not fabricate a checklist, claim a successful model response, modify files, or call an external service.
