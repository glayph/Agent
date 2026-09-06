# Agent Miki — Inspector / Live Inspector + packaging fixes (complete)

This package combines everything fixed across two sessions: the Inspector /
Live Inspector event-emission work, and the npm-packaging test-file leak
found while auditing it.

## Files in this package

```
packages/core/src/api/index.ts                              (modified)
packages/core/src/api/inspector-events.ts                   (new)
packages/core/src/api/inspector-events.test.ts               (new)
packages/ui/frontend/src/features/monitor/store.test.ts      (new)
packages/ui/frontend/src/features/monitor/protocol.test.ts   (new)
scripts/prepare-runtime-package.mjs                          (modified)
scripts/runtime-package-filters.mjs                          (new)
scripts/runtime-package-filters.test.mjs                     (new)
```

Copy these into your working tree at the matching paths (they mirror your
repo root), overwriting the two modified files.

## 1. Inspector / Live Inspector fixes

**packages/core/src/api/index.ts**
- Removed the hardcoded, always-wrong `node_type: "tool"` field from the
  `node.spawn` websocket payload. The frontend never read this field — it
  always infers the correct type (`tool`/`skill`/`plugin`/`file`/`command`/
  `pattern`/`system`) from the `label` (tool name) itself via
  `inferNodeType()` in `features/monitor/protocol.ts`. Sending a field that
  was always `"tool"` even for plugin/skill/file calls was misleading and
  unused — safer to remove than to wire up.
- The pure tool-description/preview helpers (`_previewToolArgs`,
  `_previewToolOutput`, `_toolActionDescription`, `_toolResultDescription`)
  and the inspector-thought payload builder (`_sendInspectorThought`) now
  delegate to the new `inspector-events.ts` module. Behavior is unchanged —
  same strings, same two independent `crypto.randomUUID()` calls, same
  early-return on blank content.

**packages/core/src/api/inspector-events.ts** (new)
- Pure, dependency-free helpers extracted from `api/index.ts`, callable
  without constructing the module's live `AgentOrchestrator` (which
  `api/index.ts` instantiates at import time — the reason that file has
  never had direct unit tests).
- Includes `inferInspectorNodeType()`, a backend-side mirror of the
  frontend's node-type inference, kept here so the mapping has one source
  of truth with test coverage.

**packages/core/src/api/inspector-events.test.ts** (new) — 32 tests
covering all the extracted helpers, including the `kind: "thought"` +
`inspector_only: true` contract that keeps model "thinking" out of the
normal chat bubble UI, and real plugin tool-name classification
(`plugin_hubspot_create_contact` → `plugin`).

**packages/ui/frontend/src/features/monitor/store.test.ts** (new) —
14 tests covering the Live Inspector's node/edge/run state machine
(`clearMonitorRun`, `selectMonitorNode`, `toggleNodeUIState`, etc.), which
previously had zero coverage.

**packages/ui/frontend/src/features/monitor/protocol.test.ts** (new) —
21 tests covering `handleMonitorMessage`, the function that turns
`node.run_start` / `node.spawn` / `node.update` / `node.complete` /
`node.run_end` websocket messages into monitor store state — including
edge-animation stop-on-completion/failure and level-based edge wiring
between planner "waves."

## 2. Packaging fix — test files no longer leak into the published npm package

While auditing whether the Inspector fix would survive a real
`npm run build:all && npm pack`, a full clean-build + `npm pack --dry-run`
simulation surfaced a pre-existing issue: `@miki/memory` ships as plain JS
source with no build step (`prepare-runtime-package.mjs`'s
`sourceOnlyPackageNames` path copies all of `src/` directly). That copy had
no test-file filter, so `packages/memory/src/test/*.test.js` (and
`tkg-test-runner.js`) ended up inside the published npm tarball.

**scripts/runtime-package-filters.mjs** (new) — pure, side-effect-free
predicates:
- `shouldCopyRuntimeFile(path)` — excludes `.map` files (unchanged
  behavior) **and** now excludes `*.test.js/.ts/.jsx/.tsx/.mjs/.cjs` files.
- `isExcludedTestDirectory(path)` — excludes whole `test/`, `tests/`,
  `__tests__/`, `__mocks__/` directories (catches `tkg-test-runner.js`,
  which doesn't match the `.test.<ext>` filename pattern but lives inside
  `src/test/`).

Verified against the whole codebase: no legitimate (non-test) directory
anywhere under `packages/*/src` uses any of those four names, so this
cannot exclude real runtime content. Also verified the filename pattern
doesn't false-positive on files that merely contain the word "test" (e.g.
`tkg-test-runner.js`, `latest-results.js`) — that's handled instead by the
directory-level exclusion.

**scripts/prepare-runtime-package.mjs** (modified) — imports and uses the
two predicates above in `copyRecursive` instead of the old inline
`.map`-only check. This is a general fix (not memory-specific): it applies
uniformly to every `copyRecursive` call, so it also guards `core`/`gateway`/
`skills` if a stray test artifact ever ends up in a built `dist/`.

**scripts/runtime-package-filters.test.mjs** (new) — 8 tests
(`node:test`, matching this repo's existing `scripts/*.test.mjs`
convention) covering both predicates, including the case-insensitivity and
false-positive-avoidance cases above.

Note: `@miki/memory`'s own `npm run test --workspace=@miki/memory` script
still runs `src/test/*.test.js` directly from source and is completely
unaffected — this fix only changes what gets copied into the **published**
runtime bundle, not the source tree or the dev test workflow.

## How to apply

1. Copy the files above into your working tree at the matching paths.
2. From the repo root:
   ```
   npm run test --workspace=@miki/core -- --testPathPattern="inspector-events"
   npm --prefix packages/ui/frontend run test -- src/features/monitor
   node --test scripts/runtime-package-filters.test.mjs
   ```
3. Do a full rebuild + pack to confirm end-to-end:
   ```
   npm run build:all
   npm run test --workspaces --if-present
   npm pack --dry-run --workspace=@miki/cli
   ```
   Look for `inspector-events.js`/`.d.ts` in the tarball listing (should be
   present, two copies) and confirm no `*.test.*` files appear anywhere in
   the listing.

## Verification performed (this environment)

- Full `@miki/core` suite: **101 suites / 632 tests passing** (no
  regressions from either fix).
- Full frontend suite: **18 files / 124 tests passing** (no regressions).
- `scripts/runtime-package-filters.test.mjs`: **8/8 passing**.
- `@miki/memory`'s own test script (`npm run test --workspace=@miki/memory`):
  still passes in full, confirming the packaging fix didn't touch the dev
  workflow.
- A full clean build (`config` → `installer` → `skills` → `core` →
  `gateway` → frontend, in the same order `build:all` uses) followed by
  `node scripts/prepare-runtime-package.mjs` and a real
  `npm pack --dry-run --workspace=@miki/cli`:
  - `inspector-events.js` / `.d.ts` present in the tarball (both under
    `packages/core/dist` and `node_modules/@miki/core/dist`).
  - Zero `*.test.*` files anywhere in the tarball listing.
  - All 14 of `@miki/memory`'s production `.js` files present and intact.
  - Tarball file count dropped from ~44,625 to ~42,844 after the fix
    (reflecting the removed test files), package size dropped
    correspondingly.

## Known pre-existing issue (not touched here, worth its own session)

`tsc -p tsconfig.json --noEmit` on `packages/core`, if you build it in
isolation before its workspace dependencies, reports
`Cannot find module '@miki/config'`. This resolves itself when packages
are built in dependency order (`config` → `installer` → `skills` → `core`,
which is what `npm run build:all` already does) — it is not a bug in the
code, just a reminder to always use `npm run build:all` rather than
building `@miki/core` on its own from a clean checkout.

Separately: if a package's `.tsbuildinfo` file exists but its `dist/`
folder doesn't (e.g. from manually deleting only `dist/` instead of
running the package's `clean` script), `tsc` in composite/incremental mode
will silently no-op — exit code 0, no error, but nothing gets rebuilt. Use
`npm run build:all` (which runs `clean --workspaces` first) or each
package's own `npm run clean` rather than manually deleting `dist/`.
