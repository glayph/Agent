---
name: skills-creator
description: Use when the user wants to create a new skill, asks "make me a skill for X", or wants to add a custom capability. Guide skill creation from idea to working SKILL.md.
---

# Skills Creator

## When triggered
- User says "create a skill for X", "make me a skill", "add a skill"
- User describes a task they do repeatedly and wants to automate
- User wants to package expertise into a reusable skill

## Creation workflow

### Step 1: Define scope
- What specific task/domain does the skill cover?
- What triggers it? (keywords, filenames, user intents)
- What should it NOT do? (negative triggers)

### Step 2: Write SKILL.md
Place in `.opencode/skills/<name>/SKILL.md`

Frontmatter:
```yaml
---
name: <hyphenated-name>
description: One sentence — what AND when to trigger. Front-load trigger keywords.
---
```

Body structure:
- Title (H1)
- Trigger conditions (when to use, when NOT to use)
- Core instructions (step-by-step or reference)
- Examples (input → expected behavior)
- Rules/constraints

### Step 3: Verify
- Check name matches folder name (lowercase, hyphens, ≤64 chars)
- Description starts with "Use when..." or "Use for..."
- Body is actionable, not abstract
- No external dependencies unless documented

### Step 4: Register (optional)
If using custom paths, update `opencode.json`:
```json
{
  "skills": {
    "paths": [".opencode/skills"]
  }
}
```

## Templates

### Simple automation skill
```yaml
---
name: my-skill
description: Use when <trigger condition>.
---
# My Skill
<instructions>
```

### Multi-step workflow skill
Add sections: Overview, Prerequisites, Steps (numbered), Verification, Troubleshooting.

## Constraints
- Max description: 200 characters
- Max file size: 20KB per skill
- No executable code in frontmatter
- One skill per folder
