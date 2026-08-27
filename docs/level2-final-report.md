# Agent Miki — Level 2 Final Web UI Test Report

## পরীক্ষার পরিধি

এই রিপোর্টে Agent Miki-এর **Level 2 — Computer Tasks**-এর ৯টি capability পরীক্ষা করা হয়েছে। প্রতিটি test Agent Miki Web UI থেকে চালানো হয়েছে এবং run header-এ local `llama.cpp / llama.cpp/gemma-4-E2B-it_Q4_0` model identity দেখা গেছে। Gemini, LFM, cloud model বা অন্য কোনো answer model ব্যবহার করা হয়নি। Shell/source inspection কেবল Web UI-তে Miki-এর দাবি যাচাই করার জন্য ব্যবহৃত হয়েছে; shell-only কাজকে pass ধরা হয়নি।

> কঠোর নিয়ম: Web UI tool trace, প্রত্যাশিত ফল, verification এবং independent cross-check—সবগুলো না থাকলে কোনো capability-কে ১০০% নিখুঁত বলা হয়নি।

## সারসংক্ষেপ

| ফলাফল | সংখ্যা | অর্থ |
|---|---:|---|
| **১০০% নিখুঁতভাবে verified** | ২/৯ | Web UI execution, expected output এবং cross-check সম্পূর্ণ মিলেছে। |
| **চেষ্টা করেছে, কিন্তু ১০০% নয়** | ৬/৯ | আংশিক execution বা artifact পাওয়া গেছে, কিন্তু exactness, complete trace, verification, বা reliability-এর শর্ত অসম্পূর্ণ। |
| **০% verified / failed** | ১/৯ | Observable Web UI execution evidence পাওয়া যায়নি। |

## ১০০% নিখুঁতভাবে সম্পন্ন capability

| ID | Capability | প্রমাণিত ফল |
|---|---|---|
| **L2-01** | Terminal command চালানো | Web UI shell tool দিয়ে নির্দিষ্ট `printf` command চালানো হয়েছে এবং exact stdout `MIKI_L2_TERMINAL_OK` ও সফল completion trace পাওয়া গেছে। |
| **L2-05** | System information সংগ্রহ | Web UI shell result থেকে `Linux`, kernel `6.1.102` এবং Node.js `v22.13.0` সঠিকভাবে report করা হয়েছে। |

## চেষ্টা করেছে, কিন্তু ১০০% নয়

| ID | Capability | বর্তমান ফল ও সীমাবদ্ধতা |
|---|---|---|
| **L2-02** | Program চালানো | `program.sh` তৈরি ও executable artifact পাওয়া গেছে, কিন্তু complete Web UI create → execute → exact stdout → exit-status trace নির্ভরযোগ্যভাবে পাওয়া যায়নি। প্রথমে service-unavailable এবং পরে working-directory/path সমস্যা দেখা গেছে। |
| **L2-03** | Process খুঁজে বের করা | Web UI-তে PID `20146` এবং Gemma `llama-server` command report করা হয়েছে এবং independent process check-এর সঙ্গে মিলেছে। তবে visible final response-এ exact numeric exit status ছিল না। |
| **L2-06** | CPU/RAM/Disk পরীক্ষা | Multi-command resource query-তে Web UI final shell output আসেনি; 180000 ms পরে actionable local AI timeout দেখিয়েছে। তাই resource values গ্রহণ করা হয়নি। |
| **L2-07** | Log পড়া ও সমস্যা শনাক্ত করা | Web UI বলেছে শেষ পাঁচটি log line পড়েছে এবং কোনো error নেই; visible text-এ প্রথম line-এর অংশ দেখা গেছে। কিন্তু পাঁচটি line-এর সম্পূর্ণ exact output দৃশ্যমান না হওয়ায় strict 100% pass নয়। |
| **L2-08** | Configuration পরিবর্তন করা | Web UI final content `mode=after` এবং exit status `0` report করেছে; independent check-এ disposable config file-ও একই content পেয়েছে। কিন্তু strict matrix-এর syntax validation ও changed-behavior check করা হয়নি। |
| **L2-09** | Software/package install করা | Disposable workspace-এ `is-number@7.0.0`-এর manifest, lockfile ও `node_modules` artifact পাওয়া গেছে এবং independent `npm ls` version মিলেছে। কিন্তু complete Web UI install trace, exact Node verification output এবং rollback/cleanup evidence অনুপস্থিত। |

## ০% verified / failed capability

| ID | Capability | কারণ |
|---|---|---|
| **L2-04** | Process বন্ধ করা | Disposable `sleep` process terminate করার জন্য দুইটি Web UI attempt করা হলেও required shell tool result, PID, signal status এবং completion marker পাওয়া যায়নি। Miki planning/feedback-style response দিয়েছে; process stop সফল হয়েছে বলে গ্রহণযোগ্য evidence নেই। |

## শনাক্ত সমস্যা

প্রথমত, CPU-only local Gemma runtime-এ বড় prompt, tool schema এবং একাধিক shell command একসঙ্গে পাঠালে generation দীর্ঘ হয়। Resource pipeline test-এ configured 180-second timeout স্পষ্টভাবে reproduce হয়েছে। দ্বিতীয়ত, কয়েকটি run-এ llama.cpp service সাময়িক unavailable হয়েছে অথবা agent shell command-এর working directory/path সঠিকভাবে ব্যবহার করতে পারেনি। তৃতীয়ত, process-control ও package-install test-এ Miki shell tool call করার বদলে planning/feedback-style prose দিয়েছে, ফলে observable execution trace অসম্পূর্ণ হয়েছে।

## পূর্বে প্রয়োগ করা remediation-এর অবস্থা

Stale llama.cpp readiness cache-এর সমস্যা সংশোধন করা হয়েছে: live probe ব্যর্থ হলে stale ready state clear হয় এবং readiness কেবল environment URL দেখে successful ধরা হয় না। Local timeout message-ও model, configured duration, cancellation এবং সম্ভাব্য CPU/context কারণ উল্লেখ করে। Runtime cross-check-এ একটি মাত্র Gemma server, core এবং gateway process দেখা গেছে। তবে CPU-only Gemma-এর দীর্ঘ multi-command orchestration limitation এখনও আছে; এটিকে ১০০% capability pass হিসেবে গোপন করা হয়নি।

## Evidence files

প্রতিটি capability-এর বিস্তারিত evidence আলাদা docs file-এ রাখা হয়েছে: [L2-01](level2-l2-01-evidence.md), [L2-02](level2-l2-02-evidence.md), [L2-03](level2-l2-03-evidence.md), [L2-04](level2-l2-04-evidence.md), [L2-05](level2-l2-05-evidence.md), [L2-06](level2-l2-06-evidence.md), [L2-07](level2-l2-07-evidence.md), [L2-08](level2-l2-08-evidence.md), এবং [L2-09](level2-l2-09-evidence.md)। Test standard রয়েছে [Level 2 test plan](level2-test-plan.md) এবং [capability matrix](agent-miki-capability-test-matrix.md)-এ।

## Final verdict

বর্তমান local Gemma 4 E2B Web UI environment-এ Level 2-এর **২টি capability কঠোরভাবে ১০০% verified**, **৬টি capability আংশিকভাবে কাজ করেছে কিন্তু ১০০% নয়**, এবং **১টি capability-র observable execution evidence ০%**। অতএব Agent Miki Level 2 সম্পূর্ণভাবে “অনায়াসে” করতে পারে—এমন দাবি এই evidence সমর্থন করে না।

পরবর্তী remediation-এর প্রধান অগ্রাধিকার হওয়া উচিত: shell tool invocation reliability, multi-command prompt ভেঙে ছোট deterministic steps-এ execution, process-control-এর জন্য strict tool-call enforcement, এবং package/config task-এর complete verification ও cleanup workflow।
