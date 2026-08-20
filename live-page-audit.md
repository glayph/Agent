# Agent Miki web UI page audit

## Initial inventory

The generated frontend route tree registers these top-level and nested routes: `/`, `/channels`, `/channels/$name`, `/drive`, `/models`, `/credentials`, `/config`, `/config/raw`, `/health`, `/logs`, `/agents`, `/agents/$id`, `/agents/swarm`, `/agent/hub`, `/agent/monitor`, `/agent/runs`, `/agent/run`, `/agent/skills`, and `/agent/tools`. It also contains launcher-only routes `/launcher-login` and `/launcher-setup`.

## `/channels/miki`

The Channels page is a real configuration page, not an empty placeholder. It reports the Web channel as Functional and exposes enable/disable, token, type, streaming-output, runtime probe, reset, and save controls. The channel route automatically redirected from `/channels` to `/channels/miki`, indicating the parent route is a channel selector/redirect rather than a standalone content page.

## `/drive`

The Drive page is functional-looking system file navigation. It shows filesystem capacity, Workspace and Home locations, a path field, refresh, and actions. It is not empty, although its usefulness depends on whether file browsing/actions are intended for this local runtime.

## `/health`

The Health page is substantive and has real diagnostics and recovery actions: Run doctor, Create backup, Secret scan, Reset watchdog state, Clear Safe Mode, refresh, and rollback entries. It reported `degraded`, with Safe Mode active and Doctor warning. It also exposed actionable partial states: `miki_memory.db` was missing (Memory/Context partial), Go was unavailable, and External Systems reported missing core file/shell tools even though 40 tools were registered. This page is not unused; it is a valuable diagnostic surface, though it currently exposes runtime gaps that should either be fixed or clearly explained.

## `/models`

The Models page is functional. It lists configured providers and models, supports Saved Catalogs and Add Model, exposes default-model selection, API-key editing, deletion, and model connectivity/configuration. It currently shows two Google Gemini models (including the retired `gemini-2.0-flash-001` entry and the current `gemini-3.6-flash` entry), two OpenAI models, and two unconfigured OpenRouter models. The retired Gemini entry is not an unused page, but it is stale model data that should be removed or marked unavailable to prevent fallback errors.

## `/credentials`

The Credentials page is functional and separate from `/models`: it manages provider-level OpenAI and Google Antigravity/Gemini credentials, with reveal, save, and logout controls. However, it overlaps conceptually with the API-key controls inside `/models`. This is a UX redundancy rather than a dead page. A clearer design would make `/credentials` the canonical provider-secret store and let model cards reference credentials, rather than displaying or editing the same secret at both levels.

## `/config` and `/config/raw`

Both URLs render the same full Config page; `/config/raw` is not a distinct raw JSON editor or separate advanced view. The Config page has many real controls for launcher, agent, runtime, MCP, command safety, cron, and reset/save operations, so the page itself is useful. However, the `Raw Config` link is functionally redundant/misleading because it returns the same page rather than a raw configuration representation. The page also visibly labels `Evolution` and `Devices` as `Coming Soon` while still exposing their switches and fields. Those controls are candidates to hide or disable until implemented.

## `/agents` and `/agents/swarm`

`/agents` is a real but currently empty registry page. It provides links to Agents Swarm and Swarm Monitor and reports `No agents found in the registry`, with no create/register action visible. `/agents/swarm` is a real telemetry page, showing Active Specialists and Pending Tasks, both currently zero. These are not dead routes if specialist-swarm functionality is planned, but for a single-agent installation they are effectively empty operational pages. They should either be hidden behind an advanced/swarm feature flag, or provide an explicit empty-state explanation and a way to register/configure a specialist.

## `/agent/hub` and `/agent/skills`

`/agent/hub` is functional as a skill-discovery search page, with a capability search input and a search action. It is not a general agent hub despite its name; its purpose overlaps with skill discovery.

`/agent/skills` was observed rendering only `Loading…` with no navigation, controls, or content in the captured page state. This is the strongest candidate for an actually broken or useless page. It may be an API-loading failure or a frontend route problem, so it should be tested against the skills API and either repaired or removed from the sidebar until it loads reliably. The page also overlaps with `/agent/hub`, which performs skill discovery, but `/agent/skills` should still be retained if it is intended to list installed skills after the loading bug is fixed.

## `/agent/tools`

The Tools page is functional. Its Tool Library is populated with enabled/disabled switches, risk labels, search/filter controls, and Settings. It exposes the actual local, browser, computer, model, project, skill, and search tool inventory. Its Web Search tab is also functional: it has primary-provider selection, proxy input, Prefer Native Search switch, provider rows for Native Web Search, Tavily, and SerpAPI, and Save Changes. This page should be kept.

## `/agent/runs` and `/agent/monitor`

`/agent/runs` is implemented with Refresh, Export, Replay, New Run, filters/search, and a Create Manual Run empty-state action. It currently reports `No agent runs recorded` even though a dashboard chat task was previously executed, which suggests the page is not receiving or persisting dashboard-created runs in this runtime. It is therefore useful in design but currently misleading/incomplete in live behavior.

`/agent/monitor` rendered a blank page with only the global navigation and no heading, metrics, controls, or loading/error state. This is a clear broken/unused page candidate and should be repaired or removed from the navigation until an actual monitor implementation is available.

## `/logs`, `/health`, and sidebar `System`

`/logs` is functional: it renders a Gateway Log Stream with Auto-scroll, Copy, and Clear controls. The current stream contains only one startup line, but the page itself is useful.

`/health` is highly functional and should be kept. It provides degraded/healthy status, Doctor, Safe Mode, backups, secret scan, watchdog, queue, Agent Flow coverage, component diagnostics, rollback actions, and remediation buttons. It currently reports meaningful partial states, including missing `miki_memory.db`, safe mode active, and missing core file/shell handlers.

The sidebar `System` item points to `/system`, which renders `Not Found`. This is a definite invalid navigation entry and should either be removed from the sidebar or mapped to an existing page such as `/health` or `/config`.
