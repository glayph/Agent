# Miki Web UI — Phase 3 Loading Performance

**Date:** 2026-10-03 00:42 (+06:00)  
**Scope:** Initial loading and static asset delivery optimization.

## Completed

### 1. Deferred syntax-highlighting preload

The generated initial HTML previously preloaded `vendor-highlight-*.js`, even though syntax highlighting is used by deferred Markdown/code-block UI rather than the application shell.

Updated `packages/ui/frontend/vite.config.ts` to exclude `vendor-highlight` from the initial module-preload dependency list, alongside the existing deferred Markdown/code-block chunks.

Initial preload list after the change contains the core runtime dependencies but no `vendor-highlight` entry:

```text
rolldown-runtime
vendor-i18n
vendor-tanstack
vendor-react
vendor-ui
utils
vendor-icons
```

The highlight vendor chunk remains in the build and loads when the relevant feature needs it; this change does not remove functionality.

### 2. Immutable caching for hashed assets

Updated `packages/gateway/src/index.ts` to apply:

```text
Cache-Control: public, max-age=31536000, immutable
```

for Vite hashed JS, CSS, font, image, and icon assets. HTML remains revalidation-safe and is not given a one-year immutable cache policy.

Verified live:

```text
GET /assets/index-B6h6gFv-.js -> HTTP 200
Cache-Control: public, max-age=31536000, immutable
```

## Measurements

| Metric | Phase 1 baseline | Phase 3 result |
|---|---:|---:|
| Raw JS/CSS assets | ~2.51 MB | ~2.51 MB |
| Estimated gzip JS/CSS total | ~728 KB | unchanged; compression was already effective |
| Initial `vendor-highlight` preload | Present | Removed |
| Hashed asset cache policy | `max-age=0` | 1 year + immutable |
| Gateway health | HTTP 200 | HTTP 200, `coreHealthy: true` |
| Frontend lint | Passed after Phase 2 | Passed |
| Prettier format | Passed after Phase 2 | Passed |
| Frontend tests | 18 files / 124 tests | 18 files / 124 tests |
| Frontend build | Passed | Passed |
| Gateway build | Passed | Passed |
| Live Channels page | Working | Working after Phase 3 runtime restart |

Raw bundle size is unchanged because this phase targeted **delivery behavior** rather than deleting runtime features. The main improvement is lower repeat-load cost through immutable caching and lower initial connection contention by deferring syntax highlighting.

## Runtime verification

The refreshed 24/7 supervisor is running with the Phase 3 frontend and gateway builds. The live Web UI was opened at the Channels category route and rendered correctly after the changes.

## Next phase

Phase 4 should focus on interaction quality, responsive layouts, accessibility, loading/error/empty states, keyboard navigation, and long-list behavior across the major pages.
