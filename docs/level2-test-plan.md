# Agent Miki — Level 2 Computer Tasks Test Plan

## Scope

Level 2-এর ৯টি capability শুধু Agent Miki Web UI থেকে পরীক্ষা করা হবে। Answer model হিসেবে কেবল local `gemma-4-E2B-it_Q4_0` (llama.cpp) ব্যবহার করা হবে। Shell/source inspection কেবল Web UI-তে Miki যে execution বা result দাবি করবে তার independent cross-check; shell-only action কোনো pass evidence নয়।

## Isolated workspace

সব destructive বা state-changing test `/home/ubuntu/Agent/level2-webui-tests/`-এর disposable subfolder-এ হবে। Existing project বা runtime configuration অকারণে পরিবর্তন করা হবে না। Package installation-এর জন্য সম্ভব হলে disposable local package বা already-installed safe package ব্যবহার করা হবে এবং শেষে cleanup করা হবে। কোনো credential, token, password, hash বা secret evidence-এ লেখা হবে না।

## Capability acceptance gates

| ID | Capability | Required Web UI evidence |
|---|---|---|
| L2-01 | Terminal command চালানো | Miki shell tool দিয়ে safe command, exact stdout এবং successful completion |
| L2-02 | Program চালানো | Disposable program execution, deterministic output এবং exit status |
| L2-03 | Process খুঁজে বের করা | Target process query, PID ও command evidence |
| L2-04 | Process বন্ধ করা | Disposable long-running process বন্ধ; unrelated process অক্ষত |
| L2-05 | System information সংগ্রহ | OS/runtime/kernel তথ্য tool result-এ সঠিক report |
| L2-06 | CPU/RAM/Disk পরীক্ষা | Metrics output, values এবং restrained interpretation |
| L2-07 | Log পড়া ও সমস্যা শনাক্ত করা | Seeded disposable log থেকে error pattern, probable cause ও evidence |
| L2-08 | Configuration পরিবর্তন করা | Disposable config edit, syntax validation, read-back এবং behavior check |
| L2-09 | Software/package install করা | Safe small package/local dependency install, version check এবং cleanup/rollback evidence |

## Verdict rules

**১০০% নিখুঁত** হবে কেবল যখন Web UI trace-এ Miki নিজে সঠিক tool ব্যবহার, exact result, verification এবং independent cross-check সম্পূর্ণ করবে। **চেষ্টা করেছে, কিন্তু ১০০% নয়** হবে যখন execution আংশিক, result/verification অসম্পূর্ণ, বা reliability/material evidence দুর্বল। **০%** হবে যখন observable execution হয়নি, ভুল result হয়েছে, অথবা safe reproducible test-এ কার্যকর evidence পাওয়া যায়নি।

## Evidence record

প্রতিটি item-এর জন্য run/session, visible model identity, exact prompt, observed Web UI trace, artifacts, independent cross-check, verdict এবং failure/root cause রাখা হবে। একটি capability-এর কোনো sub-check অসম্পূর্ণ থাকলে সেটিকে ১০০% pass বলা হবে না।
