---
name: skills-use
description: "Explain skill loading, triggering, lifecycle, and best practices — help users understand why skills do or don't activate."
version: 1.0.0
author: Hiro
license: MIT
platforms: [linux, macos, windows]
metadata:
  Hiro:
    tags: [skills, usage, activation, lifecycle, troubleshooting]
    related_skills: [skills-finder, skills-creator]
---

# Skills Use

## When triggered
- User asks "how do skills work", "how to use a skill", "how are skills loaded"
- User wants to understand skill activation, priority, or lifecycle
- User reports a skill not triggering when expected

## How skills work
1. Skills are loaded at opencode startup from `skills.paths` and `skills.urls`
2. Loader scans for `**/SKILL.md` inside each path
3. Skills with `description` are advertised to the AI in system context
4. Skills without `description` are filtered out (never triggered)
5. The AI decides when to invoke a skill based on the description match

## Loading order (last wins)
1. Built-in opencode skills
2. External: `~/.claude/skills/`
3. External: `~/.agents/skills/`
4. Global config: `~/.config/opencode/skills/`
5. Project config: `.opencode/skills/`
6. Custom paths from `skills.paths` config

## Why a skill might not trigger
| Problem | Fix |
|---------|-----|
| Missing or vague `description` | Rewrite description with trigger keywords |
| Skill not in a loaded path | Add path to `skills.paths` |
| SKILL.md naming wrong | Must be exactly `SKILL.md` |
| Folder structure wrong | Must be `<name>/SKILL.md` |
| Another skill matches first | Make description more specific |
| Config error | Check opencode.json for syntax errors |

## Best practices
- Name skills clearly (lowercase, hyphens)
- Write descriptions that front-load trigger keywords
- Keep skills focused — one domain per skill
- Test by restarting opencode after adding a skill
- Use negative triggers ("Use ONLY when...") to avoid false matches
