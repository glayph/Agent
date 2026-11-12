# Miki: ১০ ধাপের বাস্তবায়ন রোডম্যাপ

**অবস্থা যাচাই:** ৮ নভেম্বর ২০২৬  
**কাজের ধরন:** বিদ্যমান সক্ষমতা যাচাই করে অগ্রাধিকারভিত্তিক উন্নয়ন; কোনো provider key বা credential পরিবর্তন করা হয়নি।

## বর্তমান যাচাইকৃত অবস্থা

- Dashboard-এর Models API-তে একটি stored default model পাওয়া গেছে: provider `gemini`, model `models/gemini-3.1-flash-lite`; resolver `configured: true`, key status `valid`, key উপস্থিত। কোনো secret value এই নথিতে রাখা হয়নি।
- Activity পেজ আগে Gemini rate-limit/quota failure দেখিয়েছিল। এটি provider-এর quota/rate limit; কোড দিয়ে তা পাশ কাটানো যায় না। Retry/backoff চালু আছে। Activity পেজের আগের scheduled “No model configured” ত্রুটিগুলো পুনরায় চালুর পর completed হিসেবে দেখা গেছে; বর্তমানে model-resolution mismatch পুনরুৎপাদন করা যায়নি।
- Always-active idle lane চালু এবং quiet-environment interval ৫ সেকেন্ড। অর্থাৎ Miki-এর periodic decision loop ইতিমধ্যেই আছে; এটি প্রতি মুহূর্তে অবিরাম generation নয়।
- `npm run dev` ২৪/৭ supervisor-সহ gateway চালায়, task recovery সমর্থিত। তবে sandbox-এ service বন্ধ হয়ে যাওয়ার ঘটনা হয়েছে; দীর্ঘস্থায়ী ২৪/৭ uptime-এর জন্য স্থায়ী host/deployment দরকার।
- `docs/structure/03-core-engine.md`-এ উল্লেখিত কাজের মধ্যে model resolution, provider retries, durable tasks, human approval এবং supervisor recovery আগে থেকেই আছে। এগুলোকে নতুন করে বানানোর বদলে regression test ও সঠিক configuration দিয়ে যাচাই করতে হবে।

## ১০ ধাপ

| ধাপ | সীমাবদ্ধতা/লক্ষ্য | বাস্তবায়নের কাজ | গ্রহণযোগ্যতার মাপকাঠি | অবস্থা |
|---|---|---|---|---|
| ১ | কাজের পরিধি ও সক্ষমতা | agent status-এ “কী করেছে / কী পারেনি / কী অনুমান” আলাদা দেখানো; capability claim-এ evidence যুক্ত করা | UI-তে observed, inferred, unavailable ফল পৃথক; প্রমাণহীন কাজকে সম্পন্ন বলা যাবে না | আর্কিটেকচার যাচাই বাকি |
| ২ | ধারাবাহিক digital operation | স্থায়ী host-এ supervisor চালানো; shutdown/restart-এ durable task recovery যাচাই; idle cadence configurable রাখা | gateway crash/restart-এর পর queued task হারাবে না; liveness probe ও recovery test pass | supervisor আছে; sandbox স্থায়িত্ব অনিশ্চিত |
| ৩ | LLM/model/API reliability | default model নির্বাচনের integration test; 429/`Retry-After`-এ backoff; একাধিক model/provider থাকলে explicit fallback; Activity-তে quota এবং configuration error আলাদা | configured default chat ও scheduled run-এ resolve হবে; API key প্রকাশ হবে না; rate-limit হলে চেষ্টার বিরতি ও কারণ দেখা যাবে | resolver সঠিক; Gemini quota সীমা বাহ্যিক |
| ৪ | সাম্প্রতিক তথ্য | browsing/API tool-এ উৎস, retrieval timestamp ও freshness সংরক্ষণ; offline হলে তা স্পষ্ট করা | সময়-সংবেদনশীল উত্তরে যাচাইয়ের সময় ও উৎস থাকবে, না থাকলে অনিশ্চয়তা জানাবে | সক্ষমতা/coverage audit বাকি |
| ৫ | hallucination | answer/tool evidence মিলিয়ে যাচাই; গুরুত্বপূর্ণ দাবিতে confidence ও উৎস; পরীক্ষার dataset-এ unsupported claim মাপা | test set-এ বানানো source/কাজের দাবি শনাক্ত; tool failure-কে success বলা যাবে না | verifier আছে; default disabled, audit বাকি |
| ৬ | গোপনীয়তা ও নিরাপত্তা | vault, log redaction, auth strength, deployment exposure এবং backup/restore পরীক্ষা | secret log/API response-এ অনুপস্থিত; authentication test pass; recovery নির্দেশনা যাচাইকৃত | vault/credential redaction আছে; public UI-তে শক্তিশালী password প্রয়োজন |
| ৭ | জটিল/উচ্চ-প্রভাব সিদ্ধান্ত | reversible বনাম high-impact কাজের approval path ও audit history যাচাই | approval-required কাজ সম্মতি ছাড়া সম্পন্ন নয়; cancel/owner control কার্যকর | বিদ্যমান approval path-এর coverage audit বাকি |
| ৮ | ফাইল ও software/tool ব্যবহার | file-type coverage, sandbox/permission boundaries, timeout/cancel ও result validation পরীক্ষা | unsupported/risky operation নিরাপদভাবে প্রত্যাখ্যাত বা অনুমোদন চায়; ফলাফল যাচাইযোগ্য | tool catalog/security audit বাকি |
| ৯ | দীর্ঘমেয়াদি memory | memory retrieval, user control, correction/deletion এবং stale/contradictory fact handling পরীক্ষা | user-এর অনুরোধে স্মৃতি দেখা/সংশোধন/মুছতে পারে; পুরোনো তথ্যকে নিশ্চিত সত্য ধরে না | memory engine আছে; UX/retention audit বাকি |
| ১০ | সৃজনশীলতা ও মূল্যায়ন | multi-option planning, revision workflow এবং regression benchmark | একই task-এ ভিন্ন বিকল্প দিতে পারে; quality/safety/latency regression পরীক্ষায় পরিমাপ হয় | benchmark ও acceptance baseline বাকি |

## বাস্তবায়নের ক্রম

1. **প্রথমে reliability verification:** model resolution, retry, 24/7 recovery ও dashboard status-এ regression tests; Gemini quota পৃথক external constraint হিসেবে চিহ্নিত।
2. **তারপর evidence quality:** live-source citation ও hallucination-evaluation tests।
3. **এরপর user-data controls:** secret handling, password/deployment configuration, memory controls।
4. **সবশেষে feature coverage:** tool/file capability, approval UX, creative workflow ও benchmark।

## বর্তমান সীমা

কোনো সফটওয়্যার বাস্তব শরীর বা মানুষের মতো অনুভূতি দিতে পারে না। প্রশিক্ষণের জ্ঞান নিজে থেকে তাৎক্ষণিকভাবে বদলায় না; live data source যোগ করে সাম্প্রতিক তথ্য পাওয়া যায়। Provider-এর quota, network outage বা sandbox বন্ধ হয়ে যাওয়া application code একা দূর করতে পারে না। “সবসময় সক্রিয়” বলতে supervisor ও event/schedule-ভিত্তিক পুনরায় জাগা বোঝাবে—অনিয়ন্ত্রিতভাবে প্রতিনিয়ত LLM call করা নয়।

## Maintenance and status note

This is a dated investigation, plan, or implementation snapshot. Its findings and status labels describe the code and test evidence available when it was written; they are not a live assertion that every item remains current. Preserve this report as historical context. For present behavior, check the current source, the adjacent tests, and [Agent-Miki Operating Model](AGENT_MIKI_OPERATING_MODEL.md) where applicable. Do not treat an unverified recommendation or an old checklist as proof of an enabled capability.
