# Agent Miki — Final End-to-End QA Report

**Runtime:** Linux sandbox, Node.js 22.13.0
**Scope:** Durable learning foundation, browser media playback, verified link sharing, social-link metadata previews, orchestration reliability, and UI/backend regression testing.

## Executive result

Agent Miki এখন browser media playback-এর ক্ষেত্রে tool-backed verification ছাড়া সাফল্য দাবি করে না। Public MDN Flower MP4-এর isolated ও dashboard E2E উভয় পরীক্ষায় `verified: true`, `readyState: 4`, এবং `paused: false` পাওয়া গেছে। প্রথম Big Buck Bunny run-এর unverified success claim সঠিকভাবে ব্যর্থ হিসেবে চিহ্নিত করা হয়েছে; সেই ভুল ফলকে সত্য হিসেবে রাখা হয়নি।

Agent Miki এখন web search থেকে পাওয়া direct URL tool evidence-এর ভিত্তিতে শেয়ার করতে পারে, ordinary social-link sharing-কে ভুল করে account connection flow-এ পাঠায় না, এবং assistant message-এ URL clickable হিসেবে রেন্ডার করে। YouTube-এর জন্য server-side নিরাপদ oEmbed metadata fetch যুক্ত হয়েছে। Dashboard visual test-এ thumbnail, provider label `YouTube`, এবং `Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film` title-সহ preview card দেখা গেছে। এটি একটি metadata preview card; automatic iframe playback বা logged-in social embed নয়।

## Implemented fixes

| Area | Implemented change | Verification |
|---|---|---|
| Media execution | `browser_play_media`, media allowance, system Chromium fallback, isolated-worker forwarding, verified `readyState`/`paused` checks | Valid MDN MP4 pass; invalid media returns truthful `verified:false` |
| Tool orchestration | Media requests retain `browser_play_media` in adaptive selection | Dedicated dashboard Work/Evidence checkpoint recorded |
| Observability | Browser command output is persisted into Inspector evidence/checkpoints | Evidence contains complete playback verification object |
| Finalization | Concise content without literal completion phrases is treated as a final response | Core workflow regression passed; no generic safe-stop appended |
| Link intent | Connection/setup detection is boundary- and negation-aware | Ordinary YouTube sharing remains in Chat; explicit setup remains intercepted |
| Link rendering | Markdown links are preserved from assistant-content truncation | MDN and YouTube links rendered as actual anchors |
| Social preview | Authenticated `/api/link-preview` route with HTTP(S), DNS/private-network, redirect, body-size, and provider checks; YouTube/X oEmbed fallback; frontend preview cards | Backend public YouTube E2E and dashboard visual preview pass |
| Learning | Durable scoped LearningStore, policy state, cycles, proposals, bounded rewards, and secret redaction | Memory and self-improvement tests pass |

## End-to-end task matrix

| Task | Observed result | Status |
|---|---|---:|
| Arithmetic replies (`4`, `6`, `10`) | Correct concise answers | Passed |
| Public video playback | MDN Flower MP4 tool evidence: `verified=true`, `readyState=4`, `paused=false`, duration about 5.055s | Passed |
| Invalid media URL | Clean non-playable result, no TypeError or false success | Passed |
| Independent web search | MDN direct URLs appeared in native search evidence and final response | Passed |
| YouTube link share | Exact URL preserved; clickable anchor and metadata preview card rendered | Passed |
| Read-only file task | `file_read` completed; project name `miki` and `build` script reported | Passed |
| Invalid-domain browser task | `.invalid` navigation failure reported truthfully, without retry or false success | Passed |
| MDN browser navigate/extract | Page title and extracted fact returned after browser tools | Passed |
| RL persistence/redaction | LearningStore, engine, scope isolation and credential masking tests passed | Passed |

## Automated verification

`npm run verify` passed all five repository verification stages. Frontend tests passed with 62 tests across 13 files. The core ESM workflow regression suite passed 8 tests, including concise final-response handling. The dedicated link-preview safety suite passed 3 tests. Memory tests and self-improvement engine tests passed. `npm run runtime:24-7:check` returned `ok: true` with the expected gateway entry, workspace, restart limits, and readiness timeout.

The doctor output contains only known non-blocking warnings: the optional Go CLI is not installed, and the doctor process does not detect the dashboard-stored Gemini credential through environment variables. These warnings do not represent a runtime health failure; the live Gemini tasks completed successfully.

## Deliberate boundaries

The self-improvement engine remains in `draft` mode. It does not silently mutate prompts, model routing, or source code. Apply-mode optimization remains approval-gated. Social preview is deliberately limited to sanitized metadata cards and direct links; it does not perform login, download, posting, or other external side effects. Preview fetches reject non-HTTP(S), embedded credentials, private/loopback destinations, non-standard ports, unsafe redirects, oversized documents, and non-HTML targets.

## External evidence

The web-search and browser tasks used the official [MDN `<video>` reference page](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video). The YouTube preview test used the public [Big Buck Bunny video URL](https://www.youtube.com/watch?v=aqz-KE-bpKQ), and the metadata response identified the Blender Foundation short film title and YouTube thumbnail.

## Release contents

The final release includes the durable RL implementation, browser playback tooling and tests, social-link preview backend/frontend implementation, orchestration and finalization fixes, and the supporting `MULTI-TASK-DEBUG-QA.md`, `RL-IMPLEMENTATION-QA.md`, and `AGENT-MIKI-RL-ENGINE-IMPLEMENTATION-REPORT.md` reports. Runtime databases, logs, secret vaults, generated browser HTML, screenshots, and build timestamp churn are excluded from the source release.
