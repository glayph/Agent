# Agent Miki — Backend-Only Graph-Based Cognitive Memory Replacement Plan

## লক্ষ্য

Agent Miki-এর বর্তমান memory implementation-কে সম্পূর্ণ backend-only, persistent, graph-based cognitive memory service-এ রূপান্তর করা হবে। সংযুক্ত diagram-গুলোকে conceptual reference হিসেবে ব্যবহার করা হবে: Agent-এর চারপাশে long-term knowledge, project context, procedural skills, policy/rules, episodic events এবং temporary working state থাকবে; memory node ও directed typed edge-এর মাধ্যমে সম্পর্কিত থাকবে। Frontend-এ কোনো memory dashboard, graph visualization, category editor বা raw memory payload যোগ করা হবে না। বিদ্যমান chat/UI আচরণ অপরিবর্তিত থাকবে।

## বর্তমান codebase থেকে নিশ্চিত baseline

বর্তমানে `packages/memory`-এ `TemporalKnowledgeGraph` প্রধান implementation। এটি `better-sqlite3` ও WAL-mode SQLite ব্যবহার করে এবং `events`, `entities`, `entity_edges`, `hourly_chunks`, `working_anchor`, `daily_summaries`, `special_events_index`-সহ existing schema তৈরি করে। SQLite FTS5-এ events ও entities search আছে, Bengali/Unicode tokenizer ব্যবহৃত হয়, এবং `NodeGraph`, `MultiHopRetriever`, `TemporaryMemory`, `MemoryConsolidationDaemon`, `EmbeddingProvider` ও `AgentMemoryIntegration` ইতিমধ্যে বিদ্যমান। `AgentMemoryIntegration`-এর pre-execution context retrieval, post-execution write, interaction logging ও tool-call logging হলো প্রধান orchestration integration point।

এই baseline পুনর্ব্যবহার করা হবে; নতুন graph database বা বড় dependency আনা হবে না। বর্তমান SQLite file, rows, timestamps, provenance এবং existing API compatibility সংরক্ষণ করা হবে।

## প্রস্তাবিত architecture ও data model

`packages/memory`-এর ভিতরে একটি নতুন service boundary তৈরি করা হবে, যেমন `GraphCognitiveMemory` বা project convention অনুযায়ী equivalent নাম। এটি storage, extraction, categorization, deduplication, graph linking, ranking, bounded retrieval, access tracking, lifecycle এবং migration orchestration একত্রে পরিচালনা করবে; LLM কেবল extraction/semantic assistance-এর optional অংশ হবে, memory policy backend deterministic থাকবে।

নতুন logical model হবে:

| Entity | উদ্দেশ্য | প্রধান fields |
|---|---|---|
| `MemoryNode` | fact, preference, event, skill, rule, contact, task state, project context বা lesson | id, owner/agent/workspace scope, canonical content/value, memory type, category, source/provenance, timestamps, access counters, confidence, importance, score fields, status, review/expiry, pinned/archive flags, metadata, optional embedding |
| `MemoryEdge` | typed directed relationship | id, scope, source node, target node, relation type, weight, confidence, timestamps, traversal metadata |
| `MemoryCategory` | ছোট reusable taxonomy/subgraph | id, scope, stable slug, label, description, created/updated timestamps |
| `MemoryAccessEvent` | retrieval/use signal | id, scope, node id, task/session reference, retrieved/used/useful state, timestamp, aggregated metadata |
| `MemoryRevision` | edit, merge, contradiction, supersession provenance | id, scope, node id, revision type, previous/current values, source reference, created timestamp |
| `ProjectContext` | active project-এর temporary subgraph | id, scope, project key, status, boost, opened/closed/dormant timestamps, metadata |

SQLite tables, indexes এবং foreign keys idempotent `CREATE TABLE IF NOT EXISTS`/migration steps দিয়ে তৈরি হবে। Scope columns প্রতিটি নতুন table-এ বাধ্যতামূলক থাকবে, কমপক্ষে `agent_id`, `owner_id`, `workspace_id` বা codebase-এর প্রকৃত equivalent; nullable scope-কে unrestricted query হিসেবে গণ্য করা যাবে না। Existing single-agent data migration-এর জন্য explicit legacy scope mapping configuration থাকবে।

Default category taxonomy হবে `conversation`, `personality`, `design`, `project_context`, `procedural`, `policy`, `episodic`। Existing `REGIONS` (`long_term`, `daily`, `static`, `skill`, `rule_emotion`, `temporary`) সরাসরি মুছে ফেলা হবে না; একটি compatibility mapping/metadata layer ব্যবহার করে পুরোনো region semantics নতুন category ও memory type-এ রূপান্তর করা হবে।

Supported relation types হবে `PREFERS`, `RELATED_TO`, `PART_OF`, `DERIVED_FROM`, `CONTRADICTS`, `SUPERSEDES`, `DEPENDS_ON`, `USED_WITH`, `CAUSED`, `SUCCEEDED_IN`, `FAILED_IN`, `APPLIES_TO`, `CONTACT_OF`, `BELONGS_TO_PROJECT`। Contradictory facts overwrite না করে provenance-সহ পৃথক node এবং `CONTRADICTS`/`SUPERSEDES` edge হিসেবে রাখা হবে।

## বাস্তবায়নের ধাপ

### Phase 1 — Schema, contracts এবং scope boundary

প্রথমে বর্তমান memory call sites, runtime DB path, agent/workspace/session identifiers এবং existing test conventions সম্পূর্ণ trace করা হবে। নতুন typed contracts, category/relation constants, redaction helper, scope resolver এবং deterministic score configuration যোগ করা হবে। `memory_nodes`, `memory_edges`, `memory_categories`, `memory_access_events`, `memory_revisions` এবং `project_contexts` tables ও indexes তৈরি হবে। Existing tables untouched থাকবে।

প্রতিটি read/write/retrieve/update query scope predicate বাধ্যতামূলক করবে। API-তে raw embedding, access log বা private graph object ফেরত দেওয়া হবে না; internal result হবে redacted concise context item এবং optional non-sensitive ranking reason।

### Phase 2 — Ingestion, extraction, categorization ও graph linking

Backend ingestion boundary-তে প্রতিটি interaction থেকে memory-worthy signal নির্বাচন করা হবে। Greetings, filler, redundant message, secrets, passwords, API keys, payment information এবং credentials স্থায়ী memory-তে যাবে না। Stable preference, explicit fact, project decision, reusable procedure, policy, meaningful event, contact/entity relation এবং active task state concise canonical form-এ সংরক্ষিত হবে।

Existing extraction/highlighter/entity logic পুনর্ব্যবহার করে deterministic rules আগে চলবে; optional LLM extraction থাকলে structured output-এর পরে backend validation, redaction, confidence threshold ও scope validation হবে। Existing category পুনর্ব্যবহার default; recurrence/distinctness/ambiguity threshold না পেরোলে নতুন category তৈরি হবে না। Duplicate node canonical fingerprint/content similarity দিয়ে merge বা link হবে, কিন্তু provenance ও revision হারাবে না। Identifiable entities-এর ক্ষেত্রেই edge তৈরি হবে; speculative high-confidence edge তৈরি হবে না।

### Phase 3 — Ranking, bounded graph retrieval ও context injection

Retrieval pipeline হবে: current user/agent/workspace/project/task scope শনাক্ত করা, query concepts/entity/category/temporal hints বের করা, exact/FTS ও available embedding search দিয়ে candidates নেওয়া, privacy/status/confidence/contradiction filter করা, activation score-এ rerank করা, সর্বোচ্চ configurable দুই hop graph neighbor expand করা, deduplicate/compress করা এবং token/count budget-এর মধ্যে context inject করা।

Baseline activation formula:

```text
activation_score =
    0.30 * semantic_relevance
  + 0.20 * graph_relevance
  + 0.15 * recency_score
  + 0.15 * frequency_score
  + 0.10 * explicit_importance
  + 0.10 * confidence
```

প্রতিটি component 0–1 normalized হবে। Configurable exponential time decay ব্যবহার হবে। Active project context-এ temporary relevance boost থাকবে; relevance comparable হলে frequently used contacts/entities উপরে থাকবে। Access count একা ranking নির্ধারণ করবে না। Internal explainability reason সংরক্ষিত হবে, কিন্তু frontend-এ raw score/embedding/access log পাঠানো হবে না। Semantic/graph service unavailable হলে existing FTS/keyword retrieval-এ graceful fallback থাকবে।

`AgentMemoryIntegration.preExecutionHook`, `getEnhancedSystemPrompt`, `postExecutionHook`, `logInteraction` এবং `logToolCall` নতুন service-এর adapter-এর মাধ্যমে চালানো হবে। Context injection concise ও bounded হবে; ordinary response path-এ unbounded graph traversal বা large prompt growth হবে না। Retrieval ও usefulness signals asynchronous বা lightweight transactional write হবে, যাতে response latency অপ্রয়োজনীয়ভাবে না বাড়ে।

### Phase 4 — Project context ও lifecycle maintenance

Active project শনাক্ত হলে `project_context` subgraph তৈরি বা reuse হবে। Requirements, design decisions, API knowledge, implementation constraints, active task state ও successful/failed outcomes সেখানে থাকবে এবং related design/procedural/policy/episodic nodes-এর সঙ্গে edge থাকবে। Project close বা configurable inactivity period পার হলে boost সরিয়ে dormant/archive করা হবে, data delete করা হবে না। Broadly reusable skill, rule, preference বা lesson explicit promotion rule-এ long-term category-তে linked/promoted হবে।

Existing `MemoryConsolidationDaemon`/job infrastructure পুনর্ব্যবহার করে retry-safe, idempotent non-blocking maintenance যোগ হবে: decay recalculation, edge-weight decay/update, duplicate merge/link, contradiction/supersession processing, stale project demotion, dormant archive এবং access-event aggregation/expiry। Maintenance ordinary agent response block করবে না। Default configuration হবে maximum graph depth 2, bounded retrieved memory count, bounded injected token budget এবং project inactivity period codebase convention অনুযায়ী; এগুলো environment/config দিয়ে override করা যাবে।

### Phase 5 — Safe migration ও compatibility transition

Existing `events`, `entities`, `entity_edges`, `working_anchor`, `daily_summaries`, temporary memory এবং region data-এর জন্য idempotent migration adapter তৈরি হবে। প্রতি legacy row-এর deterministic migration key/fingerprint থাকবে, যাতে পুনরায় চালালেও duplicate না হয়। Original id, content, timestamps, source, metadata, importance ও ownership mapping revision/provenance-এ সংরক্ষিত হবে। Migration report-এ migrated/skipped/conflicted/error counts থাকবে।

Transition period-এ নতুন service হবে canonical read/write path; পুরোনো tables compatibility/read-only source হিসেবে থাকবে যতক্ষণ verification gates pass না করে। Rollback flag থাকলে নতুন service বন্ধ করে existing integration path চালানো যাবে; কোনো old row delete বা destructive schema change করা হবে না। Migration শেষে integrity check, count comparison, sample retrieval comparison এবং scope audit করা হবে।

### Phase 6 — Tests, regression verification ও delivery report

Backend unit/integration tests যোগ হবে যাতে category reuse, recurrence threshold, relevant/frequent ranking, recency, gradual decay, project demotion, reusable lesson promotion, duplicate provenance, contradiction handling, bounded traversal/context, scope isolation, optional-service fallback, frontend non-exposure, idempotent migration এবং existing suite compatibility প্রমাণিত হয়। SQLite temporary DB-তে deterministic clock/config injection ব্যবহার করে tests reproducible করা হবে।

Final verification-এ backend build, memory package tests, full regression suite, migration dry-run/report, cross-scope negative tests এবং live chat response path পরীক্ষা করা হবে। কোনো memory UI, graph endpoint বা raw private memory payload frontend-এ যুক্ত হয়েছে কি না static/API inspection-এ নিশ্চিত করা হবে।

## Configuration defaults ও নিরাপত্তা

Configuration-এ category threshold, max graph depth `2`, max retrieved nodes, max injected context tokens, recency half-life, project inactivity period, maintenance interval, confidence threshold এবং optional embedding provider থাকবে। Default embedding provider existing offline-safe provider হবে; external semantic provider optional এবং unavailable হলে fallback চালু থাকবে।

Sensitive content redaction ingestion-এর আগে এবং logging-এর আগে চলবে। API key, password, token, credential, payment detail, private auth material এবং secret-bearing tool arguments memory node বা audit log-এ plain text হিসেবে রাখা হবে না। প্রতিটি retrieval/write/update path user, tenant, workspace এবং agent scope enforce করবে। Contradiction বা low-confidence memory context-এ uncertainty/provenance বজায় থাকবে।

## Deliverables

Implementation শেষে report-এ current implementation, changed files, schema/migration/rollback notes, configuration variables, ranking/decay formula, category rules, project promotion/demotion behavior, test/build results, known limitations, frontend non-change confirmation এবং old data preservation/migration evidence দেওয়া হবে। Final archive-এ source, migrations, tests এবং report থাকবে; raw private database বা credentials archive করা হবে না।

## Assumptions ও open risks

1. Existing SQLite/better-sqlite3 stack ও current memory package-ই persistence boundary হিসেবে রাখা হবে; external graph database প্রয়োজন হবে না।
2. Current runtime-এ single-agent legacy rows থাকলে configured default agent/workspace scope দিয়ে backfill হবে; multi-tenant mapping অস্পষ্ট হলে migration-এর আগে explicit mapping review gate থাকবে।
3. Existing memory implementation-এর কিছু methods private/internal (`_extractEntities`, `_ensureEntity`); নতুন service public adapter দিয়ে encapsulate করা হবে এবং direct private calls ধীরে সরানো হবে।
4. Full semantic embeddings optional থাকবে; hash/no-op provider ব্যবহার করেও system functional থাকবে।
5. Database migration-এর আগে backup/snapshot এবং dry-run বাধ্যতামূলক; incomplete scope mapping, malformed metadata বা conflicting legacy records destructiveভাবে resolve করা হবে না।
6. এই plan backend-only; attached visual references implementation-এর conceptual architecture হিসেবে ব্যবহৃত হবে, frontend visualization হিসেবে নয়।


## বাস্তবায়ন অগ্রগতি — ২০ আগস্ট ২০২৬

পরিকল্পনার backend অংশ বাস্তবায়িত হয়েছে। নতুন `packages/memory/src/graph-cognitive-memory.js` scoped SQLite graph service হিসেবে যোগ হয়েছে। এটি Personality, Episodic, Semantic, Procedural, Project Context, Working এবং Temporary category পরিচালনা করে; durable node, typed edge, bounded deterministic retrieval, project-aware boost, token budget, secret redaction, duplicate suppression, migration ও lifecycle maintenance সমর্থন করে।

`TemporalKnowledgeGraph` একই SQLite connection-এ `GraphCognitiveMemory` attach করে, ফলে legacy temporal tables ও API contract অক্ষুণ্ণ থাকে। `AgentMemoryIntegration` নতুন graph-কে preferred context/write path হিসেবে ব্যবহার করে এবং legacy event trail-এ dual-write বজায় রাখে। Tool outcomes procedural memory হিসেবে এবং user/assistant turns scoped conversation memory হিসেবে সংরক্ষিত হয়। `MemoryConsolidationDaemon` নিয়মিত graph maintenance চালায়।

Compatibility export `@miki/memory/graph-cognitive-memory` এবং TypeScript declaration যোগ হয়েছে। নতুন deterministic regression test-এ scope isolation, duplicate suppression, retrieval, project context, redaction, graph edge ও lifecycle checks pass করেছে। সম্পূর্ণ memory package test suite-এ legacy TKG, integration, deep-audit এবং graph cognitive memory tests সব pass করেছে।

> নোট: memory package-এর production runtime-এর জন্য বিদ্যমান `better-sqlite3` native dependency installation/rebuild সম্পূর্ণ থাকতে হবে। Source code-এ কোনো external provider বা model dependency যোগ করা হয়নি।
