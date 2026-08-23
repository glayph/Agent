# Agent Miki

**Agent Miki** is a local-first autonomous AI agent with a Node.js launcher, gateway, TypeScript core, React dashboard, provider/model management, memory, guarded tools, channels, runs, automations, and an execution Inspector. It is organized as a monorepo and requires Node.js 20 or newer.[1] [2]

> **Scope of this document:** The statements below are separated into **verified**, **available with configuration**, and **not verified** so that the README does not claim capabilities that were not demonstrated.

## Setup

Read the [complete setup guide](SETUP.md) before installing or operating Agent Miki. The documented source workflow is:

```bash
npm install
npm run build:all
npm start
```

The complete build includes the platform-specific llama.cpp server executable and may require CMake and a compatible C/C++ compiler when a reusable native artifact is unavailable.[2] Answer-model GGUF files are not bundled; configure a separately obtained model in the dashboard or with `MIKI_MODEL_PATH`. For a conservative Linux build, use `MIKI_LLAMA_BUILD_JOBS=1 npm run build:all`.[2]

After startup, open the local dashboard address printed by the launcher. The verified local instance served the dashboard at `http://127.0.0.1:18800` and exposed a password setup/login flow.

## Linux x64 Offline Release

The repository includes a reproducible builder for the Linux x64 offline release. Run `MIKI_WHISPER_CPP_BIN=/absolute/path/to/whisper-cli MIKI_WHISPER_CPP_MODEL=/absolute/path/to/ggml-tiny.en.bin npm run build:release:linux` after preparing the official voice inputs. The builder assembles the production application, memory and skills packages, bundled npm dependencies, embedded Node runtime, llama.cpp server executable, FFmpeg-enabled Whisper.cpp runtime, voice notices, an npm `.tgz`, an extracted `.tar.gz`, and SHA256 checksums. Answer-model GGUF files are intentionally excluded and must be configured separately at runtime. Generated release files are written outside Git-tracked source by default.

The published Linux package is intentionally scoped to `linux-x64`; it is not a Windows build. Its full install/start instructions and external-model licensing boundary are written into the release asset’s README and `THIRD_PARTY_NOTICES.md`. Separately obtained model files retain their own licenses and are not covered by Agent Miki’s MIT license.

## Verified in the Local Runtime

| Area                             | Observed behavior                                                                                                                                                                                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dashboard and authentication** | The React dashboard served successfully. The first-run/login surface accepted the configured local password and opened the authenticated workspace.                                                                                                                              |
| **Chat surface**                 | The composer, model selector, running/ready state, context indicator, message actions, and provider-error display rendered. A successful cloud-model answer was not obtained in the tested environment because the provider credential request was rejected.                     |
| **Models and credentials**       | The catalog returned 7 models, including Gemini and OpenAI entries. The dashboard exposed model selection and credential-management pages.                                                                                                                                       |
| **Memory**                       | Selective memory search, region filters, reindex, chunk inspection, retrieval traces, postings, and graph-edge status rendered.                                                                                                                                                  |
| **Tools**                        | The authenticated API returned 50 tool entries. The catalog included filesystem, shell, browser, computer, model, runtime, workflow, web-search, and skill-discovery/install surfaces.                                                                                           |
| **Channels**                     | The channel catalog returned 15 entries. The Web channel page exposed enable, token, type, streaming, runtime probe, reset, and save controls.                                                                                                                                   |
| **Drive**                        | The workspace and home-directory locations rendered with path, refresh, and file-action controls.                                                                                                                                                                                |
| **Runs and automations**         | Runs and Automation Center pages rendered with refresh/export/replay/manual-run, workflow, schedule, connection, and execution-history controls. The disposable workspace had no recorded runs or configured workflows.                                                          |
| **Config, Health, and Logs**     | Configuration, health, and logs pages rendered. The command-pattern test correctly marked `rm -rf /tmp/demo` as blocked by the configured deny pattern.                                                                                                                          |
| **Inspector**                    | The Inspector opened from an assistant message, exposed Overview, Response, Thoughts, Work, Artifacts, Evidence, Events, and Voice, and its expand/shrink and close controls worked.                                                                                             |
| **Voice transcription**          | Implemented as an authenticated browser microphone/audio-upload path backed by configured Whisper.cpp endpoint/CLI, with local temporary-audio cleanup and transcript routing through the normal chat pipeline. Runtime/model validation depends on the operator’s installation. |

## Plugins and Skills

### Online discovery and installation

The implementation exposes skill search, validated installation from `npm:`, `git:`, `clawhub:`, or local specifications, manual Markdown/ZIP import, installed-skill metadata, readiness reporting, and workspace-skill deletion routes.[3] A live authenticated search for `github` returned 5 `skills.sh` results, all marked `installed: false`. This verifies online discovery; an untrusted third-party package was deliberately not installed in the audit.

The Agent tool surface now includes `skill_search`, `skill_create`, and `skill_install`. `skill_create` was verified through the ToolRegistry in a disposable workspace: it created `SKILL.md`, metadata, an entrypoint, and a registry record. Remote skill creation and installation first create a persistent high-risk approval request and perform no write until an authenticated owner approves it. The retry uses only the approved request ID, is bound to the original caller and canonical preview hash, and is consumed once. The installer validates the downloaded manifest and refreshes runtime plugin tools; it does not silently activate arbitrary unvalidated code.[3]

Manual import accepts a Markdown file or a ZIP containing `SKILL.md`, rejects oversized files and unsafe archive paths, and stores imported content in an isolated downloaded-skills area.[3] Online installation remains intentionally unverified in this repository test because it would execute the acquisition of third-party code; use an authenticated owner approval after inspecting the request and source.

## Dual-Mode Web Search

The `web_search` tool now supports two explicit retrieval paths plus a controlled hybrid path. **Local mode** performs retrieval from the Miki host using the native DuckDuckGo adapter, falls back to public Bing HTML when the native endpoint is unavailable, or uses an explicitly configured local SearXNG endpoint. **API/Cloud mode** uses an enabled provider with a key stored in the workspace secret vault, currently supporting Brave Search, Tavily, SerpAPI, Serper, and Bing API adapters. **Auto mode** tries local retrieval first and uses an enabled API provider only when local retrieval returns no results; sensitive credential-like queries never use that fallback.

Each successful response includes normalized result records, the selected mode/provider, a fallback flag, and numbered `citations` containing title and direct source URL. The Agent’s active model—local llama.cpp/Ollama or a configured cloud/API model—can then synthesize an answer from those results. This separates **where web data is retrieved** from **where the final answer is generated**. API credentials are never included in tool output. The standard Balanced resource profile allows at most two `web_search` calls per turn; Eco allows one and Performance allows three. If the model still returns no synthesis, Miki emits a clearly marked source-lead summary rather than presenting leak or rumor claims as facts. Unit tests cover local/API responses, compact result handling, cache reuse, URL deduplication, Bing redirect decoding, fallback behavior, sensitive-query blocking, and citation generation; live API provider credentials were not exercised in this environment.

Use the Tools → Web Search page to choose Local, API/Cloud, or Auto, enable a provider, configure its endpoint where applicable, and enter its key through the secret-aware field. The default remains local/native retrieval. The **Local Search Performance** controls enable short-lived caching for non-sensitive queries, set cache lifetime, and bound each result snippet to reduce local-model context usage. Search responses are compact JSON rather than pretty-printed JSON, and tracking parameters/fragments are removed before URL deduplication. In the live Agent test, `what is the GTA 6 NEW LEAKS INFO?` triggered `web_search` in Local mode, while `What is 2+2?` completed without any web-search call; the current-news test produced safe citations when the low-cost model did not return a final synthesis.

## Hourly Project Review

An active project-health schedule runs every **3,600 seconds** with `runAsNewTask: true`, so every run starts as a separate fresh task. Its playbook checks dual-mode web search, model/provider and local-runtime readiness, MCP and Telegram/Web UI safety, tests, logs, and 24/7 readiness. It applies only safe reversible fixes and keeps credentials out of reports and commits. Schedule state is inspected with `manus-config schedule status --limit 1000 --offset 0`.

## MCP

MCP is implemented as an authenticated in-process server with tools, resources, prompts, discovery, session handling, and external connector configuration.[4] The MCP configuration schema supports stdio and HTTP/SSE servers, discovery TTL and result limits, BM25/regex search, and validation rules. Enabled stdio servers require a command; HTTP/SSE servers require a valid HTTP(S) URL without embedded credentials; discovery requires at least one search method; and unsafe environment keys such as `NODE_OPTIONS` are rejected.[5]

An authenticated disposable MCP session was verified after the internal core-client authentication path was corrected. The session completed initialize with HTTP 200, `notifications/initialized` with HTTP 202, `tools/list` with HTTP 200, `resources/list` with HTTP 200, and `prompts/list` with HTTP 200. A read-only `tool_search_tool_bm25` call returned a health-related tool match. MCP tool execution now establishes an explicit remote call context, so remote shell/file mutation guards and approval-gated admin/skill handlers do not treat MCP as local. The new admin tools can read sanitized configuration and request owner-approved changes to tool state or the restricted HTTP/SSE MCP configuration paths.

No external MCP server was configured or executed in this audit. External MCP servers remain untrusted and must be configured only with validated, least-privilege settings. Remote administration rejects stdio command fields, unsafe URLs, raw credentials, prototype keys, and unsupported configuration paths; owner approval is still required before applying an allowed mutation.

## Telegram, Web UI, and Remote Settings Control

The Telegram adapter routes accepted ordinary text messages into the normal Agent orchestrator and supports typing indicators, optional placeholders, collected or streamed replies, reconnect behavior, and sender/chat allow-lists.[6] A separate explicit `admin_allow_from` list authorizes only the deterministic `/miki approvals`, `/miki approve <request-id>`, and `/miki deny <request-id>` commands. These commands operate on the persistent approval inbox and never expose approval tokens. Ordinary slash commands and unauthorized administration commands are not sent to the Agent as privileged operations. A live Telegram delivery was not performed because no approved bot token and test identity were available.

The Web UI exposes authenticated settings and control APIs for configuration read/validate/update/reset, tool enable/disable, channel configuration/probes, runtime reload/restart, skills, models, memory, runs, automations, health, and logs.[3] The Agent tool surface additionally exposes sanitized `admin_config_get`, validated `admin_config_patch`, and approval-gated `admin_tool_state` operations. The Web UI approval endpoints are mounted behind the required API-key middleware; the code-level approval lifecycle was verified with an owner approval followed by one-time context-bound consumption. Free-form chat is not an unrestricted dashboard macro.

| Request source                          | Verified control boundary                                                                                                                                                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Authenticated Web UI/API**            | Can reach the implemented configuration and control surfaces, subject to validation, authentication, runtime-apply behavior, and tool permissions. Owner approval requests can be approved without exposing worker tokens. |
| **Telegram**                            | Ordinary allow-listed text reaches the Agent orchestrator; only an explicit `admin_allow_from` identity can list/approve/deny pending requests through deterministic commands. Live delivery remains untested.             |
| **Authenticated MCP**                   | Can list/call exposed tools and read exposed resources/prompts when MCP is enabled. MCP calls are explicitly remote for policy decisions; external-server execution was not tested.                                        |
| **Remote shell or destructive actions** | Not unrestricted. Shell execution and generic file writes/deletes default-deny for remote callers. Restricted skill/admin mutations require owner approval, validation, context binding, and one-time consumption.[7] [9]  |

The current code establishes local/remote call origin for HTTP chat/tool routes, Telegram turns, and MCP tool execution. This does not make free-form remote chat an unrestricted control plane: only the dedicated validated administration tools are exposed for Agent-driven settings changes, and the restricted patch policy intentionally excludes arbitrary commands, credentials, factory reset, and destructive filesystem access.

## Conversational Chat and Inspector Details

The normal chat transcript is intentionally conversational: each assistant bubble shows only a short, human-like answer preview. The complete answer is not expanded inside the bubble; the user opens **Inspector** on that bubble to read the full response and all detailed explanation. Plans, thought summaries, tool activity, source-research notes, reports, and verification remain in Inspector.

The UI groups thought summaries and hidden tool-feedback messages by `run_id`, so the details shown in Inspector belong to that response rather than to an unrelated turn. The Inspector’s Thoughts page explicitly labels its content as summaries and redacts private hidden chain-of-thought. This keeps ordinary chat readable while preserving auditability, source leads, tool activity, and verification evidence.

## Voice Messages with Whisper.cpp

The Chat composer includes microphone recording and an **Upload audio** fallback. Audio is sent to an authenticated, bounded transcription endpoint, validated, and processed by an operator-configured official `whisper.cpp` server or CLI. The returned transcript is submitted through the same WebSocket and `runAgentLoop` path as typed text, so the answer can come from the local LLM route or a configured cloud/API model. Transcription is local/offline by default when the endpoint is loopback; no raw audio is retained by the current implementation.

Voice transcription is disabled until a Whisper.cpp runtime and model are explicitly installed and configured. The supported configuration, browser limits, Linux/Windows build commands, and the optional FFmpeg requirement for browser formats are in [SETUP.md](SETUP.md). The Inspector adds a **Voice** page for transcript, provider, language, timing, and transport diagnostics. Telegram voice-file ingestion and spoken TTS replies are not claimed as implemented.

## Inspector

The Inspector opens from **Inspect agent** on an assistant message. Its verified pages are:

| Page          | Observed purpose                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Overview**  | Message count, live-node count, selected message, and recent activity.                                               |
| **Response**  | Short human-facing answer separate from detailed execution information.                                              |
| **Thoughts**  | Concise categorized execution summaries; private hidden chain-of-thought is not shown.                               |
| **Work**      | Execution nodes and tool-call summaries when available.                                                              |
| **Artifacts** | Generated files and attachments when available.                                                                      |
| **Evidence**  | Checkpoints and verifier evidence when available.                                                                    |
| **Events**    | Timestamped realtime summaries and execution/error events.                                                           |
| **Voice**     | Whisper.cpp transcript, language, provider, duration, latency, and transport diagnostics; raw audio is not retained. |

## Verification Record

| Check                    | Result                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused capability tests | Passed: ToolRegistry skill/admin approval flows (5 tests), approval inbox including tokenless context binding (7 tests), and Telegram admin parsing/allow-list tests (2 tests).                                                                                                                                                                                                                                        |
| Workspace tests          | The prior workspace suite passed for the frontend (**13 test files and 52 tests**) and memory integration/selective-memory tests. The current legacy core scan is not a clean baseline: it contains pre-existing Jest/global-harness incompatibilities and a test file with a stray `EOF`; the focused changed-surface suite passed 97/98, with the remaining failure in an unrelated legacy Jest-based launcher test. |
| Workspace builds         | Config, installer, skills, memory, core, gateway, and frontend production builds passed after the implementation changes.                                                                                                                                                                                                                                                                                              |
| Backend lint             | Passed with `--max-warnings=0` for the backend scope after formatting the implementation.                                                                                                                                                                                                                                                                                                                              |
| Launcher doctor          | Exit 0 with `WARN`: Node/npm, configuration, data, SQLite, secret vault, provider audit, and migrations were available; Go and native runtime artifacts were incomplete in the sandbox.                                                                                                                                                                                                                                |
| 24/7 readiness           | Passed with `ok: true` and a valid gateway entrypoint.[8]                                                                                                                                                                                                                                                                                                                                                              |
| Gateway                  | `/health` returned HTTP 200.                                                                                                                                                                                                                                                                                                                                                                                           |
| Skill discovery          | Passed: 5 online `skills.sh` results returned; no untrusted online installation was performed. Local Agent-authored creation and remote approval/one-time consumption passed.                                                                                                                                                                                                                                          |
| MCP                      | Passed after the internal authentication fix: initialize, tools/list, resources/list, prompts/list, and read-only discovery call all returned successful protocol responses; remote-origin propagation is covered by the ToolRegistry path.                                                                                                                                                                            |
| Telegram                 | Deterministic admin parser and explicit `admin_allow_from` boundary passed unit tests; live delivery was not tested because no approved bot token/test identity was available.                                                                                                                                                                                                                                         |
| Provider response        | Not passed in the available provider setup: Gemini returned a credential rejection/HTTP 401 in the previous live test.                                                                                                                                                                                                                                                                                                 |
| Full `npm run verify`    | Not completed within the bounded test window; it reached the test phase before timing out.                                                                                                                                                                                                                                                                                                                             |

## Runtime and Security Boundaries

Agent Miki’s actual capabilities depend on configuration, provider credentials, enabled tools, channel allow-lists, MCP server definitions, and the active workspace. The test workspace had zero installed skills, zero configured external MCP servers, zero recorded agent runs, zero configured automations, no generated artifacts, and no verifier checkpoints.

Keep API keys, Telegram bot tokens, MCP secrets, local databases, runtime logs, compiled executables, private keys, downloaded skills, and model files out of Git. Use the dashboard vault or deployment environment for credentials.[2]

## References

[1]: package.json "Agent Miki package manifest and supported commands"
[2]: SETUP.md "Agent Miki complete setup guide"
[3]: packages/core/src/api/launcher-compat.ts "Launcher control, skill, tool, channel, and configuration APIs"
[4]: packages/core/src/mcp/server.ts "MCP server registration, discovery, and tool execution"
[5]: packages/config/src/schema.ts "MCP configuration and safety validation"
[6]: packages/core/src/channels/telegram.ts "Telegram channel configuration and Agent routing"
[7]: packages/core/src/tools/executor/shell.ts "Shell execution permissions and remote/workspace guardrails"
[8]: scripts/miki-24-7.mjs "24/7 runtime readiness check"
[9]: packages/core/src/security/approval-inbox.ts "Persistent owner-approval lifecycle and context-bound one-time consumption"
