# Miki Agentic-Behavior Audit

## Scope

This audit was performed directly against Miki's source code, runtime logs, test suite, and live gateway health. No diagnostic prompt was sent to Miki as part of the audit.

## Root causes found and fixed

### 1. Bengali investigation requests were routed as ordinary chat

The execution router did not recognize Bengali investigation/action language such as `সমস্যা`, `বিশ্লেষণ`, `খুঁজে বের`, `অনুসন্ধান`, and `সমাধান`. Requests containing these terms could be classified as `simple_message`, which explicitly disables tools.

**Fix:** Added Bengali and English investigation/action markers and verification detection. These requests now route as `task` with tools and verification enabled.

### 2. Investigation tasks did not receive a reliable discovery tool set

Adaptive capability selection could expose only a small fallback set when the request was ambiguous. A diagnostic request therefore might not receive the tools required to inspect the workspace or runtime.

**Fix:** Investigation requests now reserve `workspace_inventory`, `file_read`, and `shell_execute` when those tools are registered.

### 3. Cloud-model prompt allowed generic explanations instead of evidence-based execution

The cloud-model system prompt described tool use but did not clearly require a routed task to inspect state before answering. The model could therefore return a plausible explanation without checking the repository.

**Fix:** Added an executable-task contract requiring concrete inspection, root-cause evidence, safe in-scope changes, and verification before the final answer.

### 4. Tool loops could remain active for too long

The agent loop allowed up to 50 turns. A model alternating valid-looking tool calls could keep the UI in an `Agent is working` state for an excessive period.

**Fix:** Reduced the bounded loop limit to 20 turns while retaining duplicate-call and no-output safeguards.

### 5. Inbound idempotent events did not immediately expose a stable job

Inbound event jobs were created inside a fire-and-forget command-queue executor. The HTTP 202 response could therefore contain no job, and repeated idempotent requests could behave inconsistently.

**Fix:** Create the persistent job before command-queue scheduling. Repeated idempotency keys now return the same durable job.

### 6. Generated timestamps broke idempotency fingerprints

Two deliveries with the same idempotency key received different generated timestamps, making their payload fingerprints appear different.

**Fix:** Event fingerprints now ignore transport-generated `receivedAt` and `timestamp` fields.

### 7. Registered plugin tools lost isolated runtime paths

Plugin tools were loaded using full runtime paths but executed using only the source directory. In isolated/sandbox mode, execution could not find the previously loaded plugin contract.

**Fix:** Plugin execution now receives the complete normalized `RuntimePaths` object.

## Verification

- Core build: passed
- Full core suite: **137 test suites passed**
- Full core tests: **953 tests passed**
- Focused execution-pipeline and adaptive-selector tests: **15 passed**
- Previously failing enhancement-router and plugin-registration tests: **12 passed**
- Gateway health: `status=ok`, `coreHealthy=true`
- Gemini Flash Lite: configured and available in the running instance

## Changed files

- `packages/core/src/execution-pipeline.ts`
- `packages/core/src/execution-pipeline.test.ts`
- `packages/core/src/adaptive-capability-selector.ts`
- `packages/core/src/adaptive-capability-selector.test.ts`
- `packages/core/src/agent.ts`
- `packages/core/src/api/enhancement-router.ts`
- `packages/core/src/event-envelope.ts`
- `packages/core/src/plugins/plugin-contract-runtime.ts`
- `packages/core/src/plugins/plugin-tool-registration.ts`

## Current runtime

Miki is running on the sandbox gateway with the corrected core build and a healthy gateway/core connection.
