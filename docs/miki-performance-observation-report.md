# Miki-এর সাধারণ কাজ ধীর ও অনির্ভরযোগ্য হওয়ার কারণ

**পর্যবেক্ষণের তারিখ:** ২৩ সেপ্টেম্বর ২০২৬  
**পর্যবেক্ষিত সংস্করণ:** `/home/ubuntu/Miki-final`  
**পর্যবেক্ষণের লক্ষ্য:** Model বা operating-system performance বিশ্লেষণ না করে Miki-এর routing, tool selection, task execution, progress reporting এবং plugin orchestration-এর ত্রুটি শনাক্ত করা।

## Executive finding

Miki সাধারণ conversational message-এর জন্য একটি `simple_message` fast path ব্যবহার করে। কিন্তু ব্যবহারকারী যখন কোনো সাধারণ action দেন—যেমন “একটি hello world Python script তৈরি করো” বা “`pwd` চালাও”—তখন Miki সেটিকে full `task` pipeline-এ পাঠায়। এই pipeline-এ প্রথমে tool selection এবং একটি structured model decision দরকার হয়। কাজটি deterministic হওয়া সত্ত্বেও Miki সরাসরি file বা shell operation চালায় না। ফলে এক লাইনের কাজেও ৩০ সেকেন্ডের বেশি সময় লাগতে পারে।

সবচেয়ে গুরুত্বপূর্ণ সমস্যা হলো **Miki-এর action fast path অসম্পূর্ণ**। Math, নির্দিষ্ট file-content request এবং web-search-এর জন্য deterministic shortcut আছে। কিন্তু সাধারণ shell command এবং স্বাভাবিক ভাষায় বলা ছোট code-generation task-এর জন্য একই shortcut নেই। তাই Miki-এর ভেতরের orchestration কাজের তুলনায় অপ্রয়োজনীয়ভাবে ভারী হয়ে যায়।

## পরীক্ষিত routing behavior

নিচের behavior বর্তমান compiled routing code দিয়ে পুনরুৎপাদন করা হয়েছে।

| ব্যবহারকারীর request | Miki-এর সিদ্ধান্ত | Deterministic shortcut | ফলাফল |
|---|---|---|---|
| `hello` | `simple_message`, tools বন্ধ | নেই | সরাসরি উত্তর দেওয়ার fast path |
| `what is 2 + 2?` | `simple_message`, tools বন্ধ | math আছে | model call ছাড়াই উত্তর সম্ভব |
| `create a hello world python script` | `task`, tools চালু | নেই | tool নির্বাচন করার জন্য full agent loop |
| `create hello.py containing exactly: print('hello world')` | `task`, tools চালু | file workflow আছে | সরাসরি `file_write` + `file_read` করা সম্ভব |
| `run pwd` | `task`, tools চালু | নেই | shell tool-এর জন্য model decision প্রয়োজন |
| `search the web for current Python release` | `task`, tools চালু | web search আছে | deterministic search path আছে, কিন্তু profile ভুলভাবে heavy দেখায় |

এই ফলাফল `task-profile.ts`, `execution-pipeline.ts` এবং `deterministic-intent.ts`-এর বর্তমান behavior থেকে পাওয়া।

## প্রধান কারণ ১: সাধারণ action-এর জন্য deterministic execution নেই

`execution-pipeline.ts`-এ `create`, `write`, `run`, `execute`, `code` এবং অনুরূপ শব্দ থাকলেই request `task` mode-এ যায়। কিন্তু `deterministic-intent.ts` কেবল কয়েকটি নির্দিষ্ট pattern বোঝে। File shortcut কাজ করতে হলে request-এ filename এবং explicit content delimiter থাকতে হয়। “একটি hello world Python script তৈরি করো” এই pattern-এ পড়ে না।

ফলে Miki নিজে থেকে এই সহজ সিদ্ধান্ত নিতে পারে না:

1. workspace-এর নিরাপদ বর্তমান directory নির্বাচন করা;
2. `hello.py`-এর মতো একটি filename নির্ধারণ করা;
3. `print("Hello, World!")` লেখা;
4. file existence যাচাই করা;
5. একবারে সংক্ষিপ্ত ফলাফল দেওয়া।

এর পরিবর্তে request-টি model-এর কাছে পাঠানো হয়, model-কে tool schema দেওয়া হয়, তারপর model-কে structured function call তৈরি করতে হয়। এই routing overhead কাজটির বাস্তব complexity-এর তুলনায় বেশি।

## প্রধান কারণ ২: `run pwd`-এর মতো সাধারণ shell request model-dependent

`tool-call-parallelism.ts`-এ `shell_execute`-এর timeout 120 সেকেন্ড এবং workspace lock exclusive করা হয়েছে। এটি দীর্ঘ command-এর জন্য যুক্তিসঙ্গত হতে পারে, কিন্তু `pwd`, `ls`, `echo`, `python --version` বা `git status`-এর মতো safe read-only command-এর জন্য আলাদা fast policy নেই।

আরও গুরুত্বপূর্ণ বিষয় হলো `adaptive-capability-selector.ts`-এর ambiguous-turn filtering। Simple এবং unverified request-এর ক্ষেত্রে `shell`, `execute`, `browser`, `write` এবং অনুরূপ tool বাদ দেওয়া হয়। Fallback list-এ `file_read`, `memory_search` এবং `ask_user` আছে, কিন্তু `shell_execute` নেই। তাই “run pwd” একটি simple request হিসেবে classify হলে shell tool নির্বাচিত না-ও হতে পারে। তখন Miki tool চালানোর বদলে ব্যাখ্যা দিতে পারে, ভুল tool বেছে নিতে পারে, অথবা অতিরিক্ত clarification চাইতে পারে।

এটি model-এর অক্ষমতা নয়; এটি Miki-এর capability-selection policy-এর ত্রুটি। Safe, explicit, read-only shell request-কে ambiguous destructive request-এর সঙ্গে একইভাবে filter করা হয়েছে।

## প্রধান কারণ ৩: task শুরু হওয়ার আগে Miki অনেক orchestration কাজ করে

Full task path-এ model call-এর আগে Miki নিম্নলিখিত কাজ করে:

- task profile তৈরি করে;
- execution pipeline নির্ধারণ করে;
- specialist route নির্ধারণ করে;
- সব registered tool পড়ে adaptive capability selection করে;
- নির্বাচিত tool ও skill-এর capability report তৈরি করে;
- non-simple turn-এর জন্য দীর্ঘ execution instruction তৈরি করে;
- selected tools-এর schema model request-এ যুক্ত করে;
- tool warmer চালায়;
- local model readiness ও runtime synchronization যাচাই করে;
- conversation history এবং context policy প্রয়োগ করে।

এই কাজগুলোর বেশিরভাগই complex workflow-এর জন্য দরকার হতে পারে। কিন্তু একটি single-file hello-world task-এর জন্য এগুলো request-এর আগে অতিরিক্ত control-plane latency তৈরি করে। `agent.ts`-এর simple path-এ কেবল ছোট system content ব্যবহৃত হয়, কিন্তু action request সেই path ব্যবহার করে না।

## প্রধান কারণ ৪: Miki-এর timeout policy দ্রুত কাজের বিরোধী

বর্তমান source-এ local LLM call-এর minimum timeout ৩০ সেকেন্ড এবং default timeout ৯০ সেকেন্ড। Local agent run-এর default timeout ১৮০ সেকেন্ড। Shell execution-এর default policy timeout ১২০ সেকেন্ড। Agent loop সর্বোচ্চ ৫০টি turn চালাতে পারে এবং output না এলে চারটি no-output turn পর্যন্ত অপেক্ষা করতে পারে।

এই timeout-গুলো safety ceiling হিসেবে প্রয়োজনীয় হতে পারে, কিন্তু short task-এর জন্য latency budget নয়। Miki-এর কাছে “এই request একবারের বেশি model turn পাবে না” বা “safe one-shot task ৫ সেকেন্ডের মধ্যে fail-fast করবে” এমন policy নেই। ফলে ভুল tool selection, malformed tool call বা slow intermediate response হলেও Miki দীর্ঘ সময় অপেক্ষা করে।

## প্রধান কারণ ৫: tool result-এর পরও model turn প্রয়োজন হয়

Tool call চালানোর পরে Miki tool result আবার conversation-এ যোগ করে model-এর কাছে পাঠায়। Complex task-এ এটি সঠিক behavior। কিন্তু একটি file write বা `pwd` command-এর জন্য tool result নিজেই যথেষ্ট হতে পারে। বর্তমান implementation সাধারণত model-কে আবার final natural-language response তৈরি করতে দেয়।

এতে ছোট action-এর জন্য অন্তত এই lifecycle তৈরি হয়:

1. model tool call নির্বাচন করে;
2. Miki tool চালায়;
3. tool result সংগ্রহ করে;
4. model final response তৈরি করে;
5. Miki stream completion পাঠায়।

Deterministic action-এর ক্ষেত্রে এই lifecycle bypass করা সম্ভব, কিন্তু সাধারণ shell এবং natural-language code task-এ তা করা হয় না।

## প্রধান কারণ ৬: “working response” tool call-এর আগে যথেষ্ট কার্যকর নয়

Miki `execution_pipeline`, `tool_execution_plan`, `tool_call` এবং `action_update` event পাঠাতে পারে। কিন্তু task-এর শুরুতে user-facing short acknowledgement সব ক্ষেত্রে সঙ্গে সঙ্গে পাঠানো হয় না। Local model-এর প্রথম structured response আসার আগে UI-তে শুধু generic working indicator দেখা যেতে পারে।

অর্থাৎ Miki কাজ শুরু করেছে কি না, tool নির্বাচন করছে কি না, নাকি model response-এর জন্য অপেক্ষা করছে—এই তিনটি অবস্থা ব্যবহারকারীর কাছে যথেষ্ট আলাদা নয়। এতে latency আরও দীর্ঘ মনে হয় এবং failure diagnosis কঠিন হয়।

Tool call-এর আগে Miki-র deterministic router নিজেই একটি immediate event দিতে পারে, যেমন “আমি `hello.py` তৈরি করছি।” বর্তমান code-এ action update সাধারণত model tool call তৈরি করার পর আসে। তাই model ধীর হলে working message-ও দেরিতে দেখা যায়।

## প্রধান কারণ ৭: একই request-এর জন্য একাধিক classification layer আছে

Miki-তে task profile, execution pipeline, adaptive capability selection, agent route, workflow acceleration এবং token-budget logic আলাদা layer হিসেবে আছে। এই layers-এর উদ্দেশ্য আলাদা হলেও তাদের signal vocabulary সম্পূর্ণ এক নয়।

বিশেষভাবে:

- `task-profile.ts` implementation intent-কে complexity score-এ যোগ করে;
- `execution-pipeline.ts` marker দেখলেই task mode নির্বাচন করে;
- `token-budget-manager.ts` আলাদা keyword-based complexity estimator ব্যবহার করে;
- actual model selection `agent.ts`-এর `model_routing` config দিয়ে হয়;
- adaptive selector আবার tool candidates prune করে।

ফলে “simple action” নামে একটি একক operational class নেই। একটি request profile-এ simple, pipeline-এ task, budget layer-এ standard এবং tool selector-এ ambiguous হতে পারে। এই semantic mismatch tool ভুল নির্বাচন এবং অপ্রয়োজনীয় full loop-এর ঝুঁকি বাড়ায়।

## প্রধান কারণ ৮: web search-এর latency classification ভুল

“search the web for current Python release” request deterministic web-search path-এ যেতে পারে। কিন্তু `verificationDepthFor()`-এর release regex-এ “release” শব্দ থাকলে request-এর verification depth `release` এবং speed class `heavy` হয়। Result হলো simple web lookup-এর expected latency “15_plus_minutes_or_longer” হিসেবে report করা হয়।

এটি শুধু label সমস্যা নয়। Miki-এর workflow acceleration, progress display এবং verification behavior এই profile ব্যবহার করলে একটি ছোট search-কে release-grade workflow হিসেবে treat করতে পারে। Search service-এ local HTTP request-এর timeout ১৫ সেকেন্ড এবং auto mode-এ local result না পেলে API fallback আছে। এই service latency বাস্তব search-এর জন্য গ্রহণযোগ্য হলেও “release” শব্দের কারণে task-level expectation অতিরঞ্জিত করা উচিত নয়।

## প্রধান কারণ ৯: verification policy ছোট কাজকেও বড় করে

Implementation intent বা technical syntax পাওয়া গেলে task profile verification depth `focused` করে। এটি code change-এর জন্য নিরাপদ default, কিন্তু hello-world script-এর মতো trivial artifact-এর ক্ষেত্রে verification policy আরও narrow হওয়া দরকার।

একটি ছোট file task-এর verification হওয়া উচিত:

- file exists;
- file non-empty;
- optional syntax check।

বর্তমান workflow model-কে tool call-এর পরে completion এবং verification নিয়ে আবার সিদ্ধান্ত নিতে দেয়। এই decision loop স্বাভাবিকভাবেই বড় task-এর জন্য ভালো, কিন্তু trivial artifact-এর latency বাড়ায়।

## Plugin এবং tool behavior-এর পর্যবেক্ষণ

### Shell

Safe read-only shell command-এর জন্য পৃথক fast lane নেই। `shell_execute` সাধারণ mutation-capable tool হিসেবে workspace-exclusive lock এবং ১২০ সেকেন্ড timeout পায়। Miki command safety জানে, কিন্তু routing layer তা latency policy-তে ব্যবহার করছে না।

### File tools

Explicit filename এবং exact content থাকলে deterministic `file_write` + `file_read` workflow আছে। Natural-language “একটি script বানাও” request-এ filename/content inference-এর bounded policy নেই। তাই user intent পূরণ করতে model-এর ওপর অতিরিক্ত নির্ভরতা তৈরি হয়।

### Web search

Search service-এ local provider, API provider, cache এবং fallback আছে। কিন্তু search intent classification profile-এর সঙ্গে service-level timeout ও fallback policy সংযুক্ত নয়। Simple lookup-এর জন্য result-limit, cache-hit এবং local search path-এর আলাদা fast response contract নেই।

### Plugins এবং skills

Non-simple turn-এ Miki সব skill metadata এবং tool catalog-এর অংশ capability analysis-এর জন্য বিবেচনা করে। Adaptive pruning tool schema কমায়, কিন্তু planning এবং capability-report construction আগে হয়। সাধারণ task-এর জন্য plugin discovery request-এর critical path-এ থাকা উচিত নয়; plugin registry cache করা বা task-specific lazy loading করা উচিত।

## “সঠিকভাবে কাজ করে না” সমস্যার কারণ

Miki-এর বর্তমান behavior-এ latency এবং correctness একই root cause থেকে আসে: **tool decision model-এর ওপর বেশি নির্ভরতা এবং deterministic intent coverage কম**।

যখন tool selection ভুল হয়, Miki-এর তিনটি failure mode দেখা যায়:

1. **Tool না পাওয়া:** ambiguous filter safe shell বা write tool সরিয়ে দেয়।
2. **Tool call দেরি হওয়া:** model আগে natural-language planning বা action update তৈরি করে।
3. **Tool call-এর পরে পুনরায় model loop:** result পাওয়ার পরও final completion-এর জন্য নতুন turn লাগে।

এই কারণে shell, simple response, task response, working response এবং web search একক consistent execution contract অনুসরণ করে না। কিছু capability deterministic, কিছু model-selected, কিছু plugin-selected এবং কিছু fallback-driven।

## অগ্রাধিকারভিত্তিক সমাধান

### P0 — সাধারণ safe action-এর deterministic fast lane

`run pwd`, `echo hello`, `ls`, `python --version`, `git status` এবং অনুরূপ allowlisted read-only command-এর জন্য Miki সরাসরি bounded shell execution চালাবে। Command allowlist, workspace restriction এবং ৫–১০ সেকেন্ডের short timeout প্রয়োগ করতে হবে। Model tool selection এই path-এর অংশ হওয়া উচিত নয়।

Natural-language simple artifact request-এর জন্য bounded intent parser যোগ করতে হবে। “একটি hello world Python script তৈরি করো” request-কে `create_file` intent-এ রূপান্তর করে safe default filename বা একবারের clarification policy ব্যবহার করা উচিত। User-এর intent অস্পষ্ট হলে full agent loop নয়, একটি short clarification দরকার।

### P0 — one-shot task contract

প্রতিটি task-এর জন্য execution budget নির্ধারণ করতে হবে:

- simple file task: সর্বোচ্চ ১ write + ১ read;
- simple shell task: সর্বোচ্চ ১ command;
- simple search: সর্বোচ্চ ১ search call;
- standard task: বর্তমান model loop;
- complex task: planner, tools এবং verifier।

One-shot task সফল হলে দ্বিতীয় model turn ছাড়াই deterministic final response তৈরি করা উচিত।

### P1 — tool-selection policy সংশোধন

Safe read-only `shell_execute`-কে ambiguous-turn filter থেকে বাদ দিতে হবে। একইভাবে file creation-এর ক্ষেত্রে write tool কেবল destructive বা overwrite operation হলে block করা উচিত। New-file creation এবং overwrite এক policy-তে রাখা যাবে না।

### P1 — progress event আগে পাঠানো

Miki নিজে routing সিদ্ধান্ত নেওয়ার সঙ্গে সঙ্গে UI-তে working event পাঠাবে। Model tool call-এর জন্য অপেক্ষা করে working message দেখানো যাবে না। UI-তে অন্তত `routing`, `executing`, `verifying`, `completed` এবং `failed` state আলাদা করতে হবে।

### P1 — timeout ও retry tier করা

বর্তমান ৯০/১২০/১৮০ সেকেন্ড ceiling complex workflow-এর জন্য রাখা যেতে পারে। Simple task-এর জন্য আলাদা ছোট budget দরকার। Quality retry-ও simple task-এ বন্ধ রাখা উচিত, কারণ একটি short response-এর style evaluation করে পুনরায় model call করা latency বাড়ায়।

### P2 — classification layer একীভূত করা

Task profile, pipeline, token budget এবং tool selector-এর জন্য একটি shared operational profile ব্যবহার করা উচিত। Profile-এ অন্তত `intent`, `execution_mode`, `tool_budget`, `max_turns`, `timeout`, `verification_depth` এবং `response_strategy` থাকবে। একই request যেন এক layer-এ simple এবং অন্য layer-এ heavy না হয়।

### P2 — plugin metadata critical path থেকে সরানো

প্রতিটি non-simple request-এ সব skill metadata পড়ার পরিবর্তে plugin/skill metadata cache করতে হবে। Tool definitions lazy-load করতে হবে এবং selected plugin-এর schema ছাড়া অন্য plugin-এর analysis বাদ দিতে হবে।

### P2 — observability উন্নত করা

প্রতিটি request-এ Miki-এর internal timeline সংরক্ষণ করা দরকার:

- routing duration;
- model-selection duration;
- prompt-build duration;
- first model byte;
- tool-call start/end;
- verification duration;
- retry count;
- total duration।

এই metrics ছাড়া “কোথায় সময় যাচ্ছে” নির্ভুলভাবে বোঝা যায় না। বর্তমান code-এ কিছু execution event আছে, কিন্তু end-to-end duration breakdown user-visible বা সহজে queryable নয়।

## Final assessment

Miki ধীর হওয়ার প্রধান কারণ model-এর উত্তর দেওয়ার ক্ষমতা নয়। Miki সাধারণ action-কে full agent workflow-এ পাঠায়, safe tool-এর জন্য deterministic shortcut দেয় না, tool schema ও capability planning critical path-এ রাখে এবং simple task-এর জন্য short execution budget সংজ্ঞায়িত করেনি।

তাই “hello world Python script তৈরি করো” request-এ Miki-এর উচিত ছিল একটি bounded file operation চালিয়ে কয়েক সেকেন্ডে ফলাফল দেওয়া। বর্তমান implementation-এ requestটি আগে model-selected task হয়ে যায়। একই কারণে shell, plugins, web search এবং working response-এর behavior একরকম নয়।

সার্বিকভাবে, প্রথমে P0-এর deterministic action lane এবং one-shot task contract বাস্তবায়ন না করলে prompt, model বা UI tuning করে সমস্যার স্থায়ী সমাধান হবে না।

## References

[1]: https://github.com/glayph/agent "Agent Miki source repository"

বর্তমান source-এর প্রধান evidence files হলো `packages/core/src/agent.ts`, `packages/core/src/task-profile.ts`, `packages/core/src/execution-pipeline.ts`, `packages/core/src/deterministic-intent.ts`, `packages/core/src/adaptive-capability-selector.ts`, `packages/core/src/tool-call-parallelism.ts` এবং `packages/core/src/web-search-service.ts`।

**Author:** Manus AI
