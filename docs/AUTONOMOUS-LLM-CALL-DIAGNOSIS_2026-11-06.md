# Miki: স্বতঃস্ফূর্ত পরবর্তী LLM/API call — ৩ ধাপে কারণ ও সমাধান

তারিখ: 2026-11-06

এই নথি repository source পরীক্ষা করে তৈরি। এটি live deployment-এর runtime log,
`.env`, database বা provider account access করে না; তাই নিচে কোথায় নিশ্চিত
source evidence আছে এবং কোথায় live verification প্রয়োজন, তা আলাদা রাখা হয়েছে।

## সমস্যার কারণ — ৩ ধাপ

### ১. Model call এবং Agent runtime-কে এক জিনিস ভাবা

একটি LLM/API request সম্পন্ন হলে model-এর ওই invocation শেষ হয়। Model নিজে
নেটওয়ার্কে আরেকটি HTTP/API request শুরু করতে পারে না। পরবর্তী call-এর জন্য
application-এর host-side scheduler/supervisor-কে আবার model provider ডাকতে হয়।
Miki-কে “নিজে নিজে আবার call করো” বলা তাই implementation-এর সঠিক বর্ণনা নয়;
সঠিক বর্ণনা হলো “চলমান AutonomousSupervisor পরবর্তী call schedule করে”।

### ২. পরবর্তী call-এর দায়িত্ব ও runtime gate স্পষ্টভাবে বলা ছিল না

Repository-তে `AutonomousSupervisor` startup-এ চালু হয়, ambient decision নেয়,
এবং event বা quiet-environment cadence-এ পরবর্তী decision schedule করে।
`config/agent.yaml`-এ `heartbeat.proactive.enabled: true`,
`heartbeat.proactive.llm_when_idle: true`, `startup_decision: true`,
`decision_interval_seconds: 5` এবং `idle_after_seconds: 0` রয়েছে। Gateway-র
`configureRuntimeLoop()` autonomy চালু থাকলে supervisor শুরু করে।

তবে বাস্তবে পরবর্তী call হওয়ার জন্য gateway process চলমান, supervisor RUNNING,
autonomy enabled, supervisor PAUSED নয়, Idle LLM enabled এবং provider/network
ব্যবহারযোগ্য থাকা দরকার। Provider failure/circuit backoff হলে পরবর্তী call
পিছিয়ে যেতে পারে। শুধু YAML default দেখে live deployment-এ এই সব শর্ত সত্যি
বলা যায় না; environment variable, persisted/UI config বা stale build আলাদা
হতে পারে।

### ৩. Miki-র উত্তরে live status-এর বদলে prompt-কে activation mechanism বলা হয়েছে

Source-এর আগের identity instructions-এ live autonomy status দেখতে বলা ছিল,
কিন্তু model-call শেষ হওয়া, পরবর্তী request-এর owner, এবং “activation prompt
চাইতে হবে না”—এই তিনটি বিষয় একত্রে যথেষ্ট স্পষ্টভাবে বাধ্যতামূলক ছিল না। ফলে
Miki-র “আমাকে prompt দাও, আমি upgrade করব” উত্তরটি runtime status-এর
প্রমাণভিত্তিক উত্তর নয়। Live runtime-এ system prompt বন্ধ থাকলে
(`agents.defaults.turn_profile.system_prompt.mode: off`), বা deployed build
source-এর চেয়ে পুরোনো হলে, নতুন contract-ও model পাবে না। Archive একা দিয়ে
কোনটি live instance-এ ঘটেছে তা নিশ্চিত করা সম্ভব নয়।

## সমাধান — ৩ ধাপ

### ১. Identity/system prompt-এ সঠিক lifecycle contract যোগ করা হয়েছে

`packages/gateway/src/agent/identity-prompt.ts`-এ এখন স্পষ্ট করা হয়েছে:

- একটি model/API invocation শেষ হলে model নিজে আরেকটি network call শুরু করে না;
- পরবর্তী fresh LLM request host-side `AutonomousSupervisor` schedule করে;
- supervisor RUNNING, enabled, unpaused এবং Idle LLM enabled হলে user-এর নতুন
  chat message বা activation prompt ছাড়াই startup/event/quiet cadence-এ call হয়;
- prompt কোনো scheduler চালু, credential সরবরাহ বা provider limit bypass করতে পারে না;
- status STOPPED/PAUSED/disabled/unavailable বা provider recovery-তে থাকলে Miki
  সেটিই জানাবে, এবং আক্ষরিক “unlimited” API access দাবি করবে না।

### ২. Runtime status/API-তে call lifecycle দৃশ্যমান করা হয়েছে

`packages/core/src/autonomy/autonomous-supervisor.ts`-এর
`GET /api/autonomy/status` response-এ `proactive_loop.llm_call_lifecycle` যোগ
করা হয়েছে। এতে `model_call_self_schedules`, `subsequent_call_owner`,
`autonomous_follow_up_enabled`, `provider_backoff_active`, `supervisor_running`
ও `paused` পাওয়া যাবে। Conversation-এর live runtime context-এও পরবর্তী call
কোন process schedule করবে এবং বর্তমানে eligible কি না তা লেখা হয়। এটি পুরোনো
feature বাদ দেয় না; observability ও explanation স্পষ্ট করে।

### ৩. Regression test ও অপারেশনাল যাচাই যোগ করা হয়েছে

Identity prompt test-এ ভুল “activation prompt” পরামর্শ না দেওয়া এবং model বনাম
supervisor-এর দায়িত্ব আলাদা করে বলার assertion যোগ হয়েছে। Supervisor test-এ
RUNNING/PAUSED state অনুযায়ী lifecycle status যাচাই হয়।
`docs/always-active-idle-mode.md`-এ lifecycle এবং API field ব্যাখ্যা হালনাগাদ
করা হয়েছে।

Deploy করার পরে যাচাই করুন:

1. `GET /api/autonomy/status`-এ `running: true`, `enabled: true`,
   `paused: false` এবং `proactive_loop.llm_when_idle: true` আছে কি না;
2. `proactive_loop.llm_call_lifecycle.autonomous_follow_up_enabled: true` আছে
   কি না; provider outage/backoff থাকলে সেটি `provider_backoff_active: true`
   হিসেবে দেখা যাচ্ছে কি না;
3. `last_decision_at` পরবর্তী quiet cadence/event-এর পরে এগোচ্ছে এবং provider
   logs-এ পৃথক পরবর্তী request দেখা যাচ্ছে কি না। কেবল “RUNNING” লেখা থাকাই
   বাস্তবে provider call সফল হওয়ার প্রমাণ নয়।

## সীমা ও চালানোর পরিবেশ

“Always active” মানে চলমান host process-এর scheduler স্বয়ংক্রিয়ভাবে কাজ চালাবে;
কম্পিউটার বন্ধ থাকলে, process বন্ধ হলে, network/provider unavailable হলে,
credential invalid হলে বা operator pause/stop করলে call চলবে না। Application-এর
কিছু task/iteration ceiling সরানো থাকলেও provider quota/rate limit, model
context/output limit, OS permission, resource availability ও cancellation
বাস্তব সীমা।

এই container-এ project-এর প্রয়োজনীয় Node `>=22.19.0`; পাওয়া Node version
`v22.16.0`, এবং archive-এ dependencies/node_modules নেই। তাই এখানে পূর্ণ
`npm install`, `npm run build:all` বা Jest suite সফল হয়েছে বলে দাবি করা হচ্ছে না।
সঠিক Node version ও dependency install করা deployment environment-এ build/test
চালাতে হবে।
