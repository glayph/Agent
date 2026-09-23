# Miki Agent Test Workflow

Target: app
Created: 2026-09-23T12:58:36.680Z

## Brief
Create a folder 'repaired-agent-test', inside it a file 'summary.md' with five practical numbered examples of Agent Miki’s capabilities, then verify folder and file existence, exact number of entries, and provide the final path and summary.

## Architecture
Modular vertical-slice architecture with domain, adapter, interface, and verification layers.

- ui: User flows, state, responsive layout, and accessibility.
- api: Backend endpoints, auth boundary, validation, and integration contracts.
- domain: Core business rules independent from UI and transport.
- persistence: Data models, migrations, caching, and recovery behavior.
- tests: Unit, integration, visual, and smoke verification gates.

## File Tree
- [must] miki-agent-test/README.md - Project overview, setup, and delivery checklist.
- [must] miki-agent-test/docs/architecture.md - Architecture decisions, boundaries, and data flow.
- [must] miki-agent-test/src/index.ts - Main application or library entry point.
- [must] miki-agent-test/src/domain/index.ts - Core domain rules separated from adapters.
- [should] miki-agent-test/src/adapters/index.ts - External service and platform adapter boundary.
- [must] miki-agent-test/tests/smoke.test.ts - End-to-end or integration smoke gate.
- [must] miki-agent-test/scripts/verify.mjs - Portable scaffold verification used by post-generation gates.
- [must] miki-agent-test/package.json - Scripts for build, test, lint, and smoke.

## Milestones
### Blueprint
Requirements, architecture, and risk plan are explicit before writing broad code.
- Extract concrete requirements from the brief and any sketches/assets.
- Define module boundaries, data flow, and runtime constraints.
- Choose the smallest vertical slice that proves the architecture.
- Gate: blueprint review - Requirements and acceptance gates are written down.

### Vertical Slice
A minimal running artifact proves the highest-risk path.
- Create the workspace and core files.
- Implement the startup path and one end-to-end user/system workflow.
- Keep placeholders isolated behind interfaces so later expansion does not require rewrites.
- Gate: unit tests (node scripts/verify.mjs test) - Core behavior and adapters pass focused tests.
- Gate: build (node scripts/verify.mjs build) - Production artifact builds without type or bundling errors.

### Feature Expansion
Expected capabilities are added behind the established boundaries.
- Implement modules in dependency order.
- Add regression tests next to each module contract.
- Run smoke checks after each meaningful integration step.
- Gate: unit tests (node scripts/verify.mjs test) - Core behavior and adapters pass focused tests.
- Gate: build (node scripts/verify.mjs build) - Production artifact builds without type or bundling errors.
- Gate: smoke (node scripts/verify.mjs smoke) - Primary user workflow works in runtime.

### Hardening
The artifact is maintainable, testable, and ready for review.
- Remove dead paths, insecure defaults, and placeholder behavior.
- Document setup, limitations, and verification evidence.
- Run the full gate list from a clean state.
- Gate: unit tests (node scripts/verify.mjs test) - Core behavior and adapters pass focused tests.
- Gate: build (node scripts/verify.mjs build) - Production artifact builds without type or bundling errors.
- Gate: smoke (node scripts/verify.mjs smoke) - Primary user workflow works in runtime.

## Review Loop
- Plan the smallest next change.
- Edit only the files needed for that change.
- Run the narrowest meaningful gate.
- Broaden tests/build/smoke before declaring the milestone done.
- Record evidence and remaining risk.
