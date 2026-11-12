# Miki — Remaining Tasks Implementation Report

তারিখ: 2026-11-12

## সারসংক্ষেপ

এই source ZIP-এ নির্দেশনার অনেকগুলো বড় implementation আগেই উপস্থিত ছিল। সেগুলো পুনরায় লেখা হয়নি। এই pass-এ চারটি ছোট test-hardening পরিবর্তন যোগ করা হয়েছে; production behavior অকারণে বদলানো হয়নি। পূর্ণ Jest/Vitest suite, typecheck বা live E2E চালানো যায়নি, কারণ workspace-এর dependency install অসম্পূর্ণ এবং npm registry-তে DNS resolution ব্যর্থ হয়েছে। নিচের verification অংশে সীমাবদ্ধতা বিস্তারিত আছে।

## ১. Delivery acknowledgement ও discovery state

আগে থেকেই বাস্তবায়িত:

- `packages/gateway/src/index.ts`: `broadcastProactive()` chat history-তে message persist করে, `proactive_dashboard_outbox`-এ idempotent row লেখে, dashboard socket delivery result নেয় এবং `sendProactiveNoticeWithResult()` থেকে channel recipient counts সংগ্রহ করে। Return object-এ মোট `delivered`, dashboard-এর `attempted/delivered/failed`, channel-এর `attempted/delivered/queued/failed`, মোট queued count ও failure detail থাকে।
- `sendDashboardNotice()` WebSocket send callback-এর ফল গণনা করে। কোনো dashboard client না থাকলে durable row pending থাকে; সব socket failure হলেও pending-এ ফেরে। প্রথম সফল socket acknowledgement হলে row `sent` হয় এবং attempted/delivered/failed count ফেরত দেয়।
- Dashboard connection ও authentication-এর পর `flushPendingProactiveDashboardNotices()` চালু হয়।
- `packages/gateway/src/channels/channel-runtime.ts`: পুরোনো `sendProactiveNotice(text): Promise<void>` API অপরিবর্তিত; নতুন `sendProactiveNoticeWithResult()` message persist করে প্রথম delivery pass-এর পরে per-recipient status ও failure details ফেরত দেয়। কোনো recipient না থাকলে parent notice durable থাকে এবং পরবর্তী config reconciliation-এ আবার fan-out হয়।
- `packages/core/src/autonomy/autonomous-supervisor.ts`: `autonomy_send_message` tool `delivered`/`sent` কেবল অন্তত একটি destination acknowledgement পেলে `true` করে। কোনো destination deliver না করলে `false` এবং failure reason ফেরত দেয়। `tool-effect.ts` explicit false-কে unconfirmed হিসেবে ধরে; goal evidence-এ `effectConfirmed` সংরক্ষিত হয় এবং second-pass auditor delivery confirmation বাধ্যতামূলক করে।
- `announceDiscovery()` কেবল `delivery.delivered > 0` হলে `notified_at` লেখে। Offline/pending queue বা message history insert-কে delivery success হিসেবে গণ্য করে না।

এই pass-এ যোগ করা test:

- `autonomous-supervisor.test.ts`: কোনো destination delivery acknowledge না করলে `autonomy_send_message` `{ delivered:false, sent:false, reason }` ফেরত দেয়—এটি যাচাই করে।
- `tool-effect.test.ts`: delivered=true হলে confirmation, delivered=false হলে false, এবং explicit evidence না থাকলে undefined—তিনটি case যাচাই করে।
- `channel-runtime.test.ts`: legacy `sendProactiveNotice()` resolve করলেও return value `undefined` থাকে—এটি যাচাই করে।

## ২. Durable outbox ও empty allow_from warning

আগে থেকেই বাস্তবায়িত:

- Dashboard notice outbox persistent SQLite table-এ থাকে; process restart-এ `sending` row `pending`-এ recover হয়; WebSocket connect/auth হলে pending notice flush হয়।
- Channel notice আগে parent queue-তে persist হয়। Explicit recipient পাওয়া গেলে recipient-specific `channel_outbox` row তৈরি হয়; delivery worker retry ও idempotency key ব্যবহার করে। Recipient না থাকলে parent notice পরবর্তী config reconciliation পর্যন্ত থাকে।
- `ChannelRuntimeManager.warnEmptyAllowFrom()` প্রতি channel runtime-এ একবার callback দেয়। Gateway callback একই stable idempotency key (`channel-allow-from-empty:<channel>`) দিয়ে dashboard UI-তে warning দেখায় এবং warning-টিকে একই channel-এ আবার channel-এ পাঠায় না (`sendChannels:false`)।

নোট: channel outbox-এর নিজস্ব retry backoff 2s–5m হলো **message delivery retry**, model inference retry নয়। Delivery provider-কে অতিরিক্ত চাপ না দিতে এটি আলাদা রাখা হয়েছে।

## ৩. Session lane, steer_interrupt ও single-output plan

কোড অনুযায়ী আচরণ:

- `packages/gateway/src/channels/session-lane.ts`: একই conversation/context-এর run FIFO serial; অন্য context আলাদা ভাবে চলতে পারে। Lane wait timeout বা abort হলে queued run ব্যর্থ/বাতিল হয়—আগের run-এর সঙ্গে overlap করার অনুমতি দেয় না।
- `chat-turn-runner.ts`: lane মুক্ত হওয়ার পর queued message-এর history তৈরি হয়, ফলে আগের run-এর persisted assistant reply অন্তর্ভুক্ত থাকে। Lane wait controller message cancellation-এর সঙ্গে যুক্ত। Mid-run steer decision আলাদাভাবে মূল্যায়ন হয়; unread carryover হলে পরবর্তী run-এ একবার পাঠানো হয়, কিন্তু user explicit stop করলে পুনরায় চালানো হয় না।
- `agent-runtime.ts`: `steer_interrupt` কেবল config-এ `true` হলে সক্রিয়। Default false-এর ব্যাখ্যা comment-এ আছে: model completion মাঝপথে abort না করে নতুন message পরের turn-এ পড়া হবে। এটি একটি explicit design choice, hidden deadlock নয়।
- `packages/core/src/messaging/messaging-adaptive.ts`: “single” পরিকল্পনা intentional—একটি logical chat reply স্বয়ংক্রিয়ভাবে আলাদা message-এ ভাগ করা হয় না, কারণ তাতে response fragmentation/ordering সমস্যা হতে পারে। External transport adapter-এ প্রয়োজনমতো chunking হয়: Telegram 4000, Discord 1900, Slack 39000 character limit-এ `splitMessage()` ব্যবহৃত হয়। তাই web chat-এর single plan-কে bug হিসেবে পরিবর্তন করা হয়নি।

এই অডিটে এই অংশে নির্দিষ্ট reproduction-যোগ্য code defect পাওয়া যায়নি; behavior পাল্টানো হয়নি।

## ৪. Local-model-first ও auditor model

আগে থেকেই বাস্তবায়িত:

- `packages/gateway/src/agent/agent-runtime.ts`: configured local sentinel (`llama.cpp/local-model` বা alias) enabled local stored model-এ resolve হয়। Local primary হলে dashboard-selected non-local model-কে অগ্রাধিকার দিয়ে cloud fallback নির্বাচন করে; dashboard default-ও local হলে প্রথম enabled non-local stored model fallback candidate হতে পারে। Lane ও default fallback entries এবং configured credential rotation chain-ও বিবেচিত হয়।
- `config/agent.yaml`-এ model-router lane-এর empty primary dashboard-selected model বজায় রাখে। ফলে user-এর বর্তমান Dashboard model local হলে সেটি primary হয়; config-এ local sentinel explicitly দিলে configured local model-এ route করা যায়। User-selected model নীরবে override করা হয়নি।
- `packages/core/src/engine/agent-engine.ts`: `disableModelFallback === true` হলেই fallback বন্ধ; `undefined` মানে disable নয়। `autonomous-supervisor.test.ts`-এর existing expectation-ও goal run-এ configured fallback অনুমোদনের পক্ষে। সুতরাং `undefined`-কে `true`-এর মতো ব্যাখ্যা করা bug হবে।
- Local provider connection exception gateway থেকে `local_model_unavailable` category পায়; AgentEngine এটি transient হিসেবে retry করে। `provider-error.ts` ও `isInfraFailure()` local/network/provider unavailable error-কে infra retry path-এ রাখে।
- `double_check_model` config parsing ও audit invocation আগেই আছে। Non-empty model name দিলে second-check auditor আলাদা configured model-এ চালানো হয়; empty থাকলে heartbeat/background model fallback হয়। Recommendation: auditor-এর জন্য একটি সক্ষম cloud model নাম configure করা, বিশেষ করে primary local model দুর্বল হলে। এখানে provider/model inventory যাচাই করা হয়নি, তাই নির্দিষ্ট model নাম বসানো হয়নি।

## ৫. Retry ও pre-existing test

আগে থেকেই বাস্তবায়িত:

- `packages/gateway/src/providers/model-retry.ts`: model retry delay fixed 3000ms; retry index অনুযায়ী exponential delay বা jitter নেই। `Retry-After` response থাকলে সেটি 3000ms-এর **minimum/floor** হিসেবে মানা হয়।
- `model-retry.test.ts`-এ fixed delay, invalid index এবং Retry-After floor-এর tests রয়েছে।
- Core engine-এর `neverStopRetryOptions()` 3s fixed cadence, jitter off, unlimited retries এবং auth/quota retry options তৈরি করে। অন্যান্য bounded caller-এর সাধারণ retry policy আলাদা থাকতে পারে।

এই pass-এ পরিবর্তন:

- `packages/core/src/engine/agent-engine-retry.test.ts`: shared `fast` test retry config-এ `jitter:false` যোগ করা হয়েছে; unit test-এর timing deterministic করা হয়েছে। Production retry behavior বদলায়নি।

Pre-existing `autonomous-supervisor.test.ts`-এর ১৬টি failure এই environment-এ baseline-এ reproduce করা যায়নি, তাই সেগুলো patch-এর দোষ বা আগের failure—কোনোটিই দাবি করা হচ্ছে না। `agent-engine-retry.test.ts`-এর আগের jitter-related flake-ও suite চালিয়ে empirically নিশ্চিত করা যায়নি; test fixture deterministic করা হয়েছে।

## ৬. Full build, tests ও E2E — সীমাবদ্ধতা

- Uploaded ZIP-এ `packages/memory` source directory **আছে**; prompt-এর “ZIP-এ নেই” বক্তব্য এই ZIP-এর ক্ষেত্রে সত্য নয়।
- Actual live repository/provider/server configuration দেওয়া হয়নি; কেবল source ZIP আছে। তাই live Telegram/Discord/Slack, local llama.cpp server বা quota E2E চালানো হয়নি।
- `npm ci --ignore-scripts --prefer-offline --no-audit --no-fund` চালানোর চেষ্টা npm registry DNS error (`EAI_AGAIN`) দিয়ে আটকে যায়। ফলে Jest/Vitest executable ও প্রয়োজনীয় type definitions পুরোপুরি install হয়নি।
- `NODE_OPTIONS=--experimental-vm-modules npx jest --config jest.config.cjs packages/core/src/autonomy/autonomous-supervisor.test.ts --runInBand` চালানোর চেষ্টা runner resolve না হওয়ায় registry/network wait-এ আটকে যায়। `node_modules/.bin/jest` অনুপস্থিত।
- নির্দিষ্ট typecheck command চালানোর জন্য global TypeScript ব্যবহার করা হলেও typecheck `TS2688` দিয়ে থেমেছে: `jest` ও `node` type definitions অনুপস্থিত। এটি source type error-এর প্রমাণ নয়।
- চারটি পরিবর্তিত TypeScript test file-এ global TypeScript `transpileModule` syntax diagnostics চালানো হয়েছে; চারটিতেই 0 syntax diagnostic। এটি typecheck বা test execution-এর বিকল্প নয়।
- Runtime Node.js `v22.16.0`; root `package.json`-এ `>=22.19.0` requirement।

## পরিবর্তিত ফাইল

1. `packages/core/src/autonomy/autonomous-supervisor.test.ts`
2. `packages/core/src/engine/agent-engine-retry.test.ts`
3. `packages/core/src/engine/tool-effect.test.ts` (নতুন)
4. `packages/gateway/src/channels/channel-runtime.test.ts`

## Verification status

| Check | ফলাফল |
|---|---|
| চারটি modified TS file syntax/transpile | PASS — 0 syntax diagnostics |
| Jest suite / baseline comparison | BLOCKED — Jest dependency অনুপস্থিত; npm DNS `EAI_AGAIN` |
| Vitest `model-retry.test.ts` | BLOCKED — Vitest dependency অনুপস্থিত |
| Core TypeScript typecheck | BLOCKED — `@types/jest`, `@types/node` অনুপস্থিত (`TS2688`) |
| Full build | NOT RUN — dependencies ও required Node version অনুপস্থিত |
| Provider quota → retry → goal audit → next-step → live notification E2E | NOT RUN — live provider/server environment নেই |

কোনো `Retry-After` আচরণ পরিবর্তন করা হয়নি।

## Maintenance and status note

This is a dated investigation, plan, or implementation snapshot. Its findings and status labels describe the code and test evidence available when it was written; they are not a live assertion that every item remains current. Preserve this report as historical context. For present behavior, check the current source, the adjacent tests, and [Agent-Miki Operating Model](AGENT_MIKI_OPERATING_MODEL.md) where applicable. Do not treat an unverified recommendation or an old checklist as proof of an enabled capability.
