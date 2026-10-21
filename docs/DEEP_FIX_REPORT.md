# Miki deep-fix report

This archive contains targeted source changes for the issues identified in the audit. It is not represented as a fully built or production-verified release.

## Changes made

1. **Feedback relevance and memory safety**
   - Follow-up feedback classification runs only for plausible explicit feedback phrases and bounded input length.
   - Previous assistant output is treated as untrusted reference data.
   - Ordinary corrections are retained as feedback experiences, not trusted long-term memory.
   - Long-term memory is written only when the user explicitly states a durable preference (for example, “from now on”, “my preference is”, or “please remember”), with a 500-character limit.
   - The explicit feedback endpoint no longer reports success when the learning store is unavailable.

2. **Learned feedback reaches later model prompts**
   - Feedback recall now considers exact request hashes and recent feedback experiences with sufficient token overlap, rather than exact hashes only.
   - Similarity is deliberately conservative and bounded to the latest 100 experiences and top 3 matches.

3. **Bounded provider retries**
   - Model-call retries default to a maximum of five retries after the first attempt (six total attempts).
   - Callers can configure a lower retry count, including zero.
   - Stop/cancellation behavior remains in place.

4. **Autonomous execution (no approval prompts)**
   - `AutonomyPolicy.decide()` returns `auto` for every tool, including tools marked `approval: "required"` and destructive tools, so Miki runs assigned tasks without asking the user for permission.
   - Rules the user has taught through feedback (`permission_learn`) are still evaluated separately by the engine.

5. **Autonomous-goal retries and notifications**
   - Repeated failed autonomous goals are capped at five attempts even if configuration requests more.
   - Approval-gate notifications are deduplicated per goal across retries, with a bounded in-memory deduplication set.

6. **Feedback endpoint abuse**
   - Added an in-memory limit of 30 feedback requests per client per minute.

7. **Tests**
   - Updated model-retry tests to assert the retry budget and zero-retry behavior.
   - Updated autonomy-policy tests to assert that every tool is decided `auto`.

## Verification limits and remaining work

- The repository dependencies are not installed in the supplied source archive. TypeScript compilation stopped before checking project code because the `jest` and `node` type definitions are missing.
- Full unit/integration tests, lint, build, and real-model evaluation have **not** passed or been run.
- The active RL policy snapshot is still not directly consumed by the autonomous supervisor's action-selection/retry logic. Learned user-feedback notes now influence relevant chat prompts, but this is not equivalent to a complete RL policy controller.
- The feedback rate limit is process-local; deployments with multiple gateway workers should use a shared store for a strict cross-worker limit.
- The classifier phrase gate is intentionally conservative and may miss feedback phrased in an unlisted language or style.

## Recommended validation

Install dependencies using the project's lockfile and supported Node version, then run the gateway and core typechecks, the targeted `model-retry`, `answer-feedback`, and `autonomy-policy` tests, the full core/gateway suites, lint, and integration tests. Review the diff before deploying.
