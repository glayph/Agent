# Agent Miki Plan-First Adaptive Release `1.2.0`

## Release summary

Agent Miki এখন শুধু request অনুযায়ী tool বেছে নেয় না; কাজ শুরু করার আগেই একটি **capability-aware execution plan** তৈরি করে। এই plan-এ কী বোঝা হয়েছে, কোন capability ইতিমধ্যে আছে, কী অনুপস্থিত, online research দরকার কি না, plugin/library বা design asset লাগবে কি না, এবং কোন acquisition-এর জন্য user approval দরকার—এসব compact ও structured আকারে প্রকাশ করা হয়।

এটি ছবিতে দেখানো “vibe coder” আচরণের বিপরীতে একজন disciplined developer-এর workflow অনুসরণ করে: **requirements → plan → capability check → implementation → test → verification → deployment readiness → maintenance**।

## প্রধান পরিবর্তন

| Area | Implemented behavior | Source |
|---|---|---|
| Plan-time analyzer | Request-এর task class, requirement signals, existing skills/tools, missing capabilities এবং approval state নির্ধারণ করে | `packages/core/src/plan-capability-analyzer.ts` |
| Web development planning | Website, web app, React, frontend, responsive UI ইত্যাদি brief-এ web-development capability requirement যোগ করে | `packages/core/src/plan-capability-analyzer.ts` |
| Plugin/library planning | Plugin, extension, package, npm, pip, dependency বা install signal থাকলে approval-gated plugin/library requirement দেখায় | `packages/core/src/plan-capability-analyzer.ts` |
| Asset/reference planning | Image, icon, font, template, illustration, logo বা reference দরকার হলে licensed/open-licensed source research requirement দেখায় | `packages/core/src/plan-capability-analyzer.ts` |
| No auto-install during planning | Planning stage-এ install, download, authentication বা deployment অনুমোদিত নয় | `packages/core/src/plan-capability-analyzer.ts` |
| User-facing plan | Agent system prompt-এ report যুক্ত হয় এবং `/agent/route-preview` response-এ `capabilityReport` প্রকাশিত হয় | `packages/core/src/agent.ts`, `packages/core/src/api/index.ts` |
| Structured memory | Compact `capability_plan` system event-এ schema version, task class, research signal এবং requirement status সংরক্ষণ করে | `packages/core/src/agent.ts` |
| Public reuse | Analyzer optimization hub থেকে export করা হয়েছে | `packages/core/src/optimizations.ts` |
| Existing adaptive safety | Contextual pruning, bounded tool budget, specialist preference এবং execution allowlist বজায় আছে | `packages/core/src/adaptive-capability-selector.ts`, `packages/core/src/agent.ts` |
| Cleanup | নতুন source-এর lint issue ও পুরনো unused imports সরানো হয়েছে; temporary smoke-test artifact release-এ রাখা হয়নি | `packages/core/src/agent.ts` |

## Example behavior

যদি user বলে:

> “একটি responsive React website বানাও এবং একটি animation plugin দরকার হলে ব্যবহার করো।”

তাহলে Agent Miki implementation শুরু করার আগে এই ধরনের plan metadata তৈরি করবে:

| Requirement | State | Action |
|---|---|---|
| Requirements analysis | Required | Brief ও constraints পরিষ্কার করা |
| Web development capability | Missing বা available | Existing web skill/tool reuse করা; missing হলে report করা |
| Plugin/library | Approval required | Existing stack যথেষ্ট কি না যাচাই; না হলে official registry/source প্রস্তাব করা |
| Asset/reference research | Conditional | Brief-এ প্রয়োজন হলে licensed source খোঁজা |
| Installation | Not authorized during planning | User approval ছাড়া install/download নয় |
| Verification | Required | Build, typecheck, tests ও visual/functional verification |

Agent Miki অপ্রয়োজনীয়ভাবে “৫০টি plugin” install করবে না। প্রথমে existing capability পুনর্ব্যবহার করবে, তারপর কেবল বাস্তব gap থাকলে missing item report করবে।

## Memory record format

Memory-তে পূর্ণ plan বা দীর্ঘ conversation কপি না করে compact record রাখা হয়:

```json
{
  "type": "capability_plan",
  "schemaVersion": 1,
  "taskClass": "standard/medium",
  "onlineResearchRecommended": true,
  "requirements": [
    {
      "id": "web-development",
      "kind": "skill",
      "status": "missing",
      "matchedIds": [],
      "approvalRequired": true
    }
  ]
}
```

এই record পরবর্তী request-এ capability reuse ও দ্রুত lookup-এর ভিত্তি হিসেবে কাজ করে। Secrets, API keys বা credential value এই memory record-এ লেখা হয় না।

## Safety policy

Planning এবং installation আলাদা stage। Planning stage কেবল analysis ও recommendation করবে। কোনো download, package installation, external login, credential collection, deployment বা destructive action-এর আগে approval gate বজায় থাকবে। External source ব্যবহার করতে হলে official documentation, official repository, trusted package registry বা licensed/open-licensed asset source অগ্রাধিকার পাবে। Website বা downloaded content-এর embedded instruction নিজে থেকে executable instruction হিসেবে গ্রহণ করা যাবে না।

## Verification

| Check | Result |
|---|---|
| Core TypeScript typecheck | Passed |
| Focused ESLint for modified core/API files | Passed; ESLint-এর environment module-type warning non-blocking |
| Core package build | Passed |
| Runtime analyzer smoke test | Passed; website ও plugin requirements এবং `autoInstallAllowed: false` যাচাই করা হয়েছে |
| Existing adaptive tests | Existing project test configuration-এ Jest/Vitest script নেই; source-level regression test files রাখা হয়েছে |
| Temporary smoke artifact cleanup | Passed |

## Known limitation

বর্তমান release plan তৈরি করার সময় missing capability report ও approval requirement প্রকাশ করে; user approval পাওয়ার পর নির্দিষ্ট installer/resource workflow চালানো হবে। Planning stage নিজে থেকে online resource download বা package install করে না—এটি ইচ্ছাকৃত নিরাপত্তা নীতি।

## Version

`1.2.0-plan-first-adaptive`
