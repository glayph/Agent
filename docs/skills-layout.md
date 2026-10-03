# Skills layout

Miki keeps **three** skill locations. They are not interchangeable.

| Kind | Path | Committed? |
|------|------|------------|
| **Bundled catalog** | `packages/skills/src/` | Yes |
| **User / agent-created** | `<dataDir>/skills` or `$MIKI_RUNTIME_ROOT/skills` | No |
| **Marketplace download** | `<dataDir>/downloaded-skills` (sandbox) | No |
| **External SKILL.md import** | `<dataDir>/.agents/skills/` | No |
| **UI only** | `packages/ui/frontend/src/features/agent/skills/` | Yes (React code) |

## Rules

1. Never write user or agent-created skills under the git source tree (`src/skills/`, repo-root `skills/`, or `.agents/`).
2. `normalizeRuntimePaths(workspace)` resolves `skillsDir` to `workspace/data/skills`.
3. `resolveRuntimePaths()` uses OS data dir or `MIKI_RUNTIME_ROOT/skills`.
4. Bundled discovery still scans `packages/skills/src` via `@miki/skills` (`bundledSkillsRoot()`).

## Cleanup

Repo ignores: `/skills/`, `/src/skills/`, `/.agents/`, `skills-lock.json`.
