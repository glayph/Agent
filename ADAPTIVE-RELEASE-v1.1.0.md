# Agent Miki Adaptive Release `v1.1.0-adaptive`

## Release summary

Agent Miki-কে প্রশ্ন-নির্ভর adaptive orchestration-এর জন্য উন্নত করা হয়েছে। এখন প্রতিটি turn-এ request classification, specialist routing, contextual tool scoring, skill preference, bounded tool budget এবং execution-time allowlist একসঙ্গে কাজ করে। ফলে model-কে অপ্রাসঙ্গিক সম্পূর্ণ tool catalog দেওয়ার পরিবর্তে প্রয়োজনীয় capability surface দেওয়া হয়।

## প্রধান পরিবর্তন

| Area | Implemented behavior | Source |
|---|---|---|
| Adaptive selection | Task context, selected specialist, preferred skills এবং tool relevance মিলিয়ে capability plan তৈরি করে | `packages/core/src/adaptive-capability-selector.ts` |
| Contextual pruning | Existing pruner এখন preferred tools/skills, configurable `maxTools` এবং `minScore` গ্রহণ করে | `packages/core/src/contextual-tool-pruner.ts` |
| Prompt awareness | Model system prompt-এ selected tools, skills, context, confidence ও rationale-এর সংক্ষিপ্ত plan যুক্ত হয় | `packages/core/src/agent.ts` |
| Execution safety | Model selected catalog-এর বাইরে tool call করলে runtime execution প্রত্যাখ্যান করে এবং memory-তে failure trace রাখে | `packages/core/src/agent.ts` |
| Ambiguous requests | Low-confidence/simple turn-এ write, delete, shell, computer, browser, send, install ও runtime-জাতীয় action tools বাদ দিয়ে clarification/read-only path রাখা হয় | `packages/core/src/adaptive-capability-selector.ts` |
| Reuse | Selector optimization hub থেকে export করা হয়েছে | `packages/core/src/optimizations.ts` |
| Regression coverage | Adaptive routing, pruning, ambiguity safety এবং existing route/workflow behavior-এর focused tests যুক্ত হয়েছে | `packages/core/src/adaptive-capability-selector.test.ts` |
| Branding | Runtime-facing legacy branding references Miki naming-এ সামঞ্জস্য করা হয়েছে | Documentation এবং skill metadata |

## Runtime flow

```text
User request
    -> classifyAgentTask()
    -> routeAgentTask()
    -> selectAdaptiveCapabilities()
    -> context-aware tool ranking + skill preference
    -> bounded model-visible tool catalog
    -> model tool call
    -> execution allowlist guard
    -> tool result / safe rejection
```

> গুরুত্বপূর্ণ distinction: model-visible tool pruning এবং execution authorization দুটো আলাদা স্তর। Pruning ভুল tool দেখানো কমায়; allowlist guard model কোনো অপ্রত্যাশিত tool name তৈরি করলেও বাস্তব execution বন্ধ করে।

## Verification

The following checks passed in the clean working tree:

| Check | Result |
|---|---|
| `npm run build --workspace=@miki/config` | Passed |
| `npm run build --workspace=@miki/installer` | Passed |
| `npm run build --workspace=@miki/skills` | Passed |
| Core TypeScript typecheck | Passed |
| Focused Jest suites | **4 suites passed, 14 tests passed** |
| Tested suites | `contextual-tool-pruner`, `adaptive-capability-selector`, `agent-router`, `workflow-accelerator` |

## Known limitation

Skill documentation is searchable and can influence routing, but documentation-only skills do not automatically become executable tools unless they provide a registered runtime module or tool contract. This is intentional: Miki should not fabricate an executable capability from documentation alone.

## Security note

No API key or secret is embedded in the release source. Provider credentials must remain in the runtime environment or the project’s existing secret configuration path.
