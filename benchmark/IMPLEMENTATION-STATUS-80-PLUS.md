# Agent Miki: 66.6% থেকে 80%+ যাওয়ার Implementation Status

**তারিখ:** 20 August 2026  
**Scope:** Agent Miki benchmark rubric v1, 10 dimensions, weighted 5-point scale  
**Baseline:** 3.33/5 = **66.6%**  
**Minimum target:** 4.04/5 = **80.8%**  
**Recommended buffer:** 4.19/5 = **83.8%**

## Executive conclusion

Agent Miki-কে 80%+ করতে শুধু আরও feature যোগ করলেই হবে না; চারটি weighted gap বন্ধ করতে হবে: **isolated execution maturity**, **memory depth**, **skill governance**, এবং **production-grade connectors**। বর্তমান implementation wave R0–R1-এর মাধ্যমে reproducible scoring gate, audited human approval, isolated browser child-process boundary এবং leased browser run lifecycle যোগ হয়েছে। এই wave-এর conservative earned score আনুমানিক **3.59/5 = 71.8%**, তবে canonical score matrix ইচ্ছাকৃতভাবে baseline 66.6% অপরিবর্তিত রাখে যতক্ষণ না নতুন acceptance evidence formal rescoring-এ যুক্ত হয়।

80.8% target-এর জন্য প্রয়োজনীয় weighted uplift হলো **+0.71/5** baseline থেকে। R0–R1-এর পর remaining uplift আনুমানিক **+0.45/5**। নিচের closure table-এ এই remaining uplift-এর সম্পূর্ণ হিসাব দেওয়া হলো।

## Current score and target scorecard

| Dimension | Weight | Baseline | Conservative R0–R1 earned state | 80.8% target | Remaining work |
|---|---:|---:|---:|---:|---|
| Execution environment & isolation | 15% | 2 | 3 | 4 | Real browser smoke tests, container/profile isolation, crash recovery evidence |
| Durable task execution & reliability | 15% | 4 | 4 | 4 | Preserve existing queue/lease/DLQ contracts; add long-run soak evidence |
| Web search: local + cloud | 10% | 4 | 4 | 4 | No score change required |
| Memory & personalization | 10% | 3 | 3 | 4 | Cross-session retrieval, user preference evaluation, retention/PII tests |
| Skills & extensibility | 8% | 3 | 3 | 4 | Signed/trusted registry, manifest validation, progressive disclosure and rollback |
| Multi-channel connectors | 8% | 2 | 2 | 4 | Production adapters, webhook verification, retry, receipts and DLQ |
| Security & policy boundary | 15% | 4 | 4 | 4 | Preserve approval/audit guarantees; add policy regression corpus |
| Observability & operator controls | 7% | 3 | 4 | 4 | Metrics/alerts and dashboard evidence for approval, lease and connector states |
| Deployment flexibility | 8% | 5 | 5 | 5 | No score change required |
| Developer/operator experience | 4% | 3 | 4 | 3 | Score target already met; keep reproducible commands documented |
| **Weighted total** | **100%** | **3.33 = 66.6%** | **3.59 = 71.8%** | **4.04 = 80.8%** | **+0.45/5 after R0–R1** |

The score is calculated as `Σ(dimension_score × weight) × 20`. The remaining 80.8% uplift is exact under the approved rubric: execution **+1 × 0.15 = +0.15**, memory **+1 × 0.10 = +0.10**, skills **+1 × 0.08 = +0.08**, and connectors **+2 × 0.08 = +0.16**; together these contribute **+0.49/5** from the conservative R0–R1 state. The difference between rounded table values and the canonical 4.04 target should be handled using the exact score-gate JSON during formal rescoring.

## Delivered in R0–R1

The repository now contains `benchmark/score-matrix.json` and `scripts/benchmark-score-gate.mjs`. The score gate reproduces the 10-dimension weighted arithmetic and emits `benchmark/score-gate-output.json`; the baseline, 80.8% minimum target and 83.8% recommended target all pass their arithmetic checks.

`packages/core/src/security/approval-inbox.ts` implements a durable approval request store with expiring requests, single-use worker tokens, token-hash persistence, replay protection, operator decisions, revoke support and audit callbacks. `packages/core/src/api/approval-router.ts` exposes authenticated pending/list/get/approve/deny/revoke endpoints. The operator route deliberately uses authenticated operator methods rather than exposing raw worker tokens.

`packages/core/src/tools/isolated-browser-worker.ts` creates a per-run profile under the configured data directory, launches a separate Node child process, restricts the command surface to the existing browser operations, applies command timeouts, supports kill/restart and enforces the approval contract for side effects. A newline-delimited JSON protocol connects the parent manager to the child. `packages/core/src/tools/leased-browser-runner.ts` connects that worker to a queue interface with lease acquisition, heartbeat, checkpoint, completion, retry and shutdown behavior. Raw approval tokens are not persisted in the durable job payload.

## Verification evidence

| Gate | Result | Evidence |
|---|---|---|
| Canonical score arithmetic | **PASS** | `node scripts/benchmark-score-gate.mjs --write` |
| Strict typecheck: approval/worker modules | **PASS** | `benchmark/tsconfig.phase4.json` |
| Strict typecheck: approval API router | **PASS** | `benchmark/tsconfig.router.json` |
| Targeted regression tests | **PASS: 9/9** | ApprovalInbox, IsolatedBrowserWorker, LeasedBrowserRunManager |
| Full monorepo build | **PASS** | `pnpm run build` |
| Full workspace test command | **BLOCKED BY ENVIRONMENT** | better-sqlite3 native addon was unavailable in the test runtime; source rebuild also requires runtime/toolchain-compatible native binding |

The full workspace test limitation is not silently counted as a pass. Before a formal 80% rescoring, the CI image must install a compatible better-sqlite3 binary or build it in a supported Node/toolchain image, and the complete suite must pass.

## Exact roadmap to 80.8%

### P0 — Production connector plane: score lift +0.16/5

Implement at least four production-grade connector adapters behind one typed delivery contract. Each adapter must support inbound verification, outbound send, idempotency key, exponential retry, rate-limit handling, delivery receipt, dead-letter routing and operator replay. The acceptance gate is a matrix of connector contract tests plus a live sandbox smoke test for each enabled connector. No connector should be counted as production-ready merely because it can send a single message.

### P0 — Browser execution maturity: score lift +0.15/5

The current child-process worker is a security and lifecycle foundation, not yet a full hosted-browser equivalent. Close the remaining gap with a real Playwright/Chromium smoke suite, profile-per-run cleanup test, navigation/download/upload test, crash-and-restart test, timeout test, network policy test and approval-gated side-effect test. Run these tests in a containerized CI image and retain the artifacts. This is the acceptance evidence required to move execution from 3 to 4.

### P1 — Memory depth: score lift +0.10/5

Extend existing memory governance with cross-session preference retrieval and evaluation. The acceptance suite should prove scope isolation between users/projects, TTL enforcement, PII redaction, preference conflict resolution, retrieval relevance on a fixed fixture corpus and deterministic delete/export behavior. A governance layer alone should not receive a score of 4 without measured retrieval and personalization behavior.

### P1 — Skill governance: score lift +0.08/5

Add a manifest schema with declared capabilities, network and filesystem permissions, required secrets, version and rollback metadata. Add trusted-source verification, static validation, progressive disclosure loading, install-time quarantine, compatibility checks and rollback. The gate is a malicious/invalid skill corpus plus install–upgrade–rollback tests. This closes the gap between having reusable skills and operating a governed skill ecosystem.

### P1 — Full CI reliability gate

Provision a reproducible Node/TypeScript/native-addon CI image. The image must run `pnpm install`, `pnpm run build`, the complete workspace test command, the score gate and the browser smoke suite. The result should publish JUnit/JSON test artifacts, approval audit samples, queue checkpoint samples and browser crash-recovery logs. Formal rescoring must be blocked if any of these artifacts are absent.

## What not to count as completed

Cloud execution, multi-agent specialist orchestration, broad external connectors, deep personalization, and production browser parity remain **not completed** by this wave. The new modules reduce the gaps, but they do not justify claiming 80% yet. The correct status is: **R0–R1 implemented; build and focused gates pass; 80.8% target is quantitatively defined; P0/P1 closure work remains.**

## Source and repository references

The benchmark weights and original evidence are stored in `benchmark/score-matrix.json` and `/home/ubuntu/manus-openclaw-benchmark-evidence.md`. The earlier comparative report is `/home/ubuntu/AgentMiki-benchmark/benchmark-report.md`. Architecture and capability-parity context is documented in `CAPABILITY-PARITY-IMPLEMENTATION.md` and `7 Architecture Gap Audit.md`.
