# Miki Web UI — Phase 1 Baseline Audit

**Date:** 2026-10-03 00:35 (+06:00)  
**Scope:** Baseline measurement only. No production UI behavior was changed during this phase.

## Executive summary

The current Web UI is functional and the new plugin category routes render correctly in the live Web UI. The baseline also exposes three priority issues for the next optimization phases:

1. **Deep-link refresh is not production-safe:** `/plugins/channels` returns HTTP 404 from the gateway on a direct request, even though client-side navigation works.
2. **Code-quality gate is not clean:** ESLint fails because one React Hook dependency warning is treated as an error by `--max-warnings=0`.
3. **Formatting is not clean:** Prettier reports 26 files with formatting differences.

The current production bundle is already route-split, but the raw asset payload is approximately **2.7 MB** before transfer compression. The largest JavaScript assets are the monitor page, the main application chunk, React, syntax highlighting, UI primitives, and Markdown rendering.

## Measurements

| Area | Baseline result | Interpretation |
|---|---:|---|
| Frontend source files | 309 | Large enough to benefit from shared patterns and targeted audits |
| Route source files | 26 | Includes the nested plugin routes and auth routes |
| Public route manifest entries | 34 | Manifest is valid and served separately from SPA HTML |
| Route manifest size | 1,929 bytes | Well below the 1 MiB limit |
| Frontend production build | ~1.4 seconds in recent frontend-only builds | Fast local frontend build |
| Root project build | 29,297 ms | Full workspace build is the slower pipeline to optimize later |
| Frontend test suite | 18 files / 124 tests passed | Functional regression baseline is green |
| Frontend lint | Failed: 1 warning | `src/pages/chat-page.tsx:585` has an unnecessary `defaultModelName` dependency |
| Prettier check | Failed: 26 files | Formatting drift exists across existing and recently touched files |
| Dist JS/CSS assets | ~2.7 MB raw | Candidate for further transfer and runtime optimization |
| Gateway health | HTTP 200, `status: ok`, `coreHealthy: true` | Runtime is healthy |
| Route manifest endpoint | HTTP 200, valid JSON | Discovery contract is working |
| Root HTML | HTTP 200 | Root entry loads correctly |
| Direct `/plugins/channels` request | HTTP 404 | Deep-link fallback must be fixed |
| Public root URL | HTTP 200 | Public Web UI is reachable |

## Bundle baseline

Largest raw production assets measured from `packages/ui/frontend/dist/assets`:

| Asset | Size |
|---|---:|
| `monitor-*.js` | 397 KB |
| `index-*.js` | 307 KB |
| `index-*.css` | 268 KB |
| `vendor-react-*.js` | 182 KB |
| `vendor-highlight-*.js` | 162 KB |
| `vendor-ui-*.js` | 151 KB |
| `vendor-markdown-*.js` | 118 KB |
| `vendor-tanstack-*.js` | 108 KB |
| `models-*.js` | 86 KB |
| `chat-page-*.js` | 78 KB |

These are raw file sizes from the generated `dist` directory; transfer sizes will differ when the server/browser applies compression.

## Route and Web UI observations

The live browser verification confirmed:

- `/plugins` renders an overview page with category cards.
- `/plugins/providers` renders only provider plugins.
- `/plugins/channels` renders only channel plugins.
- `/plugins/capabilities` renders capability plugins.
- `/plugins/core` renders core-owned plugins and core service cards.
- Category navigation remains visible and the active category is highlighted.
- The old plugin drawer is no longer used.

The browser navigation test used the public Sandbox Web UI URL. The direct HTTP request test separately exposed the refresh/deep-link issue, so Phase 2 should address server fallback behavior rather than changing the client route structure.

## Code-quality findings

### Lint

Command:

```bash
npm run lint
```

Result: failed because warnings are disallowed. Current warning:

```text
src/pages/chat-page.tsx:585:5
React Hook useCallback has an unnecessary dependency: 'defaultModelName'
```

### Formatting

Command:

```bash
npm run format
```

Result: failed. Prettier reported **26 files**. The list includes shared pages/components, theme files, route configuration, `public/manus-routes.json`, and the recently changed plugin files.

### Tests

Command:

```bash
npm --prefix packages/ui/frontend run test -- --run
```

Result: **18 test files passed, 124 tests passed**. The two stderr messages are expected test scenarios for simulated gateway/socket failures; they did not fail tests.

## Phase 1 conclusion

The baseline is strong enough to begin optimization safely: the UI builds, the test suite is green, the gateway is healthy, and the plugin multi-page experience works in the browser. The next phase should focus on **stability and delivery correctness before visual or bundle refinements**.

## Recommended five-phase optimization sequence

1. **Phase 1 — Baseline audit:** completed in this report.
2. **Phase 2 — Stability and quality:** fix deep-link fallback, clear the lint warning, and normalize formatting without changing product behavior.
3. **Phase 3 — Loading performance:** inspect route chunks, compression/cache headers, heavy monitor/Markdown/highlight dependencies, and avoid unnecessary initial work.
4. **Phase 4 — Interaction and responsive UX:** audit loading/error/empty states, mobile layouts, keyboard navigation, focus states, and long-list behavior.
5. **Phase 5 — Final hardening:** run full build/tests, browser route checks, accessibility/performance checks, update the route manifest, and package a verified source archive.
