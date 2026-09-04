# Agent Miki Plugin Architecture and Web UI Implementation Plan

## Scope

এই নথিটি Agent Miki-এর বর্তমান repository audit-এর ভিত্তিতে তৈরি। লক্ষ্য হলো বিদ্যমান Plugin system নষ্ট না করে Plugin বনাম Core boundary পরিষ্কার করা, Plugin-related existing page-গুলোকে একটি একীভূত Web UI Plugin section-এর মধ্যে আনা, এবং lifecycle/configuration/status-এর জন্য canonical backend contract পুনর্ব্যবহার করা।

বর্তমান source-এ Plugin SDK ইতোমধ্যেই manifest, descriptor, context, registry এবং lifecycle manager নির্ধারণ করেছে। `PluginManifest`-এ `id`, `displayName`, `version`, `apiVersion`, `capabilities`, `runtimeStatus`, configuration, permissions এবং platform metadata আছে; `PluginLifecycleManager` start, reload, stop এবং health পরিচালনা করে [1]। Built-in catalog provider, channel এবং capability—এই তিন family-তে manifest প্রকাশ করে [2]।

## Audit findings

| ক্ষেত্র            | প্রত্যক্ষ অবস্থা                                                                                                                         | সিদ্ধান্ত                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Plugin SDK         | Canonical manifest, descriptor, registry এবং lifecycle manager বিদ্যমান                                                                  | নতুন parallel Plugin contract তৈরি করা হবে না                                                          |
| Built-in catalog   | Provider, channel এবং capability family-তে catalog প্রকাশিত                                                                              | UI catalog-এর source of truth হবে existing catalog API                                                 |
| Runtime ownership  | কিছু stateful capability core host-এ ইচ্ছাকৃতভাবে activation থেকে বাদ আছে                                                                | core-owned item-কে independently installable/active হিসেবে দেখানো হবে না                               |
| Backend plugin API | `/api/skills/plugins`-এ contracts, runtime contracts, capabilities, capability health, channels, providers এবং marketplace readiness আছে | নতুন UI-র read model হিসেবে existing endpoints reuse করা হবে                                           |
| Existing Web UI    | Channels, Models, Skills, Tools, Credentials, Memory, Config, Automations, Logs এবং Health আলাদা primary navigation item                 | functionality রেখে Plugin section-এ grouped navigation যোগ হবে; পুরোনো route backward-compatible থাকবে |
| Sidebar primitive  | Existing sidebar primitive `variant="floating"` সমর্থন করে                                                                               | নতুন floating sidebar-এর জন্য existing primitive reuse হবে                                             |

## Plugin বনাম Core classification

### Plugin হিসেবে রাখা উচিত

| Reference group                    | Plugin status                  | Canonical grouping                                                | বর্তমান/প্রস্তাবিত mapping                                                                                                                                                                                    |
| ---------------------------------- | ------------------------------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI Providers                       | **Plugin**                     | `provider`                                                        | Gemini এবং llama.cpp/LFM provider adapter। Provider credentials ও model catalog manifest/config-এর মাধ্যমে প্রকাশিত হবে।                                                                                      |
| Channels                           | **Plugin**                     | `channel`                                                         | Telegram, Discord, WhatsApp, Slack এবং catalog-এ থাকা অন্যান্য channel adapter। Web dashboard নিজে channel plugin নয়; এটি Core UI।                                                                           |
| Optional tools/capability adapters | **Plugin**                     | `capability`                                                      | Browser, Computer Use, Code Execution, MCP, Search, Integrations, Notifications, Model Router, Agent-to-Agent এবং Tools Registry—যেখানে existing descriptor আছে।                                              |
| External storage backends          | **Plugin-capable adapter**     | `capability` বা future `storage-backend`                          | SQLite/core state আলাদা থাকবে; PostgreSQL, Redis, vector database এবং object storage backend optional adapter হিসেবে রাখা যাবে, কিন্তু বর্তমান repository-তে manifest না থাকলে নতুন runtime claim করা হবে না। |
| External observability exporters   | **Plugin-capable adapter**     | `capability` বা future exporter family                            | Core logging/metrics/tracing থাকবে; third-party exporter থাকলে আলাদা plugin হবে।                                                                                                                              |
| GitHub integration                 | **Plugin-capable integration** | `capability`                                                      | Git local operations core tool layer-এর অংশ; GitHub network integration optional plugin হিসেবে model করা হবে।                                                                                                 |
| Installed skills/contracts         | **Plugin**                     | contract kind `skills`, `tools`, `hooks`, `channels`, `providers` | User-installed package independent install/enable/update/remove lifecycle পাবে; metadata-only skill-কে callable skill বলা যাবে না।                                                                            |

### Core infrastructure হিসেবে রাখা উচিত

| Reference group                           | Core status                 | কারণ                                                                                                                                                                           |
| ----------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plugin Management                         | **Core**                    | Discovery, installation, removal, update, versioning, dependency checks, enable/disable এবং approval/safety gate নিজেই control-plane infrastructure।                           |
| Configuration                             | **Core**                    | Plugin configuration data core config service দিয়ে validate/persist হবে; plugin শুধু নিজের schema/requirements প্রকাশ করবে।                                                    |
| Authentication                            | **Core-owned**              | Dashboard/gateway authentication এবং permission boundary request middleware-এর অংশ; current core host-ও `authentication.core` activation বাদ দেয় [3]।                          |
| Memory base layer                         | **Core-owned**              | Conversation memory, durable store, temporal knowledge graph এবং learning persistence agent runtime-এর foundation; optional backend adapter ভবিষ্যতে plugin হতে পারে।          |
| Agents, sub-agents, delegation            | **Core**                    | Agent orchestration, task state, delegation policy এবং run lifecycle runtime-এর মৌলিক অংশ। Agent-to-agent transport adapter optional plugin হতে পারে।                          |
| Automation scheduler/workflow/event queue | **Core**                    | Durable jobs, scheduling, retries, idempotency এবং workflow state core-owned; external trigger/channel adapter plugin হতে পারে।                                                |
| Self-healing                              | **Core**                    | Process supervision, failure detection, restart, recovery এবং health checks 24/7 runtime-এর safety layer।                                                                      |
| Observability base                        | **Core**                    | Internal logs, metrics, tracing, error tracking এবং health reporting core-owned; exporter optional।                                                                            |
| UI                                        | **Core**                    | Dashboard, chat, tool activity, agent status, logs, settings এবং route/layout rendering plugin নয়। Plugin-specific configuration/detail views UI extension হিসেবে থাকতে পারে। |
| File/document formats                     | **Core capability surface** | PDF, DOCX, XLSX, CSV, Markdown এবং OCR আলাদা plugin নয়; এগুলো file/document service-এর supported formats। External processor থাকলে adapter plugin হতে পারে।                   |
| Media processing                          | **Core capability surface** | Image/audio/video processing interface core service; external provider বা model adapter plugin হতে পারে।                                                                       |
| Browser automation actions                | **Core API surface**        | Navigation, page interaction, form filling, screenshot এবং DOM extraction একই browser automation capability-এর operations; আলাদা plugin নয়।                                   |
| Search modes                              | **Core API surface**        | Web, local, semantic এবং code search একই search service-এর modes; provider/backend adapter plugin হতে পারে।                                                                    |
| Notification destinations                 | **Mixed**                   | Notification dispatch interface core; Telegram/Discord/Email destination adapter channel/integration plugin হবে। একই adapter দুই catalog family-তে duplicate করা হবে না।       |

## Canonical architecture decision

Plugin runtime-এর canonical flow হবে:

```text
Manifest/catalog
    -> validation and dependency/policy gate (Core)
    -> registry registration (Core)
    -> descriptor.create(context, config)
    -> lifecycle start/reload/stop (Core)
    -> health/status/audit reporting (Core)
    -> capability-specific runtime work (Plugin)
```

Core-এর দায়িত্ব হলো **orchestration, security policy, configuration storage, lifecycle, persistence, routing, audit এবং UI shell**। Plugin-এর দায়িত্ব হলো **vendor/platform-specific adapter, optional capability implementation অথবা installable user extension**। কোনো plugin-এর `runtimeStatus` manifest থেকে অন্ধভাবে নেওয়া যাবে না; runtime health available থাকলে সেটিই UI-তে effective status হিসেবে অগ্রাধিকার পাবে।

একটি catalog item-এর UI state অন্তত এই ক্ষেত্রগুলোতে প্রকাশ করা হবে: `family`, `id`, `displayName`, `version`, `description`, `runtimeStatus`, `effectiveHealth`, `enabled`, `source`, `permissions`, `requiredConfig`, `platform`, `installability` এবং `coreOwned`। `coreOwned=true` item-এ Install/Remove action দেখানো হবে না।

## Web UI port plan

নতুন Plugin area-তে একটি landing route এবং family/detail navigation থাকবে। Existing page component পুনর্লিখন না করে route-level reuse করা হবে। পুরোনো URL-গুলো redirect বা compatibility wrapper হিসেবে চালু থাকবে।

| Existing page/route               | Plugin section destination    | Port rule                                                                                      |
| --------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `/models`                         | Providers → Models            | Existing model page component reuse; provider catalog/config context যোগ করা হবে।              |
| `/channels` এবং `/channels/$name` | Channels                      | Existing channel list/detail forms unchanged থাকবে; Plugin submenu থেকে canonical links থাকবে। |
| `/agent/skills`                   | Skills                        | Existing import, search, detail, delete এবং readiness workflow reuse হবে।                      |
| `/agent/tools`                    | Tools                         | Existing tool library এবং web search tabs reuse হবে।                                           |
| `/credentials`                    | Providers → Credentials       | Core credential manager হিসেবে থাকবে; Plugin submenu-তে configuration link থাকবে।              |
| `/memory`                         | Core Services → Memory        | এটি installable plugin নয়; plugin page থেকে read-only/core status link থাকবে।                 |
| `/config`                         | Core Services → Configuration | Plugin configuration entry points থাকবে; core config editor আলাদা থাকবে।                       |
| `/agent/automations`              | Core Services → Automation    | Scheduler/workflow core-owned হিসেবে labelled হবে।                                             |
| `/health` এবং `/logs`             | Core Services → Health/Logs   | Observability এবং self-healing status core-owned হিসেবে দেখানো হবে।                            |
| `/agent/hub`                      | Agent Workspace               | Plugin page-এর অংশ নয়; primary navigation-এ থাকবে।                                            |

### Sidebar behavior

Primary left sidebar-এ একটি **Plugin icon** যোগ হবে। Icon-এ click করলে বর্তমান app shell-এর উপরে একটি আলাদা floating secondary sidebar খুলবে। এই sidebar:

1. Existing `Sidebar` primitive-এর `variant="floating"` এবং existing material sidebar visual tokens reuse করবে।
2. Primary sidebar-এর width/layout নষ্ট করবে না এবং content area-কে স্থায়ীভাবে সরাবে না।
3. Outside click, `Escape`, Plugin icon পুনরায় click এবং navigation selection-এ বন্ধ হবে।
4. Desktop-এ floating panel এবং mobile-এ accessible sheet/offcanvas behavior ব্যবহার করবে।
5. Plugin family অনুযায়ী Providers, Channels, Capabilities, Skills এবং Core Services-এর list দেখাবে।
6. Current route অনুযায়ী active item highlight করবে এবং keyboard focus/ARIA label রাখবে।
7. Existing standalone sidebar links duplicate না করে Plugin links-কে grouped secondary navigation হিসেবে দেখাবে।

### Plugin landing page

Landing page-এ প্রথমে catalog summary দেখানো হবে: total plugins, functional, partial, disabled/blocked এবং core-owned count। এরপর family tabs/sections, searchable plugin cards, runtime status badge, required configuration indicator, permissions summary এবং detail action থাকবে। API failure হলে page empty state নয়—স্পষ্ট degraded/error state দেখাবে।

Install, remove, enable/disable, update, probe এবং reload action কেবল existing backend action contract ও safety confirmation path-এর মাধ্যমে করা হবে। Unsupported action-এর জন্য misleading success state দেখানো হবে না।

## Implementation boundaries

Implementation-এ নতুন duplicate backend Plugin registry তৈরি করা হবে না। Existing `listBuiltinPluginManifests()`, capability health, provider/channel metadata এবং marketplace readiness API reuse করে UI read model তৈরি করা হবে। API response envelope unwrap এক জায়গায় typed helper দিয়ে করা হবে, যাতে skills/plugin response shape-এর আগের regression পুনরায় না ঘটে।

Existing page functionality preserve করতে page components সরানো হবে না; route wrappers এবং navigation metadata যোগ করা হবে। Generated route tree, frontend tests এবং formatting/build artifacts repository convention অনুযায়ী update হবে। Secrets, credentials, dashboard password এবং tokens source বা documentation-এ লেখা হবে না।

## Verification plan

| Verification           | Acceptance condition                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Typecheck              | Frontend এবং সংশ্লিষ্ট core package typecheck pass                                                                                                              |
| Lint/format            | Frontend lint এবং formatting check pass                                                                                                                         |
| Unit tests             | Plugin navigation, open/close behavior, active route, API envelope এবং catalog grouping tests pass                                                              |
| Build                  | Clean checkout-এ build এবং verify workflow pass                                                                                                                 |
| Runtime                | Plugin catalog, capabilities, health, providers এবং channels data UI-তে দেখা যায়                                                                               |
| Backward compatibility | Existing routes `/models`, `/channels`, `/agent/skills`, `/agent/tools`, `/credentials`, `/config`, `/memory`, `/agent/automations`, `/health`, `/logs` কাজ করে |
| Visual QA              | Desktop floating sidebar, mobile offcanvas, keyboard Escape/outside click এবং responsive layout browser-এ পরীক্ষা করা                                           |
| Security               | Core-owned item-এ destructive/install controls অনুপস্থিত; permission/status misleading নয়                                                                      |

## References

[1]: https://github.com/glayph/Agent/blob/main/packages/core/src/plugins/sdk/index.ts "Agent Miki Plugin SDK"
[2]: https://github.com/glayph/Agent/blob/main/packages/core/src/plugins/builtin-plugin-catalog.ts "Agent Miki built-in Plugin catalog"
[3]: https://github.com/glayph/Agent/blob/main/packages/core/src/plugins/core-host.ts "Agent Miki core-owned capability boundary"
[4]: https://github.com/glayph/Agent/blob/main/packages/core/src/skill-api.ts "Agent Miki Plugin and Skills API router"
[5]: https://github.com/glayph/Agent/blob/main/packages/ui/frontend/src/app/layout/app-sidebar.tsx "Agent Miki primary application sidebar"
[6]: https://github.com/glayph/Agent/blob/main/packages/ui/frontend/src/shared/ui/sidebar.tsx "Agent Miki sidebar primitive"
