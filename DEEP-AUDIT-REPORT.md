# Agent Miki — Deep Audit ও Repair Report

**তারিখ:** ২৬ আগস্ট ২০২৬  
**Target repository:** `https://github.com/glayph/agent.git`  
**Validated branch:** latest `main` plus the deep-audit repair commit  
**Environment:** Ubuntu 24.04, Node.js 22.13.0, npm 10.9.2

## Executive Summary

Agent Miki-এর latest GitHub `main` branch-এর উপর deep audit চালিয়ে Agent Action Workflow, dashboard form surfaces, memory retrieval, model lifecycle, safety scan, Doctor, 24/7 runtime checks, gateway, tools এবং skills paths যাচাই করা হয়েছে। Upstream-এর newer hardening commits অক্ষুণ্ণ রেখে targeted repairs port করা হয়েছে। Dashboard memory search-এর cross-region fix, duplicate model-card protection, single-line secret parsing, optional Go reporting এবং actionable local-model smoke diagnostics এখন latest branch-এ রয়েছে।

Final validation-এ launcher ও safety targeted suites-এ **83/83 tests pass**, selective-memory script pass, frontend suite-এ **12 test files / 55 tests pass**, production build pass, এবং full `npm run verify` pass হয়েছে। Gemini smoke path supplied test credential দিয়ে `miki model smoke test` return করেছে। Local LFM path configured llama.cpp endpoint না থাকায় expected `ECONNREFUSED` দিয়েছে; error message এখন endpoint ও connection cause স্পষ্ট করে।

## Repairs

| Surface | Defect or risk | Repair |
|---|---|---|
| Dashboard memory search | Generic dashboard query agent-context region inference-এর কারণে অন্য region-এর matching chunk লুকাতে পারত | Dashboard search-এ all canonical regions explicitly পাঠানো হয়েছে |
| Model catalog | Exact duplicate provider/model records repeated dashboard cards তৈরি করতে পারত | Startup deduplication এবং configured duplicate add-এ HTTP 409 guard যোগ করা হয়েছে; unconfigured seeded model প্রথমবার configure করা যায় |
| Secret scan | Blank env assignment-এর পরের line consume করে false positive হতো | Assignment regex-এ single-line whitespace; existing fixture-aware scan behavior preserved |
| Doctor | Optional Go CLI অনুপস্থিতি core Node runtime-কে warning দিয়ে downgrade করত | Go check optional advisory হিসেবে pass হয়; explicit required mode থাকলে fail semantics upstream-এ অক্ষুণ্ণ |
| Standalone Doctor CLI | Source checkout artifact থাকলেও packaged-only path দেখে false warning; Go/placeholder handling core-এর সঙ্গে inconsistent | Source বা packaged runtime artifacts উভয় গ্রহণ; optional Go ও placeholder handling aligned |
| Model smoke | Local endpoint না থাকলে শুধু `fetch failed` দেখা যেত | URL, timeout এবং connection code সহ actionable error |

## Validation Matrix

| Check | Result |
|---|---:|
| Core launcher compatibility tests | 68 tests pass on repaired attached snapshot; 83 targeted tests pass on latest GitHub branch with safety suite |
| Safety and Doctor tests | PASS |
| Selective memory engine | PASS |
| Frontend tests | 12 files, 55 tests pass |
| Core/Gateway/frontend production build | PASS |
| Full `npm run verify` on latest branch | PASS |
| Doctor with supplied Gemini test credential | PASS |
| Gemini model smoke | PASS; exact response `miki model smoke test` |
| Local LFM smoke | Expected limitation; no configured endpoint/model, `ECONNREFUSED` is reported clearly |
| Live attached dashboard Health | Healthy; 9/9 Agent Flow ready, 0 flow gaps, 53 tools, 38 skills, 0 dead-letter jobs, 0 secret findings |
| Live automation form | Valid workflow created and manually triggered |
| Live memory search | Previously hidden cross-region record recovered after repair |
| Live Models page | Repeated Gemini default cards removed; one card per model identity |

## Local LFM Limitation

The repository intentionally does not bundle an answer-model GGUF. To run an actual local LFM completion, configure an external compatible model and llama.cpp OpenAI-compatible endpoint, for example `MIKI_LOCAL_MODEL_ENDPOINT=http://127.0.0.1:8080/v1` and `MIKI_LOCAL_MODEL=lfm2-local`, or use the Models page to register a supported external GGUF path. The smoke test does not hide this prerequisite.

## Repository Integration

The latest upstream `main` history was fetched and preserved rather than force-overwritten. Repairs were applied on top of the existing branch, then formatted and tested against that newer source tree. Runtime credentials, databases, logs, `node_modules`, caches, and mutable local state were not staged or published. The final repository contains the smoke command as `npm run model:smoke`.

## Reproduction

```bash
npm install
npm run build:all
GEMINI_API_KEY='<credential>' npm run verify
GEMINI_API_KEY='<credential>' GEMINI_MODEL='gemini-3.5-flash-lite' npm run model:smoke -- --gemini
MIKI_MODEL_SMOKE_TIMEOUT_MS=3000 npm run model:smoke -- --local
npm start
```

> **Conclusion:** Agent Miki-এর বর্তমান latest branch এখন validated local-first agentic runtime হিসেবে build, safety, model lifecycle, memory observability, dashboard workflow এবং 24/7 readiness surfaces-এ স্থিতিশীল। OpenClaw/Opencode-এর পূর্ণ ecosystem parity আলাদা product-scale scope; এই কাজটি বর্তমান Agent Miki-এর concrete runtime defects সংশোধন করে তার agentic foundation শক্ত করেছে।
