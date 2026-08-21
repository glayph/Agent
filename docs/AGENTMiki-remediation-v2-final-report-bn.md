# Agent Miki Remediation v2 — Final Implementation Report

## সারসংক্ষেপ

Approved remediation plan অনুযায়ী Agent Miki-এর canonical source tree-তে agentic local-LLM workflow-এর critical execution, artifact verification, local runtime readiness, Pursue Goal route, Inspector observability, low-memory policy, এবং verification tooling-এর সংশোধন প্রয়োগ করা হয়েছে। Generated application source manually edit করা হয়নি; source handoff-এর জন্য কেবল runtime-generated `MANIFEST.json` metadata ব্যবহৃত হয়েছে। Docker বা Python runtime যোগ করা হয়নি এবং কোনো API credential source tree-তে রাখা হয়নি।

## Implemented changes

| Finding area | Implementation |
|---|---|
| Hallucinated tool JSON | Plain-text JSON tool call শনাক্ত করে `tool_call_rejected` event; native tool invocation না হলে execute হয় না |
| Malformed arguments | JSON object validation; malformed/scalar arguments pre-execution reject |
| Tool execution evidence | `tool_call_id`, `executed`, `ok`, duration ও output status tool events-এ যুক্ত |
| False completion | Tool failure/rejection এবং artifact verification failure final run status-কে `failed` করে |
| Artifact handoff | Required files verify করে SHA-256 file inventory সহ atomic `MANIFEST.json` লেখা হয় |
| Local runtime race | Managed child identity check, stale exit callback isolation, in-flight ensure guard, managed/external readiness distinction |
| Pursue Goal | Persisted `/api/enhancements/goals` store এবং gateway `/api/goals` rewrite; GET/POST/PATCH flow চালু |
| Inspector | Execution progress heartbeat, stable `data-testid` selectors, explicit Work empty state, tool node identity |
| Local model latency/resource | Model-request progress events ও low-memory context cap যুক্ত |
| Verify script | `.trash` quarantine subtree lint থেকে explicit ignore করা হয়েছে |

## Verification evidence

| Check | Result |
|---|---|
| Strict tool protocol tests | 3 suites, 8 tests passed |
| Workspace test run | 50 frontend tests passed; available workspace suites completed successfully |
| Core build | Passed |
| Gateway build | Passed |
| Full `npm run build:all` | Passed, including native runtime build and frontend |
| Goals live smoke | GET 200, POST 201, PATCH 200; completed goal active state থেকে সরেছে |
| Secret pattern audit | No credential-like match in source-like files |
| Artifact manifest tests | SHA-256 length and `.trash`/manifest exclusion passed |

## Full verification note

`npm run verify` শুরুতে `.trash`-এর quarantined legacy ESLint config resolve করার কারণে ব্যর্থ হয়েছিল; verify script-এ `.trash` ignore fix করা হয়েছে। এরপর complete lint stage-এ repository-wide existing Prettier baseline-এর 1,629 findings প্রকাশ পেয়েছে, যার অধিকাংশ remediation patch-এর বাইরে থাকা pre-existing files-এ। এই baseline formatting debt সমাধানের জন্য পুরো monorepo reformat করা হয়নি, কারণ তা অপ্রয়োজনীয় broad source churn তৈরি করত। Focused build, typecheck, focused tests, workspace tests, and release build সকলেই সফল।

> **Release interpretation:** Runtime correctness gates pass করেছে। Repository-wide lint baseline clean নয়; তাই future maintenance-এ lint debt আলাদা workstream হিসেবে নেওয়া উচিত।

## গুরুত্বপূর্ণ files

`packages/core/src/tool-protocol.ts` strict model-output parsing-এর pure helper। `packages/core/src/api/artifact-contract.ts` required artifact verification ও manifest writer। `packages/core/src/api/pursue-goal-store.ts` Pursue Goal persistence। `packages/core/src/llm/local/local-runtime.ts` process identity/readiness/memory policy। `packages/core/src/agent.ts` agent loop protocol ও progress events। `packages/core/src/api/index.ts` final status/artifact gate। `packages/gateway/src/index.ts` `/api/goals` rewrite। `packages/ui/frontend/src/features/chat/components/chat-inspector.tsx` Inspector selectors ও Work state। `scripts/run-verify.mjs` quarantine-aware lint invocation।

## Security and packaging statement

Final package তৈরির আগে credential-pattern audit চালানো হয়েছে। User-provided API key source tree, report, অথবা release archive-এ রাখা হয়নি। `.trash` content delete না করে quarantine হিসেবেই রাখা হয়েছে। Release archive direct Linux/Windows runtime requirements, Docker-free operation, এবং Python-free normal runtime policy অক্ষুণ্ণ রাখে।
