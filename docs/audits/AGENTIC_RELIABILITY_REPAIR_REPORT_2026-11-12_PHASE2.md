# Miki Agentic Reliability Repair — Phase 2

**Date:** 2026-11-12  
**Base:** `miki-agentic-reliability-fixed.zip` from Phase 1  
**Scope:** Auditor-model configuration visibility; no provider/model selection was guessed.

## Confirmed issue

`heartbeat.proactive.double_check_model` is empty in the supplied `config/agent.yaml`. In `AutonomousSupervisor.auditGoalOutcome()`, an empty value falls back to `options.backgroundModel?.()`. That means the second check may use the same background/default model family as the goal execution model. The second call is tool-less and separate, but it is not guaranteed to be independent or stronger.

## Change

- Added a once-per-supervisor warning when the explicit auditor model is not configured.
- The warning states that the background/default model is being used and that independence/strength is not guaranteed.
- Added regression coverage that the warning is emitted once, not on every goal.
- Clarified the YAML comment so the fallback behavior is explicit.
- Kept the auditor model unset. The archive contains no configured cloud model ID/provider selection from which a stronger model can be chosen safely.

## Verification

| Check | Result |
|---|---|
| TypeScript transpile of changed implementation and test | PASS |
| `node scripts/architecture-layout-contract.test.mjs` | PASS |
| Core TypeScript typecheck | BLOCKED: `@types/jest` and `@types/node` are absent |
| Jest regression suite | BLOCKED: Jest dependencies are absent in this workspace |

Transpile is not typecheck. The new Jest assertion has not been executed.

## Remaining decision

The owner must select an actual configured stronger auditor model/provider (for example, a specific cloud model already registered in Miki). Until then, the code reports the limitation rather than pretending that the default model is independent.

## Maintenance and status note

This is a dated investigation, plan, or implementation snapshot. Its findings and status labels describe the code and test evidence available when it was written; they are not a live assertion that every item remains current. Preserve this report as historical context. For present behavior, check the current source, the adjacent tests, and [Agent-Miki Operating Model](../AGENT_MIKI_OPERATING_MODEL.md) where applicable. Do not treat an unverified recommendation or an old checklist as proof of an enabled capability.
