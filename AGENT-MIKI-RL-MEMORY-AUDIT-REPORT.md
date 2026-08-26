# Agent Miki — Reinforcement Learning ও Memory System Audit Report

**পর্যালোচনার ধরন:** Source audit, automated verification, runtime smoke test এবং dashboard UI verification  
**পর্যালোচিত branch/commit:** `main` / `620a778`  
**পর্যালোচনার তারিখ:** 26 August 2026 (sandbox runtime)

## Executive summary

Agent Miki বর্তমানে একটি কার্যকর local-first agent runtime, dashboard, SQLite-backed memory pipeline এবং provider test path হিসেবে চালু হয়েছে। সম্পূর্ণ build, automated verification, memory integration tests, frontend tests এবং 24/7 readiness check সফল হয়েছে। Gemini provider connectivity test সফল হয়েছে এবং একটি সাধারণ chat task সফলভাবে `4` ফিরিয়েছে। তবে exact-string smoke task সফল হয়নি; run নিরাপদে থেমে গিয়ে final answer তৈরি করতে পারেনি। এটি provider key invalid হওয়ার প্রমাণ নয়; এটি agent-loop reliability বা orchestration-এর পৃথক সমস্যা।

সবচেয়ে গুরুত্বপূর্ণ audit finding হলো, repository-তে **বাস্তব reinforcement learning engine নেই**। `SelfImprovementEngine`-এ configuration flag ও API surface আছে, কিন্তু due checks সবসময় `false`, cycle methods `null` ফেরায়, learning statistics শূন্য থাকে, এবং behavior learning status hard-coded `disabled/observe` থাকে। আরও গুরুত্বপূর্ণ, engine-টি একটি ephemeral `new Database(":memory:")` এবং no-op `saveFact`, `searchKeyword`, `upsertProfile` adapter পায়; durable `@miki/memory` runtime আলাদা subsystem হিসেবে চালু হয়। ফলে self-improvement অংশ durable memory, experience history বা reward history-র সঙ্গে বাস্তবে সংযুক্ত নয়।

অন্যদিকে, memory system বাস্তবভাবে কাজ করছে। Runtime database-এ events, entities, selective chunks, graph edges এবং retrieval trace লেখা হয়েছে; Memory dashboard-এ 5 active chunks, 80 postings, 10 graph edges এবং 1 retrieval trace দেখা গেছে। এটি **heuristic/lexical selective retrieval ও graph reinforcement**, reinforcement learning নয়।

## Verified runtime results

| পরীক্ষা | ফল | প্রমাণ |
|---|---:|---|
| `npm install` | সফল | Dependency installation completed; Node 22.13.0-সংক্রান্ত non-blocking `undici` engine warning ছিল |
| `MIKI_LLAMA_BUILD_JOBS=1 npm run build:all` | সফল | llama.cpp/runtime, workspaces এবং frontend build সম্পন্ন |
| `npm start` | সফল | Memory stub 18700, core 8000 এবং gateway 18800 চালু |
| Gemini connectivity test | সফল | UI-তে 383 ms, completion verification, ready status |
| Exact-string chat smoke task | ব্যর্থ | Run safe stop করেছে; final answer তৈরি হয়নি |
| Simple arithmetic chat task | সফল | `What is 2+2?` → `4` |
| `npm test` | সফল | Memory ও frontend suite সহ সব test pass |
| `npm run verify` | সফল | Lint, typecheck, build, tests ও doctor workflow pass |
| `npm run runtime:24-7:check` | সফল | `ok: true`; gateway entrypoint, restart policy ও readiness timeout valid |
| Memory UI | সফল | 5 chunks, 80 postings, 10 graph edges, 1 retrieval trace |
| Agent Control UI | সফল | Typed bounded controls, sanitized state ও active Gemini model দৃশ্যমান |

`npm run verify`-এর doctor output-এ Go CLI অনুপস্থিতির warning ছিল, যা optional capability। একই doctor environment-only credential check-এ Gemini credential দেখতে পায়নি, যদিও dashboard vault test ও Gemini chat completion সফল হয়েছে। এই দুই check ভিন্ন credential path যাচাই করে; তাই warning-টিকে provider failure হিসেবে গণ্য করা হয়নি।

## Reinforcement learning audit

### বর্তমান implementation-এর অবস্থা

`packages/core/src/self-improvement/engine.ts` ফাইলটিই self-improvement directory-র একমাত্র runtime implementation। Constructor শুধু `enabled` flag গ্রহণ করে। `_reflectionDue()`, `_tuningDue()` এবং `_optimizationDue()` সবসময় `false` ফেরায়। `runReflectionCycle()`, `runOptimizationCycle()` এবং `runPromptTuningCycle()` সবসময় `null` ফেরায়। `getLearningStats()` শূন্য counters ও খালি rewards দেয়, এবং `getStatus()`-এর behavior-learning block hard-coded `enabled: false`, `mode: "observe"`। ফলে configuration-এ feature enabled থাকলেও runtime-এ কোনো learning cycle শুরু হয় না। [1]

`config/agent.yaml`-এ reflection, optimization, prompt tuning, guardrail এবং behavior-learning fields আছে। Configuration schema-ও এসব field validate করে। কিন্তু engine-এর `SelfImprovementConfig` interface-এ `enabled` ছাড়া interval, reward, guardrail বা behavior-learning configuration ব্যবহার করার field নেই। অর্থাৎ config acceptance এবং runtime behavior-এর মধ্যে স্পষ্ট implementation gap আছে। [2] [3]

Heartbeat প্রতি 30 সেকেন্ডে idle অবস্থায় self-improvement methods call করার চেষ্টা করে, কিন্তু engine-এর due methods সবসময় `false` হওয়ায় কোনো cycle চলে না। Force endpoints-ও no-op cycle-কে API surface-এ প্রকাশ করে; cycle `null` হওয়ায় endpoint-এর `success` false হওয়া উচিত। [4] [5]

### Memory connection-এর মূল বিচ্ছিন্নতা

`packages/core/src/agent.ts`-এ self-improvement engine-কে `new Database(":memory:")` দেওয়া হয়েছে। একই adapter-এর `saveFact`, `searchKeyword` এবং `upsertProfile` methods no-op। এর বিপরীতে durable memory `initMemory(dataDir)` দিয়ে আলাদা `agent-memory.db`-তে initialize হয়। তাই self-improvement engine কোনো durable experience, reflection, reward বা tuning record সংরক্ষণ করতে পারে না; restart-এর পর state রাখার সুযোগও নেই। [6]

এই finding-এর অর্থ হলো, বর্তমান repository-তে RL-এর জন্য নাম, config, status এবং endpoint আছে, কিন্তু **experience collection, reward computation, policy update, exploration/exploitation, persistent state বা approved policy application নেই**। Memory package-এর entity access reinforcement এবং edge-weight reinforcement শব্দের ব্যবহারকে RL হিসেবে গণ্য করা যাবে না; সেগুলো deterministic memory-strengthening heuristic।

### Documentation drift

`docs/Structure/Core.md`-এ `reflector.ts`, `optimizer.ts`, `reward.ts`, `behavior-policy.ts`, `analyzer.ts`, `ab-test-framework.ts` এবং `change-audit.ts`-এর মতো modules documented আছে, কিন্তু বর্তমান source tree-তে self-improvement directory-তে কেবল `engine.ts` আছে। Documentation-টি planned বা historical architecture হিসেবে চিহ্নিত না করলে implementation completeness সম্পর্কে ভুল ধারণা তৈরি হবে। [7]

## Memory system audit

Memory package একটি single SQLite database, WAL mode, temporal knowledge graph, selective memory index, inverted postings, bounded graph edges, retrieval trace, working-memory anchor এবং consolidation daemon ব্যবহার করে। `AgentMemoryIntegration` pre-execution-এ anchor, special events, selective context ও graph context একত্র করে এবং post-execution-এ user/assistant/tool records লিখে। [8] [9]

Runtime evidence থেকে দেখা যায় যে দু’টি user message, capability-plan records এবং failed assistant response durable `events` ও `memory_chunk_index`-এ লেখা হয়েছে। Runtime DB-তে 5 events, 50 entities, 5 selective chunks এবং 1 retrieval trace পাওয়া গেছে। Memory UI-তে একই state-এর visual rendering পাওয়া গেছে। ফলে basic persistence, retrieval trace এবং dashboard observability বাস্তবভাবে কাজ করছে।

Selective retrieval lexical score, optional embedding similarity, freshness, importance, confidence, region boost, graph traversal এবং token budget ব্যবহার করে। Runtime trace-এ `semanticEnabled: false` ছিল, কারণ configured embedding provider সক্রিয় ছিল না; তাই বর্তমান test path lexical retrieval-নির্ভর। এটি low-cost ও offline-first design-এর সঙ্গে সামঞ্জস্যপূর্ণ, তবে semantic retrieval বা learned ranking দাবি করা যাবে না। [10]

একটি design concern হলো scope propagation। `preExecutionHook()` scope গ্রহণ করতে পারে, কিন্তু `getEnhancedSystemPrompt(userMessage)` default scope-এ hook চালায় এবং core agent এটিকে user message দিয়েই call করে। Session ID event metadata-এ যায়, কিন্তু default memory scope-এ session/agent/owner/workspace isolation আলাদা করা হয় না। Single local workspace-এর জন্য এটি গ্রহণযোগ্য হতে পারে; multi-agent বা multi-owner deployment-এর আগে explicit scope contract এবং isolation tests প্রয়োজন। [9]

আরেকটি গুরুত্বপূর্ণ safeguard হলো memory-তে secret redaction ও bounded prompt context ইতিমধ্যে আছে। Future RL/reflection data এই একই redaction, provenance, confidence এবং token-budget path ব্যবহার না করলে learning records নিজেই prompt-poisoning বা credential leakage-এর উৎস হতে পারে।

## প্রধান সমস্যা ও অগ্রাধিকার

| অগ্রাধিকার | সমস্যা | বর্তমান প্রমাণ | প্রস্তাবিত দিক |
|---:|---|---|---|
| P0 | Self-improvement engine সম্পূর্ণ no-op | তিনটি due method `false`, cycle methods `null` | Durable engine, real state machine, tests ও truthful API |
| P0 | RL engine ephemeral no-op memory পায় | `new Database(":memory:")` ও no-op adapter | Durable TKG/memory adapter ও scoped experience store |
| P0 | Config enabled হলেও runtime interval/behavior fields ব্যবহার করে না | Schema fields আছে; engine interface-এ নেই | Config-to-runtime mapping ও validation test |
| P1 | No reward/experience/policy persistence | কোনো tables বা update path নেই | Contextual bandit-first bounded learning design |
| P1 | Force API no-op ফল প্রকাশ করে | `null` result থেকে false success | Structured result, error, run ID, idempotency |
| P1 | Documentation/source drift | Docs-এ বহু অনুপস্থিত module | Docs update অথবা planned status স্পষ্ট করা |
| P1 | Scope propagation অসম্পূর্ণ | prompt hook default scope ব্যবহার করে | Explicit `MemoryScope` per run/task |
| P2 | Exact-string Gemini task safe-stop করেছে | UI ও Inspector-এ verified | Agent-loop retry/error classification ও end-to-end regression test |
| P2 | Model credential card association পুনরায় যাচাই প্রয়োজন | UI-তে একাধিক card-এ একই redacted marker | Provider/model-scoped vault regression test; raw key কখনও log নয় |
| P2 | Semantic retrieval active নয় | Trace-এ `semanticEnabled: false` | Optional embedding health indicator; lexical fallback বজায় রাখা |

## সিদ্ধান্ত

বর্তমান memory system **প্রাথমিক runtime ব্যবহারের জন্য কার্যকর**, কিন্তু এটি RL memory বা learned policy memory নয়। বর্তমান self-improvement implementation **শুধু façade/API contract**; production reinforcement learning হিসেবে ব্যবহার করা যাবে না। তাই source code-এ অসুরক্ষিতভাবে partial RL যোগ না করে bounded, auditable, contextual-bandit-first implementation করা উচিত। প্রথম release-এ model-weight training বা autonomous code mutation না করে run outcome থেকে route/model/prompt-choice-এর মতো সীমিত decision শেখানো নিরাপদ ও low-cost হবে।

এই audit-এর ভিত্তিতে Agent Miki-কে বাস্তব implementation দেওয়ার জন্য পৃথক বিস্তারিত prompt প্রস্তুত করা হয়েছে। Prompt-এ durable schema, memory coupling, reward design, policy modes, safety gates, cross-platform constraints, tests এবং acceptance criteria নির্দিষ্ট করা আছে। [11]

## References

[1]: https://github.com/glayph/agent/blob/620a778/packages/core/src/self-improvement/engine.ts "SelfImprovementEngine source"

[2]: https://github.com/glayph/agent/blob/620a778/config/agent.yaml "Agent runtime configuration"

[3]: https://github.com/glayph/agent/blob/620a778/packages/config/src/schema.ts "Runtime configuration schema"

[4]: https://github.com/glayph/agent/blob/620a778/packages/core/src/heartbeat.ts "Heartbeat scheduler"

[5]: https://github.com/glayph/agent/blob/620a778/packages/core/src/api/index.ts "Self-improvement API endpoints"

[6]: https://github.com/glayph/agent/blob/620a778/packages/core/src/agent.ts "Core agent initialization and memory wiring"

[7]: https://github.com/glayph/agent/blob/620a778/docs/Structure/Core.md "Documented core structure"

[8]: https://github.com/glayph/agent/blob/620a778/packages/memory/README.md "Memory package architecture"

[9]: https://github.com/glayph/agent/blob/620a778/packages/memory/src/agent-memory-integration.js "Agent-memory integration hooks"

[10]: https://github.com/glayph/agent/blob/620a778/packages/memory/src/selective-memory-engine.js "Selective memory retrieval engine"

[11]: https://github.com/glayph/agent/blob/620a778/README.md "Agent Miki project overview and verification notes"
