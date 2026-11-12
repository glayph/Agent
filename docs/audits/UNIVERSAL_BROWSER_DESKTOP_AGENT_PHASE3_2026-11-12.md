# Phase 3 — Universal Browser and Desktop Agent

Date: 2026-11-12

## Implemented

- Replaced the bundled browser-runtime path with a paired WebExtensions bridge. There is no Playwright runtime dependency or browser installer in the project manifests or source scripts.
- Added source bundles and build packaging for Chromium browsers (Chrome, Edge, Brave, Opera, Vivaldi and Chromium), Firefox and Safari.
- Added a browser extension packaging test covering the three manifests and required extension assets.
- Added/retained application-control backends: Windows UI Automation, macOS System Events Accessibility, Linux AT-SPI and Linux X11 input utilities.
- Corrected Linux Wayland reporting: AT-SPI semantic controls may work when its accessibility bus is present; X11 coordinate controls/screenshots remain unavailable in a Wayland-only session.
- Aligned the owner configuration with no per-action confirmation prompts (`auto_approve_all: true`, destructive/computer confirmation flags false), full browser/computer capabilities, and unrestricted file-tool paths (`allow_all_paths: true`).
- Removed stale Playwright installation documentation and installer references. The remaining `@vitest/browser-playwright` strings in lockfiles are optional peer-dependency metadata shipped by Vitest; no such package is directly installed or referenced by project scripts.
- Added the browser/desktop capability and installation guide at `docs/architecture/UNIVERSAL_BROWSER_AND_DESKTOP_AGENT.md`.

## Confirmation and OS permission boundary

Miki's own per-tool/per-action confirmation prompts are disabled by the configured owner no-confirm mode. File tools may target paths visible to the Miki process account, and autonomous runs expose all registered tools when auto-approve-all is active. This is an application-level setting, not an operating-system sandbox; run it inside a disposable VM/container to isolate the host. OS/browser permissions and platform-level access checks remain in force.

No code can silently grant browser extension host access, macOS Accessibility/Screen Recording, or other OS-managed capabilities. Those remain under the browser and operating system's control. Safari requires Xcode packaging/signing as a Safari Web Extension app.

## Verification performed

- `node --check` passed for browser extension JavaScript and build/qualification scripts.
- TypeScript syntax transpilation passed for the changed browser, computer-use and gateway files using the available global TypeScript compiler.
- Python syntax compilation passed for `atspi_bridge.py`.
- JSON and YAML parsing passed for manifests, package manifests and `config/agent.yaml`.
- `build-browser-agent.mjs` generated complete Chrome, Firefox and Safari extension output folders; each generated manifest parsed as Manifest V3.
- Static dependency check confirmed no direct Playwright package dependency or Playwright browser installer remains.

## Not verified in this environment

- Full TypeScript project typecheck, ESLint, Jest/Vitest suites and complete workspace build were not run: `node_modules` is absent, Jest/ESLint/Vitest are unavailable, and the available Node runtime is 22.16.0 while this repository requires Node >=22.19.0.
- No live browser extension installation, Safari Xcode package, interactive Windows/macOS desktop, Linux AT-SPI bus, or real application control was available here. Target-device qualification remains necessary.

## Archive hygiene

The Phase 3 source ZIP intentionally excludes runtime databases, browser profiles, secret-vault files, local identity memory, `.env` files, build output, caches and dependencies. These are machine/user state, not source code.

## Maintenance and status note

This is a dated investigation, plan, or implementation snapshot. Its findings and status labels describe the code and test evidence available when it was written; they are not a live assertion that every item remains current. Preserve this report as historical context. For present behavior, check the current source, the adjacent tests, and [Agent-Miki Operating Model](../AGENT_MIKI_OPERATING_MODEL.md) where applicable. Do not treat an unverified recommendation or an old checklist as proof of an enabled capability.
