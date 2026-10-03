# Miki Subsystem Audit Report

**পর্যালোচিত অংশ:** Route, Gateway, Tool Call, System Workflow, Autonomous Mode, Skills Use, Memory  
**রিভিউ পদ্ধতি:** source inspection, focused tests, runtime probes, এবং cross-area synthesis  
**সামগ্রিক ফল:** কোনো Critical finding পাওয়া যায়নি; তবে একাধিক High-severity নিরাপত্তা ও reliability defect নিশ্চিত হয়েছে।

## Executive summary

Miki-র সবচেয়ে জরুরি ঝুঁকিগুলো হলো:

1. **Plugin/skill sandbox বাস্তবে enforced নয়** — permission flags থাকলেও plugin স্বাভাবিক Node/Python process হিসেবে চলে।
2. **Memory scope isolation অসম্পূর্ণ** — scoped selective memory-এর পাশাপাশি legacy TKG ও NodeGraph unscoped data ফেরত দেয়; cross-agent/owner/workspace disclosure হতে পারে।
3. **Tool timeout/cancellation কাজ থামায় না** — caller timeout পেলেও handler side effect চালিয়ে যেতে পারে এবং lock আগেই release হয়।
4. **Direct ToolRegistry dispatch পূর্ণ schema validation করে না** — `dryRun: "true"`-এর মতো type-confused input বাস্তব deletion ঘটাতে পারে।
5. **Autonomous turbo mode approval bypass করে** — auto-escalation-এর পর destructive ও browser side effect human approval ছাড়াই চলতে পারে।
6. **Queue/workflow/cron failure ভুলভাবে success হিসেবে report হয়** — lost work, duplicate work এবং stale state overwrite সম্ভব।
7. **Gateway auth/readiness defense-in-depth দুর্বল** — invalid WebSocket credential handshake গ্রহণ, core unhealthy হলেও HTTP 200, এবং credentialed wildcard CORS-এর পথ আছে।

---

## 1. Route

### Medium — Direct route-preview endpoint authentication bypass

- **Evidence:** `packages/core/src/api/index.ts:2987-3037`-এ `POST /agent/route-preview`-এ `requireHttpAuth` নেই। Routeটি routing, skill metadata ও tool definitions ব্যবহার/ফেরত দেয়। একই নামের authenticated compatibility route আলাদা।
- **Impact:** Core listener reachable হলে API key বা dashboard session ছাড়াই internal capability metadata পড়া এবং arbitrary message routing করা সম্ভব। Public-core deployment-এ এটি বাস্তব remote auth bypass হতে পারে।
- **Fix:** Direct route-এ `requireHttpAuth` যোগ করুন অথবা duplicate route সরিয়ে authenticated `/api/agent/route-preview` রাখুন। Direct ও proxied path-এর unauthenticated regression test দিন।

### Medium — Frontend auth guard fail-open

- **Evidence:** `packages/ui/frontend/src/routes/__root.tsx:82-94` auth-status request-এর 401/403 ছাড়া অন্য failure-কে `degraded` করে; `:125-180` এই state-এও full `AppLayout`, route outlet এবং chat initialization চালায়।
- **Impact:** Auth service/network failure-এ unauthenticated user protected UI shell বা cached client state দেখতে পারে। Backend API পরে 401 দিলেও misleading partial dashboard তৈরি হয়।
- **Fix:** Initial auth check fail-closed করুন; retry বা minimal error/offline view দেখান, full app initialize করবেন না।

### Low — Unknown browser paths HTTP 200 দেয়

- **Evidence:** `packages/gateway/src/index.ts:785-791` unknown HTML GET-এ SPA index status 200 দেয়। Live `/does-not-exist` probe-এ dashboard HTML 200 পাওয়া গেছে।
- **Impact:** Dead link, crawler ও monitoring real route বনাম nonexistent path আলাদা করতে পারে না।
- **Fix:** Explicit not-found route দিন এবং known SPA route বনাম unknown path-এর server status policy নির্ধারণ করুন।

---

## 2. Gateway

### High — Invalid credential-এ WebSocket handshake accept

- **Evidence:** `packages/gateway/src/index.ts:803-833` কেবল cookie, `Authorization` বা `X-API-Key` উপস্থিত কি না দেখে upgrade গ্রহণ করে; প্রকৃত validation পরে core-এ হয়। Live probe-এ bad API key/Bearer/cookie gateway-তে `OPEN`, direct core-এ `401`।
- **Impact:** Unauthenticated client relay, connection ও rate-limit resources ব্যবহার করতে পারে; upstream validation বদলালে boundary bypass-এর সম্ভাবনা থাকে।
- **Fix:** Gateway-তেই synchronous credential validation করুন; invalid credential-এ handshake-এর আগেই HTTP 401 দিন।

### Medium — `bypass_restrictions` credentialed wildcard CORS চালু করে

- **Evidence:** `packages/config/src/security.ts:175-191` `bypass_restrictions: true` হলে allowed origins `[*]` করে; gateway `Access-Control-Allow-Credentials: true` সহ arbitrary Origin reflect করতে পারে।
- **Impact:** যেকোনো website dashboard session cookie ব্যবহার করে credentialed request করতে পারে।
- **Fix:** Bypass flag থেকে CORS policy আলাদা করুন। Explicit origins ব্যবহার করুন এবং credentials থাকলে wildcard reject করুন।

### Medium — Core unhealthy হলেও health endpoint 200/status ok

- **Evidence:** `packages/gateway/src/index.ts:680-687` `coreHealthy` false হলেও HTTP 200 ও `{status:"ok"}` পাঠায়।
- **Impact:** Load balancer/supervisor unavailable core-কে ready ধরে traffic পাঠাতে পারে।
- **Fix:** আলাদা liveness/readiness endpoint দিন অথবা core unhealthy হলে readiness-এ 503/degraded ফেরত দিন।

### Low — Gateway integration tests wired নয়

- **Evidence:** `packages/gateway/package.json`-এ test script নেই; Vitest/Jest globals মিশ্র। Focused Vitest suite পাস করলেও actual server lifecycle, proxy, auth, CORS ও WS upgrade cover হয় না।
- **Fix:** Package-level test config/script standardize করে CI-তে gateway integration test যুক্ত করুন।

---

## 3. Tool call

### High — Timeout/cancellation live handler থামায় না; lock আগেই release হয়

- **Evidence:** `packages/core/src/tools/registry/executor.ts:128-162` timeout wrapper handler-এ AbortSignal পাঠায় না এবং underlying operation cancel করে না। `packages/core/src/agent.ts:4529-4565` wrapper ফেরার পর lock release করে। Manual reproduction-এ timeout report হওয়ার পরও delayed handler side effect চালিয়েছে। একই সমস্যা retry path-এ `packages/core/src/tools/retry-manager.ts:166-188`।
- **Impact:** Caller operation থেমেছে ভাবলেও file/browser/plugin/shell side effect চলতে পারে; subsequent invocation overlap করে duplicate বা corrupt state তৈরি করতে পারে।
- **Fix:** সব cancellable handler-এ AbortSignal propagate করুন; child/browser/plugin process terminate করুন; work settle না হওয়া পর্যন্ত lock release করবেন না।

### High — Direct dispatch পূর্ণ JSON schema validation করে না

- **Evidence:** `packages/core/src/tools/registry/executor.ts:592-627` শুধু required value পরীক্ষা করে। `file_delete`-এর `dryRun` boolean হলেও `dryRun: "true"` literal `true` না হওয়ায় delete চালায়। Actual ToolRegistry reproduction-এ target file মুছে গেছে।
- **Impact:** Type-confused input schema-র বিপরীত dangerous operation করতে পারে।
- **Fix:** ToolRegistry-তে authoritative JSON-Schema/Ajv/Zod validation দিন: primitive/object type, enum, nested items, bounds, unknown-key policy ও non-object rejectionসহ। HTTP ও MCP একই validator ব্যবহার করুক।

### Medium — Browser/computer stateful tools shared lock পায় না

- **Evidence:** `packages/core/src/tool-call-parallelism.ts:283-319`-এ কিছু browser tool shared browser lock-এর বাইরে; computer tools-এর shared desktop lock নেই। Manual plan-এ browser navigation/invoke ও computer click/set-text একই level-এ চলেছে।
- **Impact:** একই page/session বা desktop state race করে wrong-target action বা nondeterministic ফল দিতে পারে।
- **Fix:** সব stateful browser operation-এ shared exclusive browser lock এবং সব computer-use operation-এ shared desktop lock দিন।

### Medium — File lock raw path string ব্যবহার করে

- **Evidence:** `tool-call-parallelism.ts:121-133` raw `a.txt` ও `./a.txt` আলাদা lock বানায়, কিন্তু executor একই target resolve করে।
- **Impact:** path alias, dot segment, symlink বা case variant দিয়ে serialization bypass হয়।
- **Fix:** FileSecurityExecutor-এর workspace resolution/realpath অনুসরণ করে canonical lock key তৈরি করুন।

### Medium — Invalid MCP concurrency value-এ সব request hang করতে পারে

- **Evidence:** `packages/core/src/mcp/server.ts:21-32` `MAX_CONCURRENT_TOOLS` finite/positive যাচাই ছাড়াই parse করে; 0, negative বা NaN হলে semaphore queue কখনো শুরু হয় না।
- **Fix:** Startup-এ finite integer clamp/default করুন, warning দিন এবং queue timeout/cancellation যোগ করুন।

---

## 4. System workflow

### High — CommandQueue executor failure-কে completed করে

- **Evidence:** `packages/core/src/command-queue/command-queue.ts:474-514` executor exception catch করে abort না হলে `completed` সেট করে; runtime reproduction-এ `Error boom`-এর পর completed পাওয়া গেছে।
- **Impact:** Tool/provider failure সফল হিসেবে acknowledged হয়; retry, alert ও dead-letter অসম্ভব হয়।
- **Fix:** সত্যিকারের success না হলে normalized error-সহ `failed` state/event দিন।

### High — Forced interrupt session serialization ভাঙে

- **Evidence:** `command-queue.ts:189-212` abort cleanup-এর জন্য ২ সেকেন্ড অপেক্ষা করে; uncooperative executor চলতে থাকলেও `finishRun` lane slot release করে।
- **Impact:** পুরনো executor ও replacement একই session-এ overlap করে।
- **Fix:** Executor settle না হওয়া পর্যন্ত slot রাখুন; না হলে worker isolate/terminate বা session poison করুন।

### High — CronScheduler queue rejection উপেক্ষা করে

- **Evidence:** `packages/core/src/cron/service.ts:210-251` `EnqueueResult.accepted` discard করে, job ok/runCount increment করে এবং one-shot delete/recurrence advance করে। Runtime proof-এ queue full হলেও job success হয়েছে।
- **Fix:** `accepted` পরীক্ষা করুন; rejection-এ retry/error state রাখুন এবং সফল enqueue না হলে delete/advance করবেন না।

### High — Workflow lease loss stale writer-কে আটকায় না

- **Evidence:** `packages/core/src/workflow-engine.ts:377-387` renewal false হলেও execution/checkpoint চলতে থাকে; state save owner/lease predicate ছাড়া update করে।
- **Impact:** নতুন worker-এর state পুরনো worker overwrite করতে পারে; duplicate side effect ও resume corruption হয়।
- **Fix:** Owner+lease conditional writes করুন এবং renewal failure-এ execution stop করুন।

### Medium — Timed-out AgentMessageBus listener leak

- **Evidence:** `packages/core/src/agent-message-bus.ts:157-179` timeout-এ reply handler remove হয় না; runtime-এ তিন timeout-এর পর তিন stale listener retained হয়েছে।
- **Fix:** Success ও timeout উভয় path-এ idempotent cleanup দিন।

### Medium — PersistentJobQueue exact lease-owner match বাধ্যতামূলক নয়

- **Evidence:** `packages/core/src/persistent-job-queue.ts:342-344` workerId বা leaseOwner absent হলে ownership true ধরে।
- **Impact:** Running job ভুল worker complete/fail/checkpoint করতে পারে।
- **Fix:** Multi-worker mode-এ exact owner match বাধ্যতামূলক করুন।

---

## 5. Autonomous mode / 24-7

### High — Turbo mode destructive/browser approval bypass করে

- **Evidence:** `config/agent.yaml:109-112` confirmation চাইলেও `:165-169` auto standard→turbo escalation চালু করে। `destructive-gate.ts:186-203` ও `isolated-browser-worker.ts:150-173` turbo-তে gate skip করে।
- **Impact:** Unattended run owner approval ছাড়াই deletion, destructive write, computer control ও browser side effect করতে পারে।
- **Fix:** Autonomy mode কখনো approval bypass করবে না; per-tool/resource allowlist ও authenticated operator policy ব্যবহার করুন।

### High — Blocked objective আবার resumable

- **Evidence:** `autonomous-goal-manager.ts:133-153` max replans ছাড়লে blocked করে, কিন্তু `objective-store.ts:74-83` blocked-কে unfinished ধরে; `goal-catalog.ts:129-155` পরে আবার select করে এবং in_progress করে।
- **Fix:** blocked/aborted/failed/completed objective বাদ দিন; operator-only retry transition রাখুন।

### High — Restart recovery active objective restore করে না

- **Evidence:** `currentObjectiveId` null থাকে; persisted scheduled task থাকলেও `_resumeUnfinishedOnBoot()` তা controller state-এ বসায় না।
- **Impact:** Recovered task চলাকালীন নতুন objective dispatch হয়ে duplicate work হয়।
- **Fix:** Boot-এ current objective/task restore বা reconcile করুন এবং one-active-objective invariant enforce করুন।

### High — Supervisor restart-spawn failure-এ permanently unmanaged হতে পারে

- **Evidence:** `scripts/miki-24-7.mjs:236-275` spawn error কেবল log করে; child না থাকলেও process alive থাকে এবং heartbeat বন্ধ হয়।
- **Fix:** Spawn failure bounded retry/failure state machine-এ আনুন; retry budget শেষ হলে nonzero exit/watchdog দিন।

### Medium — Pause/disable in-flight task interrupt করে না

- **Evidence:** `AutonomyController.setEnabled()` ও `pause()` শুধু boolean flip করে; active task cancellation request পাঠায় না।
- **Fix:** Pause/disable/shutdown-এ current task cancel/pause করুন এবং operator-paused state persist করুন।

### Medium — Installer standalone 24/7 supervisor চালায় না

- **Evidence:** `package.json:37` standalone supervisor চালালেও `deploy/linux/systemd/agent-miki.service.in:23` সরাসরি `bin/miki.js` চালায়। Running process tree-তে `miki-24-7` ছিল না।
- **Fix:** একটি authoritative deployment path বাছুন এবং installation smoke test-এ process chain/state artifact যাচাই করুন।

### Medium — Autonomy configuration toggles enforce হয় না

- **Evidence:** planning/research/project-maintenance toggles ও turbo parallel knobs থাকলেও candidate selection-এ সেগুলো প্রয়োগ হয় না; controller একটিমাত্র objective চালায়।
- **Fix:** Candidate selection-এ toggles প্রয়োগ করুন এবং advertised parallelism implement করুন বা unsupported knobs সরান।

---

## 6. Skills use

### High — Plugin sandbox advisory, enforced নয়

- **Evidence:** `packages/core/src/plugins/plugin-contract-runtime.ts:695-778` কেবল environment flags সেট করে; OS sandbox, namespace, seccomp, container বা network/filesystem interception নেই। Payload `:990-994` নিজেই `policy_sandbox:true` এবং `enforced_sandbox:false` বলে।
- **Impact:** Installed skill arbitrary file/network/subprocess access করতে পারে।
- **Fix:** Restricted user/container/VM/OS sandbox ব্যবহার করুন এবং child-এর বাইরে policy enforce করুন।

### Medium — Skill install transactional নয়

- **Evidence:** `packages/installer/src/installer/skill-installer.ts:173-225` registry persistence-এর আগে entrypoint/assets replace করে; failure-এ rollback নেই।
- **Impact:** Partial/orphaned files ও registry mismatch তৈরি হয়।
- **Fix:** Temporary staging, validation ও atomic swap ব্যবহার করুন; failure-injection rollback test দিন।

### Medium — Registry metadata arbitrary HTTPS download redirect করতে পারে

- **Evidence:** `packages/installer/src/source-dispatch.ts:303-320` non-empty `downloadUrl` সরাসরি download করে; registry-origin allowlist/signature/checksum binding নেই।
- **Impact:** Compromised registry SSRF/probing বা attacker-controlled archive install করাতে পারে।
- **Fix:** Registry-origin/allowlist, private-IP rejection, signed metadata ও checksum verification দিন।

### Low — Persisted registry path containment যাচাই করে না

- **Evidence:** `packages/installer/src/registry/skill-registry.ts:75-102` path/entrypoint/assetsPath-এর existence, realpath containment ও relative path যাচাই করে না।
- **Fix:** Canonical realpath/root containment, existence ও extension validation দিন; invalid record quarantine করুন।

---

## 7. Memory

### High — Legacy TKG ও NodeGraph retrieval scope-isolated নয়

- **Evidence:** `packages/memory/src/temporal-knowledge-graph.js:98-198` global tables-এ scope columns নেই। `getRecentEvents/getEventsByCategory/getSpecialEvents` এবং `node-graph.js:203-247` unqualified global queries চালায়।
- **Impact:** অন্য agent/owner/workspace-এর private events, entities, history ও graph context prompt-এ ঢুকে যেতে পারে।
- **Fix:** সব table, edge traversal, consolidation ও stats query-তে mandatory scope দিন এবং integration hook-এ scope propagate করুন; বিকল্পভাবে isolation boundary-প্রতি আলাদা DB ব্যবহার করুন।

### Medium — Scope key delimiter collision

- **Evidence:** `graph-cognitive-memory.js:216-225` ও `selective-memory-engine.js:136-142` IDs সরাসরি `:` দিয়ে join করে।
- **Impact:** ভিন্ন principal একই scope key পেয়ে data merge করতে পারে।
- **Fix:** Length-prefixed বা JSON-hashed tuple ব্যবহার করুন; identity validation ও migration দিন।

### Medium — `memory_get` symlink দিয়ে root escape করতে পারে

- **Evidence:** `packages/core/src/memory-files/paths.ts:65-75` lexical path ও `.md` suffix দেখে; `search.ts:176-193` realpath/symlink rejection ছাড়া পড়ে।
- **Impact:** Memory root-এর symlink দিয়ে arbitrary readable Markdown disclosure সম্ভব।
- **Fix:** Root ও target realpath validate করুন এবং symlink components/final file reject করুন।

### Medium — Sync shutdown asynchronous memory task durable ধরে

- **Evidence:** `packages/core/src/memory-files/writer.ts:7-10,106-117,190-196` Promise-returning job await করে না, কিন্তু processed গণনা করে।
- **Impact:** Shutdown কাজ শেষ হওয়ার আগে ফেরে বা process exit হয়।
- **Fix:** Sync path-এ Promise job নিষিদ্ধ করুন অথবা explicit async drain-এ await করুন।

### Medium — Full summary queue sweep retry চিরতরে বন্ধ করতে পারে

- **Evidence:** `memory-files/service.ts:231-235` enqueue-এর আগে swept mark করে; writer queue full হলে `enqueue` false করে।
- **Impact:** Summary queued না হলেও পরবর্তী sweep skip হয়; permanent summary loss হতে পারে।
- **Fix:** Successful enqueue-এর পরে swept mark করুন অথবা retryable failure/backoff রাখুন।

### Medium — Data directory বদলালে পুরনো TKG/daemon leak হয়

- **Evidence:** `packages/core/src/memory/runtime.ts:41-97` different path-এ পুরনো daemon/connection stop/close না করে singleton overwrite করে।
- **Fix:** Replace-এর আগে daemon stop ও TKG close করুন; path change atomic করুন বা active instance থাকলে reject করুন।

---

## Cross-cutting risks

- **Side-effect containment দুর্বল:** Tool timeout, retry timeout, forced interrupt এবং autonomy pause—সবক্ষেত্রে caller stop ভাবলেও underlying work চলতে পারে।
- **Authorization defense-in-depth অসম্পূর্ণ:** Direct core route, WebSocket pre-auth, degraded frontend auth এবং wildcard CORS deployment misconfiguration-কে exposure-এ পরিণত করতে পারে।
- **State/ownership fencing দুর্বল:** Queue, cron, workflow lease, persistent job ও restart recovery-তে accepted/completed/owner state যথেষ্ট authoritative নয়।
- **Tenant/data isolation ঝুঁকিপূর্ণ:** Memory scope-less tables, delimiter-colliding keys ও symlink-escapable reads private context প্রকাশ করতে পারে।
- **Configuration বনাম enforcement gap:** Turbo approvals, autonomy toggles, plugin sandbox ও 24/7 supervisor docs-এর behavior runtime-এ পুরোপুরি enforce হয় না।
- **Observability/test coverage ঘাটতি:** Failure success হিসেবে report, misleading health status এবং gateway integration test না থাকা detection বিলম্বিত করে।

## Prioritized fix plan

### P0 — Safety ও ownership

1. Plugin/skill restricted OS isolation-এ চালান।
2. Turbo বা auto-escalation কখনো destructive/browser approval bypass না করুক।
3. Tool/retry/queue/autonomy cancellation-এ বাস্তব AbortSignal ও process termination দিন।
4. Work settle না হওয়া পর্যন্ত lock/session slot release করবেন না।
5. Workflow ও persistent job state-এ owner+lease conditional write/match বাধ্যতামূলক করুন।
6. CommandQueue/cron failure-এ failed/retry/dead-letter semantics দিন; false success বন্ধ করুন।

### P1 — Auth, input ও memory isolation

1. ToolRegistry-তে single authoritative JSON-Schema validation দিন।
2. Direct `/agent/route-preview` auth করুন।
3. Gateway WS-তে synchronous credential validation এবং restrictive CORS দিন।
4. Frontend auth initial check fail-closed করুন।
5. TKG/NodeGraph-এ mandatory scope ও সব query predicate যোগ করুন।
6. Memory file realpath/symlink guard এবং collision-free scope key migration দিন।
7. Blocked autonomy objective terminal করুন এবং boot recovery ঠিক করুন।

### P2 — Reliability, supply chain ও operations

1. Browser/computer/file canonical shared locks এবং MCP env validation দিন।
2. Skill install atomic staging/rollback এবং signed source/checksum verification দিন।
3. Registry path containment/existence validation দিন।
4. Memory async drain/sweep retry/init cleanup ঠিক করুন।
5. Liveness/readiness আলাদা করুন এবং gateway integration test CI-তে wire করুন।
6. একটিমাত্র authoritative 24/7 deployment path নির্ধারণ করুন।

## Verification limitations

- Authenticated protected endpoints-এ API key/session ছাড়া mutation test করা হয়নি।
- `better-sqlite3` native binding/Node ABI সমস্যায় Memory runtime isolation এবং কিছু autonomy/workflow SQLite test blocked হয়েছে।
- Shared sandbox disrupt না করতে core-down, gateway restart failure, active WS shutdown বা public-core destructive probe চালানো হয়নি।
- Computer-use runtime ও full adversarial plugin escape test চালানো হয়নি।
- Multi-process stress, filesystem race, cron persistence race এবং alternate systemd reboot test করা হয়নি।

## Verified runtime/source examples

- `dryRun: "true"` দিয়ে `file_delete` বাস্তব file deletion করেছে।
- Tool timeout report হওয়ার পর delayed handler side effect চালিয়েছে।
- Queue rejection-এর পর CronScheduler false success report করেছে।
- Timed-out AgentMessageBus requests stale listener রেখে গেছে।
- Invalid WS credential gateway handshake-এ `OPEN`, direct core-এ `401` হয়েছে।
- `/does-not-exist` gateway dashboard HTML হিসেবে HTTP 200 দিয়েছে।
- Running process tree-তে standalone `miki-24-7` supervisor ছিল না।

