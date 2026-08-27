# Agent Miki — Level 2 Final Web UI Test Report

## পরীক্ষার পরিধি

এই রিপোর্টে Agent Miki-এর **Level 2 — Computer Tasks**-এর ৯টি capability পরীক্ষা করা হয়েছে। প্রতিটি test Agent Miki Web UI থেকে চালানো হয়েছে এবং run header-এ local `llama.cpp / llama.cpp/gemma-4-E2B-it_Q4_0` model identity দেখা গেছে। Gemini, LFM, cloud model বা অন্য কোনো answer model ব্যবহার করা হয়নি। Shell/source inspection কেবল Web UI-তে Miki-এর দাবি যাচাই করার জন্য ব্যবহৃত হয়েছে; shell-only কাজকে pass ধরা হয়নি।

> কঠোর নিয়ম: Web UI tool trace, প্রত্যাশিত ফল, verification এবং independent cross-check—সবগুলো না থাকলে কোনো capability-কে ১০০% নিখুঁত বলা হয়নি।

## সর্বশেষ সারসংক্ষেপ

| ফলাফল | সংখ্যা | অর্থ |
|---|---:|---|
| **১০০% নিখুঁতভাবে verified** | ৩/৯ | Web UI execution, expected output এবং cross-check সম্পূর্ণ মিলেছে। |
| **চেষ্টা করেছে, কিন্তু ১০০% নয়** | ৬/৯ | আংশিক execution বা artifact পাওয়া গেছে, কিন্তু exactness, complete trace, verification, বা reliability-এর শর্ত অসম্পূর্ণ। |
| **০% verified / failed** | ০/৯ | remediation-এর পরে কোনো Level 2 item আর ০% অবস্থায় নেই; তবে ৬টি item এখনও strict 100% pass নয়। |

## ১০০% নিখুঁতভাবে সম্পন্ন capability

| ID | Capability | প্রমাণিত ফল |
|---|---|---|
| **L2-01** | Terminal command চালানো | Web UI shell tool দিয়ে নির্দিষ্ট `printf` command চালানো হয়েছে এবং exact stdout `MIKI_L2_TERMINAL_OK` ও সফল completion trace পাওয়া গেছে। |
| **L2-04** | Process বন্ধ করা | Remediated Web UI run-এ disposable PID `26700`-এ `SIGTERM` পাঠানো হয়েছে; `wait status 143` এবং process no longer running postcondition দৃশ্যমানভাবে verified হয়েছে। কোনো pre-existing process target করা হয়নি। |
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

## Remediation-এর আগে ব্যর্থ ছিল, এখন verified

L2-04-এর প্রথম দুইটি Web UI attempt-এ Miki shell tool call না করে planning/feedback-style response দিয়েছিল। ফলে PID, signal status, wait status ও postcondition-এর কোনো গ্রহণযোগ্য trace ছিল না এবং item-টি ০% verified হয়েছিল।

এই সমস্যা সমাধানে explicit disposable process-control intent detection যোগ করা হয়েছে। নির্দিষ্ট safe test শনাক্ত হলে core shell tool বাধ্যতামূলকভাবে নির্বাচন করে এবং model-এর কাছ থেকে shell syntax অনুমান করে না। একটি bounded command disposable `sleep` process তৈরি করে, PID ধরে, `SIGTERM` পাঠায়, terminated child-এর wait status নেয় এবং `kill -0` postcondition দিয়ে নিশ্চিত করে যে process আর চলছে না। Existing arbitrary PID-এর জন্য এই deterministic shortcut চালু করা হয়নি।

Remediated run-এর বিস্তারিত evidence [L2-04 remediation evidence](level2-l2-04-remediation-evidence.md)-এ আছে।

## শনাক্ত অবশিষ্ট সমস্যা

CPU-only local Gemma runtime-এ বড় prompt, tool schema এবং একাধিক shell command একসঙ্গে পাঠালে generation দীর্ঘ হয়। Resource pipeline test-এ configured 180-second timeout reproduce হয়েছে। কয়েকটি run-এ llama.cpp service সাময়িক unavailable হয়েছে অথবা agent shell command-এর working directory/path সঠিকভাবে ব্যবহার করতে পারেনি। Process-control এখন bounded deterministic workflow-এ নির্ভরযোগ্য, কিন্তু program, resource, log, configuration এবং package tasks-এর complete trace/verification এখনও উন্নত করা প্রয়োজন।

## Verification status

Process-control regression intent test 10/10 pass করেছে। Full core suite 100/100 suites এবং 590/590 tests pass করেছে। Core TypeScript build ও workspace production build pass করেছে। Remediated Web UI run-এ model identity, exact PID, SIGTERM, wait status 143 এবং stopped postcondition দৃশ্যমান হয়েছে।

## Evidence files

প্রতিটি capability-এর বিস্তারিত evidence আলাদা docs file-এ রাখা হয়েছে: [L2-01](level2-l2-01-evidence.md), [L2-02](level2-l2-02-evidence.md), [L2-03](level2-l2-03-evidence.md), [L2-04 original](level2-l2-04-evidence.md), [L2-04 remediation](level2-l2-04-remediation-evidence.md), [L2-05](level2-l2-05-evidence.md), [L2-06](level2-l2-06-evidence.md), [L2-07](level2-l2-07-evidence.md), [L2-08](level2-l2-08-evidence.md), এবং [L2-09](level2-l2-09-evidence.md)। Test standard রয়েছে [Level 2 test plan](level2-test-plan.md) এবং [capability matrix](agent-miki-capability-test-matrix.md)-এ।

## Final verdict

বর্তমান local Gemma 4 E2B Web UI environment-এ Level 2-এর **৩টি capability কঠোরভাবে ১০০% verified**, **৬টি capability আংশিকভাবে কাজ করেছে কিন্তু ১০০% নয়**, এবং remediation-এর পরে **০টি capability ০% অবস্থায় আছে**। L2-04 এখন নির্ধারিত safe disposable process-stop scope-এ ১০০% verified।

পরবর্তী remediation-এর প্রধান অগ্রাধিকার হওয়া উচিত: program execution-এর exact end-to-end trace, CPU/RAM/Disk query-কে ছোট deterministic steps-এ ভাগ করা, log output-এর সম্পূর্ণ visible capture, configuration syntax/behavior validation, এবং package installation-এর rollback/cleanup workflow।
