# Agent Miki-এর জন্য বিস্তারিত Implementation Prompt

## ভূমিকা ও verified baseline

তুমি Agent Miki repository-তে একটি bounded, auditable এবং low-cost self-improvement layer বাস্তবায়ন করবে। বর্তমান source audit-এ প্রমাণিত হয়েছে যে `packages/core/src/self-improvement/engine.ts` একটি no-op façade: due checks সবসময় `false`, reflection/optimization/prompt-tuning cycle সবসময় `null`, learning stats শূন্য, এবং behavior-learning status hard-coded `enabled: false`/`observe`। `packages/core/src/agent.ts` self-improvement engine-কে `new Database(":memory:")` এবং no-op `saveFact`, `searchKeyword`, `upsertProfile` adapter দেয়; durable memory আলাদা `@miki/memory` subsystem-এ `agent-memory.db` ব্যবহার করে। `config/agent.yaml` ও `packages/config/src/schema.ts`-এ যে interval, guardrail এবং behavior-learning fields আছে, engine সেগুলো ব্যবহার করে না।

এই gap সমাধান করো, কিন্তু model-weight training, unrestricted autonomous code mutation, arbitrary package installation অথবা external side effect চালু করো না। প্রথম release-এ **contextual-bandit-style decision learning** যথেষ্ট। Learned decision শুধু model/route/prompt strategy/tool plan-এর মতো bounded choices-এর মধ্যে থাকবে এবং default mode `observe` হবে।

## প্রধান লক্ষ্য

একটি durable self-improvement subsystem তৈরি করো যা:

1. প্রতিটি relevant agent run-এর context, chosen action, outcome, reward, policy version, scope এবং provenance সংরক্ষণ করবে।
2. বাস্তব `@miki/memory` bridge-এর সঙ্গে যুক্ত থাকবে; কোনো ephemeral `:memory:` DB বা no-op memory adapter ব্যবহার করবে না।
3. configured interval ও idle heartbeat অনুযায়ী reflection, optimization এবং prompt-tuning cycle সত্যিই চালাবে।
4. একই input/run পুনরায় process করলে duplicate learning বা duplicate application না ঘটিয়ে idempotent থাকবে।
5. `observe`, `draft`, `apply` mode-এর safety boundary মানবে; `apply`-এও কেবল allow-listed reversible configuration/policy change গ্রহণ করবে।
6. সব decision, reward, proposal, approval, application, rejection এবং rollback operation journal-এ auditable রাখবে।

## Architecture requirements

### 1. Durable schema

`agent-memory.db`-এর existing migration style অনুসরণ করে additive migration তৈরি করো। Table নাম project convention-এর সঙ্গে সামঞ্জস্যপূর্ণ রাখো; প্রয়োজনে নিচের logical entities বাস্তবায়ন করো:

| Entity | ন্যূনতম fields |
|---|---|
| `learning_experiences` | `id`, `scope_key`, `run_id`, `session_id`, `task_class`, `context_hash`, `action_key`, `action_payload_redacted`, `outcome`, `reward`, `reward_components`, `model_id`, `policy_version`, `created_at`, `idempotency_key` |
| `learning_policy_state` | `scope_key`, `policy_version`, `mode`, `action_stats`, `total_decisions`, `average_reward`, `updated_at` |
| `improvement_proposals` | `id`, `scope_key`, `kind`, `base_version`, `proposal_payload_redacted`, `evidence_ids`, `status`, `drift_percent`, `created_at`, `applied_at` |
| `improvement_cycles` | `id`, `cycle_type`, `scope_key`, `started_at`, `completed_at`, `status`, `input_count`, `output_count`, `error_redacted` |

প্রতিটি table-এ scope isolation, foreign-key বা referential checks, bounded payload size এবং প্রয়োজনীয় indexes রাখো। Secret redaction-এর পরে payload persist করো। Raw prompt, API key, token, password, credential, filesystem secret বা private chain-of-thought persist করা যাবে না।

### 2. Real memory adapter

`SelfImprovementEngine`-এর constructor-এ real `AgentMemoryIntegration` বা narrow typed adapter inject করো। Adapter-এর অন্তত নিম্নলিখিত operation থাকতে হবে:

- experience write/read;
- scoped recent experiences query;
- reward summary query;
- proposal write/read/update;
- policy state read/write;
- cycle journal write;
- existing memory redaction/provenance utilities reuse।

`packages/core/src/agent.ts`-এ `new Database(":memory:")` self-improvement state সরিয়ে durable runtime memory ব্যবহার করো। `initMemory(dataDir)`-এর initialization order বজায় রাখো, যাতে first turn race না হয়। Memory initialization ব্যর্থ হলে agent start করার defensive behavior বজায় থাকবে, কিন্তু self-improvement status-এ `degraded` ও কারণ প্রকাশ করতে হবে; silently fake success দেখানো যাবে না।

প্রতিটি run-এ explicit `MemoryScope` (`agentId`, `ownerId`, `workspaceId`) এবং `runId`/`taskId` pass করো। `getEnhancedSystemPrompt()`-এর মতো default-scope path দিয়ে অন্য owner বা workspace-এর experience retrieve করা যাবে না।

### 3. Reward design

প্রথম release-এ deterministic, bounded এবং explainable reward ব্যবহার করো। উদাহরণস্বরূপ:

```text
reward = clamp(
  0.35 * completion_quality
+ 0.25 * task_success
+ 0.15 * user_feedback
+ 0.10 * verification_success
+ 0.10 * latency_score
- 0.15 * retry_or_error_penalty
- 0.10 * safety_violation_penalty,
-1,
1
)
```

প্রতিটি component আলাদাভাবে persist করো এবং missing signal-এ neutral value ব্যবহার করো। LLM নিজে নিজের reward একক authority হিসেবে নির্ধারণ করবে না। User feedback অনুপস্থিত থাকলে reward falsely positive করা যাবে না। Failed বা safe-stopped run-কে successful completion হিসেবে record করা যাবে না।

### 4. Policy এবং exploration

Policy-টি প্রথমে contextual bandit বা weighted action statistics হিসেবে implement করো; Q-learning/actor-critic বা neural training যোগ করো না। `exploration_rate`, `min_samples`, `max_draft_notes` config fields বাস্তবে ব্যবহার করো। একই context-এ পর্যাপ্ত sample না থাকলে baseline action বেছে নাও। Exploration action-এর জন্য safety allow-list bypass করা যাবে না। Policy update atomic হতে হবে এবং policy version increment হতে হবে।

Policy mode semantics স্পষ্ট করো:

| Mode | Behavior |
|---|---|
| `observe` | সিদ্ধান্ত ও reward record করবে; action routing বদলাবে না |
| `draft` | candidate proposal তৈরি করবে; runtime behavior পরিবর্তন করবে না |
| `apply` | শুধু approved, bounded, reversible policy/config change প্রয়োগ করবে |

`auto_apply_optimizations: false` থাকলে কোনো proposal silently apply করা যাবে না। `apply` operation-এ owner approval, proposal hash, base policy version, one-time application, rollback snapshot এবং operation journal বাধ্যতামূলক।

### 5. Cycle implementation

`_reflectionDue()`, `_tuningDue()` এবং `_optimizationDue()` বাস্তব timestamp ও persisted cycle state দিয়ে নির্ধারণ করো। Config interval যথাক্রমে reflection, prompt tuning এবং optimization cycle-এ map করো। `max_reflections_per_day` enforce করো। Heartbeat-এর idle gate, circuit breaker এবং single-cycle lock বজায় রাখো। Concurrent heartbeat বা force endpoint duplicate cycle চালাতে পারবে না।

প্রতিটি cycle:

1. scope ও time window নির্ধারণ করবে;
2. bounded experiences এবং memory evidence পড়বে;
3. cycle journal-এ `started` record করবে;
4. deterministic analysis বা configured low-cost LLM call ব্যবহার করবে;
5. proposal/evidence/reward summary persist করবে;
6. apply না করলে draft status রাখবে;
7. success, skipped, degraded বা failed result structuredভাবে ফেরত দেবে;
8. শেষ হলে `completed_at`, counts এবং redacted error লিখবে।

LLM call ব্যর্থ হলে cycle crash না করে `degraded` বা `failed` structured result ফেরাবে। LLM output schema-validate করো; arbitrary code, shell command, URL, credential বা unrestricted file mutation proposal হিসেবে গ্রহণ করবে না।

### 6. Guardrails

`guardrails.enabled` এবং `max_prompt_drift_percent` বাস্তবে enforce করো। Prompt tuning proposal তৈরি হলে baseline prompt hash, candidate hash, changed sections, token delta এবং calculated drift persist করো। Drift threshold অতিক্রম করলে proposal reject বা manual-review status হবে। System safety instructions, workspace boundary, approval rules, secret handling, language policy এবং tool restrictions কোনো tuning overwrite করতে পারবে না।

### 7. API/UI contract

বর্তমান endpoints `/improvement/status`, `/improvement/tunings`, `/improvement/force-reflection`, `/improvement/force-optimization`, `/improvement/force-tuning` বজায় রেখে structured truthful response দাও। `success: true` কেবল cycle/proposal বাস্তবে সম্পন্ন হলে দেবে। Response-এ অন্তত `cycleId`, `status`, `result`, `counts`, `policyVersion`, `degradedReason` এবং `requestId` যেখানে প্রযোজ্য যোগ করো। `apply` path-এ approval ছাড়া apply করা যাবে না।

Agent Control ও dashboard-এ hard-coded `disabled` বা `observe` status দেখানো যাবে না; actual persisted status, mode, sample count, average reward, latest cycle, pending proposal এবং degraded reason দেখাবে। Secrets, raw prompts এবং private reasoning UI-তে দেখাবে না।

### 8. Memory integration behavior

Normal agent turn-এর pre-execution memory context-এ learned policy instruction ঢোকানোর আগে provenance, scope, confidence, policy version এবং expiry যাচাই করো। Low-confidence বা contradicted learning blindly system prompt-এ inject করো না। Learning records সাধারণ conversational memory থেকে পৃথক region/category বা explicit provenance-এ রাখো। Retrieval budget existing selective-memory budget-এর মধ্যে থাকবে। Retrieval trace-এ learned items আলাদা করে চিহ্নিত করো।

Failed run, retry, safe stop এবং user correction memory-তে এমনভাবে লিখো যাতে পরে learning system ভুল করে failure-কে success হিসেবে reinforce না করে। User correction বা explicit negative feedback পুরনো policy-কে overwrite না করে evidence-weighted update করবে।

## Exact implementation tasks

প্রথমে বর্তমান `engine.ts`, `agent.ts`, heartbeat, memory bridge, memory package, API handlers এবং config schema-এর dependency map লিখে নাও। তারপর ছোট, reviewable changes করো। নতুন files কেবল প্রয়োজন হলে তৈরি করো; repository-র documented কিন্তু অনুপস্থিত historical modules অন্ধভাবে পুনরায় তৈরি করো না। Existing memory migration style, TypeScript strictness, CommonJS/ESM boundary এবং Linux/Windows path behavior অনুসরণ করো।

পরবর্তী ধাপে real persistence adapter, schema migration, reward calculator, policy selector, cycle scheduler, guardrail evaluator, API result type এবং UI status model implement করো। সব changes-এর পরে source tree, imports, build output এবং docs consistency যাচাই করো। কোনো credential source code, test fixture, log বা report-এ hard-code করো না।

## Required tests

নিচের test categories আবশ্যিক। প্রত্যেকটি বাস্তব temporary SQLite database এবং real memory adapter ব্যবহার করবে; no-op fake adapter দিয়ে integration claim করা যাবে না।

| Test category | আবশ্যিক assertion |
|---|---|
| Schema migration | Existing DB additive migration-এ data নষ্ট হবে না |
| Experience persistence | Run restart-এর পর experience/reward/policy state থাকবে |
| Scope isolation | owner/workspace/agent scope cross-read হবে না |
| Idempotency | একই `idempotency_key` duplicate record তৈরি করবে না |
| Reward math | Component, clamp, missing signal ও failure penalty deterministic |
| Policy selection | Baseline, exploration, min-samples ও versioning সঠিক |
| Cycle due logic | Interval, daily cap, idle gate ও concurrent lock সঠিক |
| Circuit breaker | Repeated failuresে trip, recovery cooldown ও safe result |
| Guardrail | Prompt drift threshold, immutable safety block ও rejection সঠিক |
| Approval | Draft/apply boundary, one-time approval ও rollback সঠিক |
| Secret safety | Raw key/token/password/prompt secret কোথাও persist/log/UI হবে না |
| Memory retrieval | Learned context provenance, scope, confidence ও token budget মানে |
| Failure semantics | Safe-stop/retry/error কখনও success হিসেবে reward পাবে না |
| API contract | No-op/failed cycle `success: true` বলবে না |
| Cross-platform | POSIX-only path, atomic write এবং Windows path assumptions নেই |
| Existing regression | `npm test`, `npm run verify`, memory tests সব pass |

অন্তত একটি end-to-end test চালাও যেখানে: user turn → run record → outcome → reward → persisted experience → next-turn retrieval trace → draft proposal তৈরি হয়। আরেকটি test-এ process restart-এর পরে একই scope-এ policy state পুনরায় load হয়।

## Acceptance criteria

Implementation তখনই complete ধরা হবে যখন:

1. `SelfImprovementEngine`-এ কোনো unconditional no-op due/cycle/status method থাকবে না।
2. `new Database(":memory:")`, `saveFact: () => 0`, `searchKeyword: () => []` বা equivalent fake adapter production wiring-এ থাকবে না।
3. Config-এর প্রতিটি self-improvement field হয় বাস্তবে ব্যবহৃত হবে, নয়তো schema/docs থেকে সরিয়ে দেওয়ার যুক্তিসহ পরিবর্তন করা হবে।
4. Runtime status actual persisted state দেখাবে এবং no-op-কে success বলবে না।
5. Experience, reward, policy, proposal এবং cycle state restart-এর পরেও থাকবে।
6. Scope, secret redaction, approval, rollback, drift guard এবং bounded token budget পরীক্ষা দ্বারা প্রমাণিত হবে।
7. Existing memory features—event write, selective retrieval, graph context, consolidation, dashboard inspection—ভাঙবে না।
8. Gemini ও local LFM test path provider-specific; কোনো provider failure-কে learned success হিসেবে persist করা যাবে না।
9. Linux build এবং Windows-compatible path/test দু’টিই যাচাই করা হবে।
10. `npm test`, `npm run verify` এবং `npm run runtime:24-7:check` সফল হবে; নতুন test report-এ বাস্তব evidence থাকবে।
11. Documentation-এ planned, implemented এবং unavailable capability আলাদা করে লেখা থাকবে।
12. Final diff-এ অপ্রয়োজনীয় generated artifacts, secrets, database files বা local logs commit করা হবে না।

## Delivery format

শেষে নিম্নলিখিত artifacts দাও:

- implementation summary;
- schema/migration note;
- API/UI behavior note;
- test report with command output summary;
- known limitations and rollback instructions;
- updated documentation;
- clean diff review।

কাজ অসম্পূর্ণ থাকলে “implemented” দাবি করবে না। কোনো blocked item, missing local model, unavailable provider, failed test বা approval-dependent step স্পষ্টভাবে status-এ দেখাবে।
