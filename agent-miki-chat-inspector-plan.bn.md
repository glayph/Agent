# Agent Miki Chat Inspector — Implementation Plan

## লক্ষ্য

Agent Miki-এর প্রতিটি assistant message-এর hover action toolbar-এ একটি নতুন **Inspector** tool যোগ করা হবে। Inspector খুললে শুধু সংশ্লিষ্ট chat/session/message-এর execution context দেখাবে—বর্তমান কাজের অবস্থা, planner/executor activity, tool calls, input/output summary, checkpoints, duration, errors এবং completion history। একই realtime inspector উপরের `Active` status কাজ চলাকালে `Working...` হিসেবে দেখাবে এবং সেটিতে click করেও খোলা যাবে।

মূল লক্ষ্য হলো **কমপ্যাক্ট, দ্রুত, per-chat isolated এবং নিরাপদ UI** তৈরি করা; chat transcript বা message action layout ভারী করা নয়।

## বর্তমান codebase-এর integration points

বর্তমান assistant bubble `packages/ui/frontend/src/features/chat/components/assistant-message.tsx`-এ render হয় এবং সেখানে `MessageActionBar` ইতিমধ্যে mounted আছে। `message-action-bar.tsx`-এ copy, retry, fork, delete এবং model-info control-এর কেন্দ্রীয় API রয়েছে; Inspector button-এর প্রধান insertion point এটিই।

বর্তমান realtime execution data monitor subsystem-এ ইতিমধ্যে আছে। `features/monitor/monitor-canvas.tsx`-এর `ActivityInspector` status, duration, started time, planner level, parallel execution, action, input, result, output preview, error এবং run/node metadata দেখায়। `features/monitor/protocol.ts` websocket `node.*` events থেকে `MonitorRun` ও `MonitorNode` state তৈরি করে। `live-activity-strip.tsx` activity chip selection দেখায়, কিন্তু নিজে inspector panel চালায় না।

Chat page `chat-page.tsx` থেকে `ChatMessageList`-এ messages, live activity nodes, selected node এবং activity selection handlers পাঠায়। `workspace-header.tsx` status pills render করে, কিন্তু বর্তমানে status pill passive; `Active` থেকে clickable `Working...` করতে এখানে event contract বাড়াতে হবে।

## প্রস্তাবিত architecture

### ১. Stable inspector domain model

একটি shared frontend contract তৈরি করা হবে, উদাহরণস্বরূপ `features/chat/inspector/types.ts`, যেখানে নিম্নের ধারণাগুলো থাকবে:

- `InspectorScope`: `sessionId`, optional `messageId`, optional `runId` এবং optional `nodeId`।
- `InspectorSnapshot`: status, phase, startedAt, duration, planner level, action summary, tool activity, input/output summary, checkpoint, error এবং last update time।
- `InspectorTarget`: `message`, `session`, বা `working`।
- `InspectorState`: open/closed, selected scope, live snapshot, stale/completed flag এবং panel mode।

প্রতিটি chat session-এর state আলাদা key-তে রাখা হবে। Message scope-এর canonical key হবে `sessionId:messageId`; কেবল message ID দিয়ে state রাখা হবে না, যাতে অন্য session-এর একই বা reused ID-তে collision না হয়।

### ২. Realtime event correlation

বর্তমান monitor event mapping বজায় রেখে run/node metadata-তে `sessionId` এবং `messageId` থাকলে তা preserve করা হবে। যেখানে backend event-এ এগুলো ইতিমধ্যে আছে, সেখানে শুধু frontend mapping করা হবে। না থাকলে planner/job ingress থেকে correlation metadata event envelope বা run-start metadata-তে যোগ করার ছোট compatibility patch করা হবে।

পুরনো event payload-এ metadata না থাকলে UI graceful fallback ব্যবহার করবে: session-level `Working...` inspector দেখাবে, কিন্তু নির্দিষ্ট message scope-এ “message correlation unavailable” state দেখাবে। পুরনো clients বা non-chat monitor events ভাঙবে না।

### ৩. Shared optimized floating panel

বর্তমান `ActivityInspector`-কে সরাসরি duplicate না করে reusable presentation component-এ extract বা adapt করা হবে, উদাহরণস্বরূপ `features/chat/components/chat-inspector-panel.tsx`। এটি ReactFlow বা heavy monitor canvas import করবে না।

Panel-এর layout:

1. Compact header: Inspector icon, `Working...`/`Completed`/`Failed` status, target message বা run title এবং close button।
2. Compact summary row: status, elapsed time, current phase।
3. Scrollable activity timeline: planner, tool call, API/browser/code/file action, verifier, checkpoint এবং delivery event।
4. Expandable detail sections: action, redacted input, result/output preview, checkpoint evidence, error/retry information।
5. Footer metadata: session, message, run এবং last update time।

Panel desktop-এ chat transcript-এর পাশে anchored floating panel হবে; mobile-এ bottom sheet বা full-width compact drawer হবে। Existing design tokens, focus ring, keyboard escape, outside-click behavior এবং reduced-motion preference অনুসরণ করা হবে। Panel 180–250ms-এর মধ্যে open/close হবে এবং transform/opacity ছাড়া layout-heavy animation ব্যবহার করা হবে না।

### ৪. Message hover toolbar integration

`MessageActionBar`-এর props-এ একটি optional Inspector contract যোগ হবে:

- `inspectorLabel`/`inspectorActiveLabel`
- `inspectorOpen?: boolean`
- `onInspect?: () => void`

বিদ্যমান action ordering না ভেঙে Inspector icon model-info-এর পাশে থাকবে। এটি সব assistant message-এ দেখানো হবে যেখানে message ID ও session scope পাওয়া যায়। Thought/tool-call-only block-এও ভবিষ্যতে Inspector দেখানোর জন্য prop path প্রস্তুত থাকবে, তবে প্রথম release-এ normal assistant message এবং correlated tool activity অগ্রাধিকার পাবে।

`assistant-message.tsx` থেকে message ID এবং active session ID action bar-এ scope হিসেবে যাবে। Panel open হওয়ার পরে নতুন event এলে একই scope-এর snapshot update হবে; অন্য message বা session-এর event panel-এ ঢুকবে না।

### ৫. `Active` → `Working...` header behavior

`workspace-header.tsx`-এর status pill API passive text থেকে optional interactive status model-এ উন্নীত হবে। Chat page-এর status projection-এ:

- idle অবস্থায় বর্তমান `Active` status থাকবে।
- active run বা `isTyping` অবস্থায় label হবে `Working...` এবং running indicator থাকবে।
- `Working...` click করলে current session-এর active run বা সর্বশেষ active node scope-সহ Inspector খুলবে।
- কাজ শেষ হলে panel খোলা থাকলে status `Completed`/`Failed` এবং final evidence দেখাবে; panel নিজে থেকে তৎক্ষণাৎ বন্ধ হবে না।
- run event না থাকলে `Working...` panel একটি compact “waiting for execution events” state দেখাবে।

### ৬. State ownership ও performance

Inspector selection/state chat feature-এর একটি scoped Jotai atom বা equivalent store-এ রাখা হবে। এটি global monitor selection-এর সঙ্গে bidirectional bridge রাখবে, কিন্তু monitor canvas-এর ReactFlow state chat UI-তে import করা হবে না।

প্রতি session-এর জন্য event history bounded থাকবে—সর্বশেষ নির্দিষ্ট সংখ্যক activity item এবং size limit রাখা হবে। High-frequency node update event UI-তে throttled/batched হবে। Panel বন্ধ থাকলে অপ্রয়োজনীয় detail rendering হবে না; component lazy-loaded হতে পারে। Chat switch হলে selected inspector scope বন্ধ বা নতুন session-এর matching active scope-এ reset হবে—পুরনো session-এর panel অন্য session-এ প্রদর্শিত হবে না।

## নিরাপত্তা ও প্রকাশ নীতি

Inspector-এ raw secret, API key, cookie, authorization header, private credential, full hidden chain-of-thought বা unredacted sensitive payload দেখানো হবে না। Agent-এর “চিন্তা” বলতে user-visible **reasoning summary**, plan phase, tool intent, execution evidence এবং verifier result দেখানো হবে। Raw internal reasoning থাকলে backend বা UI boundary-তে redaction/summary করা হবে।

Sensitive field redaction-এর জন্য existing security/redaction utility পুনঃব্যবহার করা হবে; নতুন provider বা credential handling Inspector component-এ যোগ করা হবে না। Panel শুধু event evidence read করবে এবং কোনো destructive action চালাবে না। ভবিষ্যতে retry/cancel যোগ করতে হলে তা আলাদা explicit confirmation ও authorization contract-এর মাধ্যমে হবে।

## ধাপে ধাপে বাস্তবায়ন

### Phase A — Contracts ও correlation

Shared inspector types, scope key helper, status enum এবং redaction/display helpers যোগ করা হবে। Monitor protocol/store-এ session/message correlation preserve করা হবে এবং backward-compatible event parsing test করা হবে।

### Phase B — State bridge

Per-session inspector atom/store, open/close/select actions, active message selection এবং monitor node-to-inspector snapshot projection যোগ করা হবে। Chat page এই bridge ব্যবহার করে `ChatMessageList`, `WorkspaceHeader` এবং panel-কে একই state দেবে।

### Phase C — UI integration

`MessageActionBar`-এ Inspector action, `AssistantMessage`-এ scope wiring, optimized floating panel, mobile drawer behavior এবং clickable `Working...` header status বাস্তবায়ন করা হবে। Existing `ActivityInspector`-এর shared visual language ব্যবহার করা হবে, কিন্তু chat-এর জন্য ReactFlow dependency ছাড়া।

### Phase D — Realtime behavior

নতুন node/run/update/complete/error events panel-এ live update হবে। Message-specific scope, session-specific scope, completed run retention, stale event handling এবং run switch behavior যাচাই করা হবে। Live activity strip selection এবং Inspector selection একই target-এর সঙ্গে সামঞ্জস্য করা হবে।

### Phase E — Accessibility, performance ও polish

Keyboard focus, `aria-label`, `aria-expanded`, Escape-to-close, focus return, mobile viewport, reduced motion, long output truncation, copy-safe redaction এবং no-layout-shift behavior যাচাই করা হবে। Hover-only interaction-এর পাশাপাশি keyboard/focus interaction অবশ্যই থাকবে।

## Test plan

### Unit tests

- scope key session ও message ID দিয়ে collision প্রতিরোধ করে।
- একই session-এর দুই message-এর inspector state আলাদা থাকে।
- এক session-এর event অন্য session-এর panel-এ render হয় না।
- node/run event থেকে status, duration, phase, tool, result ও error projection সঠিক হয়।
- পুরনো event metadata অনুপস্থিত থাকলে graceful session-level fallback হয়।
- sensitive keys/headers/token values redaction করে।
- completed/failed run panel খোলা অবস্থায় final snapshot ধরে রাখে।

### Component tests

- hover/focus toolbar-এ Inspector button render হয়।
- Inspector button click করলে correct message scope panel খোলে।
- `Working...` click করলে active session inspector খোলে।
- panel close, Escape, outside click এবং focus return কাজ করে।
- mobile drawer ও desktop floating layout render হয়।
- `prefers-reduced-motion` থাকলে non-essential animation বন্ধ থাকে।

### Integration/E2E tests

- একটি session-এ কাজ শুরু করে Inspector open করলে live node update দেখা যায়।
- চলমান কাজের সময় নতুন user message এলে Miki-এর reply state এবং Inspector scope আলাদা থাকে।
- কাজ শেষ হলে `Working...` থেকে completed state এবং final evidence দেখা যায়।
- দ্বিতীয় chat session খুললে প্রথম chat-এর inspector data leakage হয় না।
- provider error, tool failure ও retry event panel-এ redacted error state হিসেবে আসে।
- existing copy, retry, fork, delete, model-info এবং chat composer behavior unchanged থাকে।

### Build/regression

Frontend TypeScript build, existing chat/monitor regression suites এবং focused inspector tests চালানো হবে। তারপর isolated Web UI runtime-এ visual verification করা হবে।

## Acceptance criteria

| ক্ষেত্র | গ্রহণযোগ্য ফলাফল |
|---|---|
| Toolbar | প্রতিটি উপযুক্ত assistant message-এর hover/focus toolbar-এ Inspector icon আছে |
| Per-chat isolation | message/session বদলালে অন্য chat-এর activity দেখা যায় না |
| Working status | active execution-এ header `Working...` দেখায় এবং clickable থাকে |
| Realtime | নতুন run/node/tool/checkpoint event panel-এ দ্রুত দেখা যায় |
| Completed work | কাজ শেষ হলেও final evidence panel-এ থাকে |
| UX | panel compact, responsive, keyboard-accessible এবং transcript ঢেকে না ফেলে |
| Safety | secret, credential ও raw hidden chain-of-thought প্রকাশ পায় না |
| Compatibility | existing chat actions, monitor page, provider subsystem ও other packages ভাঙে না |
| Performance | heavy ReactFlow canvas chat panel-এ import হয় না; event history bounded থাকে |

## Assumptions ও open risks

1. বর্তমান monitor websocket event stream-ই realtime source of truth হিসেবে ব্যবহৃত হবে; নতুন external service বা database দরকার হবে না।
2. যদি backend event-এ message/session correlation না থাকে, event envelope বা run-start metadata-তে backward-compatible correlation field যোগ করতে হবে।
3. Per-chat inspector state প্রথম release-এ client-session scoped থাকবে; page refresh-এর পর সম্পূর্ণ historical inspector replay দরকার হলে আলাদা persistent audit query লাগবে।
4. User-visible reasoning summary এবং internal hidden reasoning আলাদা রাখা হবে; raw chain-of-thought inspect করার feature এই plan-এর অংশ নয়।
5. Existing runtime-এর auth, provider credentials এবং 24/7 supervisor behavior অপরিবর্তিত থাকবে; Inspector read-only observability feature হিসেবে implement হবে।
6. UI implementation-এর আগে final visual target হিসেবে বর্তমান assistant toolbar এবং monitor inspector style ব্যবহার করা হবে; নতুন large dashboard বা ReactFlow canvas chat transcript-এর মধ্যে আনা হবে না।

## Deliverables

- Isolated inspector state/types ও monitor correlation patch
- Message hover toolbar-এর Inspector action
- Optimized floating Inspector panel এবং mobile drawer
- Clickable `Working...` header status
- Redaction, accessibility ও performance safeguards
- Focused unit/component/integration tests
- Updated documentation এবং visual verification screenshot

## Revised requirement: Multi-page floating Inspector without reload

Inspector এখন একটি single-card panel নয়; এটি একটি **multi-page floating workspace** হবে। Floating shell একবার mount হওয়ার পরে ভিতরের page/tab পরিবর্তনে পুরো chat UI, SPA shell বা browser page refresh হবে না। Inspector state session-scoped থাকবে এবং panel বন্ধ/খোলার পরেও সর্বশেষ selected page ও scroll position বজায় থাকবে।

### Inspector pages

Inspector-এর floating workspace-এ নিম্নের client-side pages থাকবে:

1. **Overview** — বর্তমান status, `Working...`/completed/failed state, elapsed time, current phase, run/message/session identity এবং compact summary।
2. **Thought / Plan** — raw hidden chain-of-thought নয়; নিরাপদ user-visible thought summary, classification, plan steps, authorization decision, current step এবং next step।
3. **Work / Tools** — planner, executor, browser, code, file, API এবং channel tool calls-এর chronological timeline; প্রতিটি item-এর status, duration, input summary, output summary, retry এবং error।
4. **Artifacts** — কাজের সময় তৈরি/পরিবর্তিত file, screenshot, image, URL, code diff, API response summary এবং downloadable evidence। Artifact preview lazy-load হবে; secret ও credential redacted থাকবে।
5. **Evidence / Checkpoints** — verifier evidence, assertions, checkpoint pointer, delivery receipt, audit reference এবং final result।
6. **Events** — bounded realtime event stream, যাতে timestamp, event type, source, status এবং correlation ID দেখা যায়।

Page labels, icon, active state এবং unread/live update indicator accessible tab semantics অনুসরণ করবে। Mobile-এ এগুলো horizontally scrollable compact tabs বা segmented navigation হবে; desktop-এ floating panel header-এর নিচে tab row থাকবে।

### No-reload navigation contract

- Floating Inspector একটি React portal/overlay shell হিসেবে mount হবে; page changes `window.location`, hard navigation বা full reload ব্যবহার করবে না।
- Inspector navigation client-side state/route state দ্বারা চালিত হবে, যেমন `inspectorPageAtom` scoped by `sessionId`, `messageId` এবং `runId`। Browser back/forward দরকার হলে shallow URL state বা hash ব্যবহার করা যাবে, কিন্তু document reload করা যাবে না।
- Panel-এর data cache এবং event subscription shell-level-এ থাকবে; tab বদলালে websocket subscription পুনরায় তৈরি হবে না।
- Existing monitor protocol থেকে event একবার ingest হয়ে normalized inspector store-এ যাবে। Overview, Thought, Work, Artifacts, Evidence এবং Events pages একই snapshot/cache থেকে selector ব্যবহার করবে।
- Heavy artifact preview, diff viewer এবং event details `React.lazy`/dynamic import দিয়ে on-demand load হবে; মূল chat transcript ও composer পুনরায় render বা reload হবে না।
- Session switch হলে আগের Inspector scope unsubscribe হবে এবং নতুন session-এর scope select হবে; পুরনো session-এর cached snapshot অন্য chat-এ leak করবে না।
- Realtime updates batched/throttled হবে এবং bounded event/artifact history ব্যবহার করবে, যাতে long-running Agent job-এ memory বা render cost অনিয়ন্ত্রিত না হয়।

### Thought, work এবং artifact data contract

Backend বা monitor event-এ পাওয়া raw internal reasoning সরাসরি UI-তে পাঠানো হবে না। Planner/executor/verifier থেকে sanitized summary fields ব্যবহার করা হবে: `intentSummary`, `planStep`, `decisionSummary`, `actionSummary`, `nextStep`, `verificationSummary`। এটি Agent-এর কাজ বোঝার জন্য যথেষ্ট হবে, কিন্তু গোপন chain-of-thought প্রকাশ করবে না।

Work items-এ tool name, category, status, start/end time, duration, redacted input summary, redacted output summary, attempt, error এবং correlation ID থাকবে। Artifacts-এ artifact ID, type, name, source step, created/updated time, preview metadata, safe preview URL এবং download capability থাকবে। API keys, cookies, authorization headers, local secrets, private tokens এবং unsafe raw payload অবশ্যই redacted থাকবে।

### Revised acceptance criteria

| ক্ষেত্র | গ্রহণযোগ্য ফলাফল |
|---|---|
| Multi-page Inspector | Overview, Thought/Plan, Work/Tools, Artifacts, Evidence/Checkpoints ও Events আলাদা client-side pages/tab হিসেবে কাজ করে |
| Thought visibility | raw hidden chain-of-thought নয়; sanitized thought/plan summary দেখা যায় |
| Work visibility | চলমান ও সম্পন্ন tool/action-এর status, timing, input/output summary এবং error দেখা যায় |
| Artifacts | file, screenshot, URL, diff ও evidence safe preview/metadata হিসেবে দেখা যায় |
| No reload | Inspector page/tab পরিবর্তন, live update বা close/open-এ browser/document/full chat UI refresh হয় না |
| State continuity | tab বদলালে selected scope, live subscription, scroll position এবং cached data অযথা হারায় না |
| Per-chat isolation | প্রতিটি session/message-এর inspector data পৃথক থাকে; অন্য chat-এ leakage হয় না |
| Live updates | Working অবস্থায় সব page একই realtime normalized snapshot থেকে update হয় |
| Performance | shell persistent, data bounded, heavy views lazy-loaded এবং high-frequency events throttled |
| Safety | secret, credential, raw hidden chain-of-thought ও unsafe payload প্রকাশ পায় না |

### Additional tests

- Inspector tab/page বদলালে `beforeunload`, full navigation বা websocket reconnect ঘটে না।
- Overview থেকে Work, Artifacts, Evidence এবং Events-এ গিয়ে আবার Overview-তে ফিরলে একই session/message/run scope অক্ষুণ্ণ থাকে।
- Live `node.update` event tab বর্তমানে খোলা না থাকলেও cache update করে; tab খুললে সর্বশেষ state দেখা যায়।
- Artifact preview lazy-load failure হলে chat UI নষ্ট না হয়ে retryable inline error দেখায়।
- একসঙ্গে একাধিক chat session-এর Inspector খোলা/বন্ধ করলে event এবং artifacts cross-contaminate হয় না।
- Long-running run-এ bounded event history, render batching এবং memory limit বজায় থাকে।
- Browser refresh ইচ্ছাকৃতভাবে হলে session restore policy অনুযায়ী scope পুনরুদ্ধার হয়, কিন্তু সাধারণ Inspector navigation-এ refresh হয় না।
- Keyboard tab navigation, screen-reader labels, Escape close, focus return এবং mobile tab overflow কাজ করে।

এই revision অনুযায়ী মূল implementation order হবে: normalized inspector snapshot ও correlation → persistent per-session state → persistent floating shell → client-side multi-page navigation → thought/work/artifact/evidence views → no-reload performance validation।
