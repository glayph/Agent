# Miki Remediation Summary

## Status

Miki-কে নতুন compiled build দিয়ে restart করা হয়েছে। Gateway live health check পাস করেছে এবং dashboard চলছে:

- `http://127.0.0.1:18800`
- `/gateway/health` → HTTP 200
- `/gateway/live` → HTTP 200
- Miki service process active

## Autonomous no-prompt policy

User-এর নির্দেশ অনুযায়ী local autonomous operation-এ Miki কোনো action নেওয়ার আগে interactive user permission চাইবে না। `config/agent.yaml`-এ:

- `tools.require_confirm_destructive: false`
- `tools.require_confirm_computer_use: false`
- audit logging চালু রাখা হয়েছে
- input validation, hard resource limits, catastrophic command blocklist, authentication boundary এবং execution cancellation বজায় রাখা হয়েছে

Compiled gate verification:

```json
{"destructive":false,"computer":false}
```

এটি **interactive confirmation বন্ধ করে**; এটি network authentication, malformed input rejection, dangerous command hard-block বা audit logging বন্ধ করে না।

## Implemented fixes

### Tool Call ও Workflow

- ToolRegistry-তে recursive primitive/object/array/enum schema validation যোগ হয়েছে। ফলে `dryRun: "true"` boolean হিসেবে গ্রহণ হবে না।
- Tool timeout/cancellation-এ derived `AbortSignal`, timeout listener/timer cleanup এবং cancellation propagation যোগ হয়েছে।
- CommandQueue executor exception এখন `failed`, false `completed` নয়।
- Unsettled interrupt-এর সময় queue session serialization আগেভাগে release না করার পরিবর্তন করা হয়েছে।
- CronScheduler এখন `EnqueueResult.accepted` যাচাই করে; queue rejection হলে false success, one-shot deletion বা schedule advance করবে না।
- AgentMessageBus timeout-এ reply listener cleanup যোগ হয়েছে।
- MCP invalid concurrency value clamp/default করা হয়েছে; `0`, negative বা `NaN`-এ indefinite queue deadlock হবে না।

### Route ও Gateway

- Direct `POST /agent/route-preview` HTTP authentication-এর পেছনে নেওয়া হয়েছে।
- Gateway WebSocket upgrade-এ non-empty কিন্তু invalid API key/Bearer/cookie reject করা হয়েছে।
- `bypass_restrictions` আর credentialed wildcard CORS চালু করে না।
- `/gateway/health` core unhealthy হলে degraded/503 semantics ব্যবহার করে; `/gateway/live` আলাদা liveness endpoint হিসেবে যোগ হয়েছে।
- Frontend auth-status network failure এখন fail-closed error state দেখায়; full dashboard/chat initialize করে না।

### Autonomous Mode

- Blocked objective আর `listUnfinished()` থেকে ফেরত আসে না।
- Restart recovery persisted active objective restore করার চেষ্টা করে।
- Pause/disable current objective-এর scheduler pause/cancellation request করে।
- 24/7 supervisor restart spawn failure এখন failed state persist করে এবং unmanaged alive অবস্থায় থাকে না।

### Memory

- Memory file read/listing-এ realpath এবং symlink escape rejection যোগ হয়েছে।
- Memory scope key delimiter collision প্রতিরোধে escaped components ব্যবহার করা হয়েছে; legacy raw key compatibility metadata রাখা হয়েছে।
- Memory data directory বদলালে পুরনো daemon stop এবং TKG close করা হয়।

### Skills

- Plugin execution metadata এখন স্পষ্টভাবে `policy-only`/`Miki_PLUGIN_SANDBOX_ENFORCED=0` হিসেবে label করা হয়েছে; false full-sandbox claim সরানো হয়েছে।
- Least-privilege environment behavior বজায় আছে।

## Validation completed

- `npm run build:all` — **পাস**
- Core focused tests — **৪ suite, ৩৩ tests পাস**
- Memory file/cron focused tests — **১৯ tests পাস**
- Memory package integration suite — **সব পাস**
- Gateway/core/frontend typechecks — **পাস**
- Frontend Vitest — **১৮ files, ১২৪ tests পাস**
- Gateway applicable Jest suites — **৭ suites, ২৯ tests পাস**
- `git diff --check` — **পাস**
- `node --check scripts/miki-24-7.mjs` — **পাস**
- Live `/gateway/health` ও `/gateway/live` — **HTTP 200**

## Remaining limitations

1. **Full OS-level plugin sandbox এখনও নেই।** Plugin child process এখনও আলাদা container/VM/seccomp boundary-তে চলে না; policy metadata ও least-privilege environment আছে, কিন্তু arbitrary installed plugin-এর জন্য complete kernel-enforced isolation এখনও বাস্তবায়িত হয়নি।
2. **Legacy TKG/NodeGraph-এর সব table-এ persisted scope migration সম্পূর্ণ হয়নি।** Scope-key collision fix হয়েছে, কিন্তু cross-tenant isolation সম্পূর্ণ করতে legacy tables, edges এবং সব retrieval query-তে mandatory scope column/predicate migration দরকার।
3. Unknown browser path এখনও SPA fallback হিসেবে HTTP 200 দিতে পারে; এটি availability defect, authentication bypass নয়।
4. Existing repository working tree-তে পূর্বের unrelated modifications ছিল; সেগুলো reset করা হয়নি।
5. কিছু SQLite lease takeover এবং full multi-process stress test এই sandbox run-এ করা হয়নি।

## Recommended next phase

- Restricted OS sandbox/container/VM দিয়ে Skills execution harden করা।
- TKG/NodeGraph schema migration করে mandatory scope যোগ করা।
- Queue/workflow lease takeover-এর multi-process stress tests যোগ করা।
- Gateway integration tests CI-তে স্থায়ীভাবে wire করা।
- SPA unknown-path status contract নির্ধারণ করে 404 behavior যোগ করা।
