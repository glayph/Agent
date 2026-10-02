# ধাপ ১১ — Hooks / Lifecycle Events (OpenClaw সমতুল্য: Internal Hooks + Typed Plugin Hooks)

## লক্ষ্য
এজেন্টের জীবনচক্রের নির্দিষ্ট মুহূর্তে (সেশন শুরু, রিসেট, মেমরি-কম্প্যাকশন, প্রসেস স্টার্টআপ ইত্যাদি)
কোর কোড হার্ডকোড না করে বাইরে থেকে react করার একটা extension seam তৈরি করা।

## OpenClaw-তে এটা যেভাবে কাজ করে
- ইভেন্ট ক্যাটাগরি: command ইভেন্ট (`/new`, `/reset`, `/stop`-এর সমতুল্য), সেশন ইভেন্ট (compaction
  before/after, session start/end), মেসেজ ইভেন্ট (received/sent), লাইফসাইকেল ইভেন্ট (bootstrap,
  gateway startup/shutdown, pre-restart)।
- Handler-গুলো ছোট, request-scoped হতে হয় — নিজেরা দীর্ঘস্থায়ী টাইমার/সকেট/কানেকশন রাখা উচিত না;
  সেটা দরকার হলে আলাদা service/lifecycle রেজিস্ট্রেশন (`gateway_start`/`gateway_stop`-জাতীয়)
  ব্যবহার করা উচিত।
- Hook গুলো internal (operator-managed, ছোট স্ক্রিপ্ট) ও typed/plugin hook (নির্দিষ্ট contract,
  priority, block/cancel করার ক্ষমতাসহ) — দুই ধরনের হতে পারে।

## আপনার OwlClaw-তে কী তৈরি করতে হবে
1. একটা সাধারণ `EventBus`: `on(event_name, handler)` দিয়ে সাবস্ক্রাইব, `emit(event_name, payload)`
   দিয়ে ট্রিগার।
2. নিচের ইভেন্ট-পয়েন্টগুলো OwlClaw-এর কোরে emit করো:
   - `session:start` / `session:end` / `session:reset`
   - `session:compact:before` / `session:compact:after` (ধাপ ০২-এর সাথে যুক্ত)
   - `workspace:bootstrap` (ধাপ ০১-এর loader চলার আগে/পরে)
   - `gateway:startup` / `gateway:shutdown` (প্রসেস লেভেলে)
   - `message:received` (ধাপ ০৬-এর normalize হওয়ার পরে)
   - `tool:before_call` / `tool:after_call` (ধাপ ০৪-এর ToolGate-এর সাথে যুক্ত, প্রয়োজনে block করার
     ক্ষমতাসহ — যেমন কোনো plugin চাইলে একটা নির্দিষ্ট tool call approval-এর জন্য আটকে দিতে পারে)
   - `subagent:spawned` / `subagent:ended` (ধাপ ১০-এর সাথে যুক্ত)
3. প্রতিটা handler try/except + timeout দিয়ে wrap করো — একটা ধীর/ব্যর্থ hook কখনো কোর লুপ ক্র্যাশ
   করাবে না, শুধু লগ করবে এবং বাকি হুক/মূল কাজ চালিয়ে যাবে।
4. Handler execution order ডকুমেন্টেড রাখো (registration order বা explicit priority নম্বর)।

## Behavior Contract
1. একটা hook handler ব্যর্থ/টাইমআউট হলে মূল agent লুপ থামবে না, শুধু লগ হবে।
2. Hook handler-এ কোনো দীর্ঘস্থায়ী resource (persistent timer/socket) রাখা নিষিদ্ধ — লিন্ট/রিভিউ
   চেকলিস্টে এটা যোগ করো।
3. একই ইভেন্টে একাধিক হুক থাকলে ক্রম ডিটারমিনিস্টিক ও ডকুমেন্টেড।

## Acceptance Criteria
- [ ] একটা ইচ্ছাকৃতভাবে exception ছোঁড়া dummy hook যোগ করলেও বাকি সিস্টেম স্বাভাবিক চলে (টেস্টে প্রমাণিত)।
- [ ] প্রতিটা তালিকাভুক্ত ইভেন্ট-পয়েন্ট (session/compaction/bootstrap/gateway/message/tool/subagent)
      একটা dummy লগিং-হুক দিয়ে ফায়ার হতে দেখা যায়।
- [ ] Hook execution order একটা টেস্টে ভবিষ্যদ্বাণীযোগ্য প্রমাণিত হয়।

## যাচাই ও সংশোধন প্রোটোকল
00-README.md-এর Universal Protocol অনুসরণ করো। এই ধাপ cross-cutting, তাই:
- এটা যোগ করার সময় ০১-০৭ ধাপের কোনো existing ফাংশন সিগনেচার না ভেঙে, শুধু ভেতরে `emit()` কল যোগ
  করো (additive change, breaking change না)।

## নির্ভরতা
ঢিলেভাবে ০১, ০২, ০৬, ০৭-এর উপর নির্ভরশীল (এই ধাপগুলোর কোডে emit-পয়েন্ট বসাতে হবে), তাই এগুলো
তৈরি হওয়ার পরে করাই সহজ, যদিও EventBus নিজে স্বাধীনভাবে যেকোনো সময় বানানো যায়।

## এই ধাপ শেষে যা থাকা উচিত
একটা lightweight ইভেন্ট বাস, যা ভবিষ্যতে নতুন behavior/observability যোগ করার সময় কোর কোড না
ছুঁয়ে করা সম্ভব করে।
