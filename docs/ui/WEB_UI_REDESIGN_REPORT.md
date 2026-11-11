# Web UI redesign and performance update

## Scope

This update refreshes the shared UI system used by all 15 registered web routes:

- `/` — Chat
- `/drive` — Drive
- `/models` — Models
- `/config` — Configuration (raw configuration remains a view within this route)
- `/health` — Health
- `/plugins` — Plugins (section selection remains within this route)
- `/agent/monitor` — Agent Monitor
- `/channels` — Channels
- `/channels/:name` — Channel configuration
- `/memory` — Memory
- `/agent/activity` — Agent Activity
- `/agent/skills` — Skills (Discover remains a view within this route)
- `/agent/tools` — Tools
- `/launcher-login` — Sign In
- `/launcher-setup` — Setup

## Design changes

- Converted the desktop navigation to a compact 68px icon rail. Navigation labels remain available through tooltips and accessible names; the mobile drawer retains visible labels and group headings.
- Standardized header chrome, content surfaces, cards, form controls, tables, scrollbars and interaction states through shared theme tokens and page-level selectors.
- Added a short opacity/translate route entrance and restrained hover/press transitions. All new motion respects `prefers-reduced-motion`.
- Kept the authenticated pages and launcher screens on the existing theme system; no page-specific API behavior or data contracts were intentionally changed.

## Loading and performance changes

- Removed the per-placeholder infinite gradient shimmer. Skeletons now use static, low-cost surface fills and paint/layout containment.
- Replaced the authentication gate's text-only loading state with one small, accessible spinner.
- Enabled TanStack Router intent preloading with a short 80ms hover/focus delay to reduce perceived route transition time.
- Aligned mobile shell and toaster breakpoints with the existing 768px sidebar/mobile breakpoint.
- Reduced periodic authentication status polling from 15 seconds to 30 seconds; visibility-aware checks and session expiry handling remain intact.

## Functional issue corrected

`public/manus-routes.json` previously listed 25 paths, including obsolete routes that were not registered by the active TanStack route tree, and omitted the registered `/agent/activity` route. It now mirrors the 15 actual file routes. A route-metadata test was added to prevent the manifest and router from drifting apart again.

## Verification

Executed:

- Parsed all 296 TypeScript/TSX source files with the TypeScript parser: 0 syntax diagnostics.
- Parsed `src/index.css` with PostCSS: successful (531 top-level nodes).
- Compared route file declarations with `public/manus-routes.json`: 15 registered routes, 15 metadata entries, no missing or stale paths.
- Confirmed no remaining `motion-shimmer` class or shimmer keyframe references in the frontend source.
- Confirmed the updated manifest is valid JSON.

Not executed:

- Frontend build, ESLint, Vitest suite, and Playwright browser scenarios. Dependency installation did not complete in this environment; the archive does not contain `node_modules`, the install attempt timed out, and the available Node runtime is 22.16.0 while the repository root package requests Node >=22.19.0.
- Visual screenshot review against a live Gateway. No browser result is claimed.

## Files changed

- `packages/ui/frontend/src/app/layout/app-sidebar.tsx`
- `packages/ui/frontend/src/app/layout/app-layout.tsx`
- `packages/ui/frontend/src/main.tsx`
- `packages/ui/frontend/src/routes/__root.tsx`
- `packages/ui/frontend/src/shared/ui/skeleton.tsx`
- `packages/ui/frontend/src/index.css`
- `packages/ui/frontend/public/manus-routes.json`
- `packages/ui/frontend/src/app/layout/app-navigation.test.ts`
