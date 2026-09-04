# Plugin UI Runtime QA Evidence

## Initial desktop verification

The integrated runtime served the dashboard at `127.0.0.1:18800`. The dashboard setup/login flow completed with the user-provided local password, and the authenticated workspace loaded successfully.

The primary left rail displays a dedicated Plugin icon. Clicking it opened a separate floating secondary sidebar without replacing or resizing the primary rail. The floating panel displayed Catalog, Providers & Models, Credentials, Channels, Skills, Tools, Memory, Configuration, Automation, Health, and Logs. The panel was visually aligned with the existing material sidebar style and exposed a close button.

Selecting Catalog navigated to `/plugins`. The page loaded the backend catalog and displayed **36 built-in manifests**, **32 functional**, **4 partial**, and **12 core-owned**. Provider and channel groups appeared, and the capability group rendered separately from provider/channel IDs. Searching for `gemini` reduced the visible catalog to Google Gemini while leaving the core-services explanation visible.

### Evidence screenshots

- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_09-38-16_3554.webp`: floating Plugin sidebar open from the workspace.
- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_09-38-23_6838.webp`: Plugin catalog loaded with provider/channel/capability sections.
- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_09-38-31_6253.webp`: Plugin search filtered to Gemini.

## Status

Desktop navigation and catalog rendering are operational. Additional route, close behavior, responsive, and automated verification remain part of the final QA pass.

## Cross-route and keyboard verification

The Plugin sidebar was reopened while `/models` was active, confirming the trigger remains available on legacy pages. Selecting Providers & Models navigated to `/models` and preserved the existing model configuration UI. Pressing Escape closed the floating panel while keeping `/models` active.

### Additional evidence screenshots

- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_09-38-49_5120.webp`: Plugin sidebar reopened over the filtered catalog.
- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_09-38-56_4657.webp`: Existing Models page reached through Plugin navigation.
- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_09-39-04_2319.webp`: Plugin sidebar open over Models.
- `/home/ubuntu/screenshots/127_0_0_1_2026-08-27_09-39-11_4242.webp`: Models page restored after Escape dismissal.

## Automated verification

Frontend lint passed with zero warnings. Frontend build passed and generated the `/plugins` route chunk. The frontend test suite passed with **15 test files and 67 tests**. The repository’s canonical `npm run verify` workflow also passed all verification stages, including build, typecheck, package tests, frontend tests, and doctor checks. The doctor output reported only the pre-existing optional Gemini credential warning; local llama.cpp remains available without a cloud key.

## Publication verification

Commit `5c96c2edb96e9217e331ed3f52e5316fbf728694` is present on the canonical `glayph/Agent` repository and is associated with `main`.
