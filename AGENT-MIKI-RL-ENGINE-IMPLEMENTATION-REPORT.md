# Agent Miki — RL Engine Implementation Report

**Implementation scope:** Durable contextual-bandit self-improvement layer
**Runtime target:** Linux ও Windows-compatible Node.js agent runtime
**Safety default:** `observe`/`draft`; autonomous policy application নয়

## বাস্তবায়নের সারাংশ

Agent Miki-র আগের self-improvement façade-এ cycle methods no-op ছিল এবং self-improvement state ephemeral `:memory:` database-এ তৈরি হতো। এই implementation সেই path সরিয়ে durable `agent-memory.db`-এর একই SQLite connection-এ learning state সংযুক্ত করেছে। এখন experience, reward, action statistics, policy state, cycle journal এবং draft proposal restart-এর পরও থাকে।

প্রথম release হিসেবে model-weight training নয়, **bounded contextual bandit** বেছে নেওয়া হয়েছে। Agent প্রতিটি turn-এ model action, outcome এবং bounded reward record করে। পর্যাপ্ত sample হলে best observed action নির্ধারণ করতে পারে; exploration rate, minimum sample threshold এবং policy version persisted থাকে। `draft` mode-এ learned routing শুধু পর্যবেক্ষিত হয়। `apply` mode না হওয়া পর্যন্ত user-configured baseline বদলায় না।

## কোন কোন স্তর যুক্ত হয়েছে

| স্তর | বাস্তবায়ন |
|---|---|
| Durable storage | `packages/memory/src/learning-store.js`-এ চারটি additive SQLite table, scoped indexes ও idempotency constraint |
| Memory wiring | `TemporalKnowledgeGraph` একই DB connection-এ `LearningStore` initialize করে; core আর ephemeral self-improvement DB ব্যবহার করে না |
| Experience tracking | Agent turn memory write-এর সঙ্গে model action, task context, outcome, reward ও idempotency key record হয় |
| Reward | Completion, task success, feedback, verification, latency, retry ও safety penalty থেকে `[-1, 1]` bounded deterministic reward |
| Policy | Persisted action statistics, baseline fallback, minimum samples, exploration rate এবং policy version |
| Cycles | Reflection, optimization ও prompt-tuning cycle-এর due logic, daily reflection cap, draft cap, cycle journal এবং structured status |
| Safety | Secret redaction, scoped retrieval, no arbitrary code mutation, no unapproved apply, truthful `success` API contract |
| UI | Agent Control page-এ mode, policy version, decisions, average reward, pending drafts এবং cycle state card |

## Runtime flow

```text
Agent turn
   │
   ├── classify task + resolve baseline model
   ├── read scoped persisted bandit policy
   ├── observe/draft mode → keep baseline model
   ├── optional apply mode → learned model only if explicitly allowed
   ├── execute model/tool loop
   ├── write user/assistant event to memory
   └── record idempotent experience + reward + policy statistics

Heartbeat / force endpoint
   │
   ├── due check + daily/draft limits + single-cycle lock
   ├── read bounded scoped experiences
   ├── create reflection/optimization/tuning draft
   └── persist cycle result, proposal and sanitized evidence
```

## Verified behavior

The following results were verified after rebuilding and restarting the runtime.

| Verification | Result |
|---|---:|
| Memory package tests, including new LearningStore tests | Passed |
| Core self-improvement Jest tests | 3 passed |
| Core strict typecheck | Passed |
| Core lint | Passed |
| Frontend lint | Passed |
| Frontend production build | Passed |
| Full `npm run verify` | Passed; existing doctor warnings were optional Go CLI and environment-only provider-key detection |
| `/api/improvement/status` | HTTP 200 |
| Force reflection with no experiences | HTTP 200, `success: false`, `status: skipped`, `reason: no_experiences` |
| Live Gemini task `3+3` | Returned `6` |
| Live Gemini task `5+5` after reward fix | Returned `10` |
| Live SQLite inspection | 2 experiences, 2 policy decisions, `draft` mode, average reward `0.4` |
| Agent Control visual UI | RL status card rendered correctly |

The first post-fix live experience was stored with action `model:gemini/gemini-3.5-flash-lite`, outcome `success`, and reward `0.75`. The earlier pre-fix short-answer record remains as an auditable historical `unknown` outcome; it was not silently rewritten.

## Safety and operational boundaries

The engine never stores raw API keys, tokens, passwords or authorization values. Experience and proposal payloads are redacted before persistence. Each record is scoped by agent, owner and workspace, and duplicate retries are rejected by a scope-local idempotency key. LLM-generated reflection text is treated as untrusted analysis data; it cannot directly execute code, shell commands, tools or external side effects.

The current UI and API deliberately keep `draft` as the operational mode. A force optimization request with `apply: true` is rejected unless the configured mode is `apply`; even then the current implementation returns `owner_approval_required` rather than silently applying a proposal. This is intentional until a dedicated approval-and-rollback flow is connected.

## Known limitations

This is a **decision-learning foundation**, not neural model training. It currently learns bounded action statistics rather than updating model parameters. The baseline reward signal is deterministic and conservative; richer user feedback and verification signals can be added later. Prompt tuning currently produces a draft proposal and does not mutate the live system prompt. Semantic retrieval remains optional and can fall back to lexical retrieval when no embedding provider is active.

The existing task-loop safe-stop behavior is independent of the RL layer. A failed or safe-stopped run is recorded as a failure when it reaches the memory interaction hook; the RL layer does not treat provider failure as success. More complete quality evaluation can later pass explicit verification and retry metadata into the existing reward input.

## Recommended next iteration

The next safe iteration should add a formal approval inbox for learning proposals, immutable baseline prompt sections, rollback snapshots, a small end-to-end restart test against a real temporary SQLite database, and an explicit quality-verifier signal from the agent loop. Only after those checks are stable should `apply` mode be enabled for a narrowly allow-listed model-routing decision.
