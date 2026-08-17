---
name: skills-finder
description: "Search and recommend relevant skills from the installed skill set by keyword, category, or capability."
version: 1.0.0
author: Hiro
license: MIT
platforms: [linux, macos, windows]
metadata:
  Hiro:
    tags: [skills, discovery, search, find]
    related_skills: [skills-creator, skills-use]
---

# Skills Finder

## When triggered
- User asks "find a skill for X", "is there a skill for X", "what skills do you have"
- User wants to discover capabilities they might not know about

## Search protocol
1. Scan all installed skills in `.opencode/skills/` and any paths in `skills.paths`
2. Check skill descriptions for keyword matches
3. Present results grouped by relevance: exact match > partial match > related

## Recommendation format
```
**<skill-name>** — <description>
  Trigger: <when-to-use>
  Location: <path>
```

## When nothing matches
- List all available skills with brief summaries
- Suggest the user create a custom skill if none fit
- Offer to build one on demand

## Response format
Always list skills with: name, one-line description, trigger keywords. If 5+ results, group by category.
