# Agent Miki Plugin UI Redesign

**Design direction:** Ink & Lime Ultraminimal

**Scope:** Plugin catalog, plugin navigation, provider/model pages, credentials, channels, skills, tools, memory, configuration, automation, health and logs surfaces

**Runtime:** Agent Miki local gateway on `127.0.0.1:18800`

## What changed

The plugin area now uses a restrained off-white/graphite canvas with one lime accent. The previous Material-inspired orange surface, floating overlay treatment, heavy shadows and tightly packed icon tiles were replaced with thin rules, flat panels, compact typography and a clear two-column information hierarchy.

The plugin catalog now presents each runtime surface as a readable tile containing its name, stable plugin ID and status dot. Family sections use uppercase micro-labels and dividers instead of visually heavy cards. The selected plugin uses a single dark edge treatment and a flat inspector panel, keeping the detail view legible without adding visual noise.

The plugin navigation is now a full-height panel anchored to the existing rail. It contains three explicit groups—Plugin catalog, Adapters and Core services—with a visible close button, keyboard hint and a small active-state dot. The existing routes and navigation semantics remain unchanged.

The redesign is scoped to routes identified as plugin/admin surfaces. Chat, launcher authentication and non-plugin workspace surfaces retain their existing styling. Runtime APIs, React Query state, route definitions, model controls, channel forms, skill actions and health actions were not replaced.

## Validation

| Check | Result |
|---|---|
| Frontend build | Passed |
| Frontend lint | Passed |
| Frontend tests | 15 files and 68 tests passed |
| Embeddable backend bundle | Passed |
| Plugin catalog visual test | Passed |
| Plugin sidebar visual test | Passed |
| Models visual test | Passed |
| Channels visual test | Passed |
| Skills visual test | Passed |
| Health visual test | Passed |
| Desktop screenshot evidence | 8 screenshots captured |
| Mobile screenshot automation | Not captured because the installed Playwright browser binary was unavailable; responsive CSS was reviewed and the existing browser viewport was used for functional visual verification |

## Screenshots

The redesigned visual evidence is in `docs/plugin-redesign-screenshots/`. Start with [00-contact-sheet.webp](./plugin-redesign-screenshots/00-contact-sheet.webp), then use [screenshot-index.md](./plugin-redesign-screenshots/screenshot-index.md) for individual captures. The final Drive capture confirms that the same style is applied outside the plugin routes.

## Known limitation

The local runtime was restarted with the rebuilt embeddable frontend bundle. The screenshot pass used the authenticated local dashboard at the available desktop browser viewport. A separate mobile Playwright capture was not possible in this sandbox because the required browser executable was not installed; no application code was changed to work around that environment limitation.
