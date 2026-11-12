# Agent-Miki Upgrade — TODO and Verification Record

This file records the implementation requested for the supplied Agent-Miki project. The scope covers the Agent-Miki persona/identity, Miki-owned Markdown documentation, runtime identity integration, and the Chat UI Top Bar.

**Protected scope:** `Skills.md`, every `SKILL.md`, the complete bundled skill catalogue under `packages/core/src/plugins/skills/`, and third-party/vendor Markdown under the llama.cpp source subtree were not edited.

## Phase 0 — Baseline and inventory

- [x] Extract and inspect the supplied project archive.
- [x] Identify identity files, persona configuration, prompt assembly, autonomous supervisor, Chat Top Bar and global header actions.
- [x] Identify test/build scripts and Node.js requirement.
- [x] Inventory Miki-owned Markdown and protected Skill/vendor documentation.
- [ ] Run baseline unit/build tests before edits. **Blocked:** the archive had no installed dependencies, npm cache was empty, and the container uses Node.js `22.16.0` while this root workspace requires `>=22.19.0`.

## Phase 1 — Persona and identity

- [x] Replace conflicting blanket `NEVER REFUSE` / `NEVER ASK PERMISSION` instructions with autonomy inside real authorization, safety and runtime boundaries.
- [x] Clarify model invocation lifecycle versus host-side autonomous supervisor and durable workers.
- [x] Upgrade `config/agent.yaml` persona and the SOUL, identity, operating manual, tool map, owner preferences, drives, interests, heartbeat and specialist profile documents.
- [x] Explain real capabilities, live tool discovery, planning, persistence, recovery, verification and truthful reporting.
- [x] Clarify that skills are procedural knowledge, specialist profiles do not create workers, and plugins/MCP have separate lifecycle/permission states.
- [x] Keep ambient supervisor permissions distinct from interactive/goal execution permissions.

## Phase 2 — Runtime prompt integration

- [x] Load `IDENTITY.md` and `TOOLS.md` in the interactive identity prompt.
- [x] Keep current tool registry, exact schema, permission state and approval gates authoritative.
- [x] Supply compact identity/capability context to the host-side autonomous supervisor.
- [x] Keep file fallback/cache behavior and required SOUL handling intact.
- [x] Update identity prompt tests for the new file loading and safety contract.

## Phase 3 — Chat UI Top Bar

- [x] Replace empty status input with real Gateway/WebSocket/autonomy-derived status pills.
- [x] Distinguish Gateway lifecycle/connectivity, foreground response, autonomous work, paused state and active goals.
- [x] Make status pills navigate to Health or Agent Activity.
- [x] Wire the working indicator to Activity instead of looking for a callback on an unrelated status pill.
- [x] Show all desktop statuses and keyboard-accessible mobile status dots.
- [x] Split Thinking and Display into independent menus and make the currently selected modes discoverable from their toolbar triggers.
- [x] Make the Model selector honor its compact/mobile mode, show the selected model on desktop, and remain visibly disabled rather than opening an empty list for environment-only model resolution.
- [x] Add focus, accessible group labels, live status announcements and meaningful tone colors.
- [x] Expose Gateway stop through the existing confirmation dialog; remove the stale duplicate shutdown action.
- [x] Add Bengali, English, Brazilian Portuguese and Chinese status/working translations.
- [ ] Validate interactions and responsive layout in a running browser. **Not run:** frontend dependencies are not installed in this environment.

## Phase 4 — Miki-owned Markdown documentation

- [x] Rewrite the root README with the canonical Agent operating model, capabilities and limitations.
- [x] Add `docs/AGENT_MIKI_OPERATING_MODEL.md` as the maintainer/capability source of truth.
- [x] Repair architecture documentation and all nine structure guides; remove inaccurate standalone `packages/skills`/`packages/installer` workspace claims and fix broken roadmap links.
- [x] Update autonomous execution, idle-mode and tool/plugin/skill operations guides to match runtime behavior.
- [x] Update deployment, package, UI verification and Core optimization documentation.
- [x] Add maintenance notes to dated audit/repair/report documents without rewriting historical findings.
- [x] Update **all 54 Miki-owned Markdown files** present in this archive, while leaving every Skill definition and vendor Markdown file unchanged.

## Phase 5 — Verification

- [x] TypeScript/TSX syntax transpilation check passed for the changed runtime, UI and test files.
- [x] Parse validation passed for `config/agent.yaml`, `config/tools.yaml` and `identity/DRIVES.md` YAML front matter.
- [x] JSON parse validation passed for all frontend locale JSON files.
- [x] Canonical README/operating/architecture/structure Markdown local links checked; no broken local links found in those guides.
- [x] Identity file lengths checked against ambient supervisor limits: SOUL 3,548/4,000; IDENTITY 2,189/2,400; TOOLS 4,670/5,000; AGENTS 8,976/12,000; USER 1,263/1,800 characters.
- [x] Protected Skill catalogue and llama.cpp vendor Markdown compared with the original archive; zero protected Markdown changes found.
- [ ] Run Jest/Vitest suites, frontend ESLint, TypeScript project build, and production build. **Blocked:** no `node_modules` are present, npm cache is empty, and root Node version is below the declared minimum. These checks must be run with Node `>=22.19.0` and installed dependencies before release.

## Phase 6 — Delivery

- [x] Create the updated project archive and change manifest.
- [x] Record changed file counts and protected-file exclusions.
- [x] Preserve the original uploaded ZIP separately from the upgraded archive.

## Change summary

- **67 project source/documentation files updated or added:** 54 Markdown (53 existing Miki-owned Markdown files updated plus one new canonical operating-model guide), 4 TypeScript, 4 TSX, 4 locale JSON, and 1 YAML persona/config file. The delivery-only `UPGRADE_MANIFEST.txt` is separate from that count.
- Runtime code changes: interactive identity loader/tests and autonomous supervisor identity context.
- UI code changes: Chat page status derivation/tests, workspace header status interactions, and global Gateway lifecycle menu.
- Locale updates: `en.json`, `bn.json`, `pt-br.json`, `zh.json`.
- No Skill catalogue or third-party/vendor Markdown content was changed.

## Environment and test limitations

The validation environment reported `node v22.16.0` and `npm 10.9.2`. Root `package.json` declares Node `>=22.19.0`. The project archive contains no root/frontend `node_modules`, and the local npm cache contains no cached packages. As a result, syntax/configuration/integrity checks were run, but test runners, ESLint, type-aware project compilation, browser validation and production build were not represented as passing.
