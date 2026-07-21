---
name: semantic-summarization
description: Use when the user requests semantic summarization, context compression, token budget optimization, or long-context reduction. Summarize text while preserving semantic meaning, entities, relationships, and actionable details.
---

# Semantic Summarization (Context Compression)

## Goals
- Reduce token count by 70-90%
- Preserve all entities, numeric values, relationships, and action items
- Remove redundancy, verbosity, and low-information content

## Compression strategy (tiered)

### Tier 1 — Lossless (50-70% compression)
Keep all facts. Remove adjectives, adverbs, filler, meta-commentary.
```
Input:  "The function appears to be intentionally designed to handle edge cases like null values and undefined inputs gracefully."
Output: "Function handles edge cases: null, undefined."
```

### Tier 2 — Semantic (70-85% compression)
Merge related facts. Abstract examples into patterns. Drop tangential details.
```
Input:  "We tried using approach A which failed, then approach B which also failed, and finally approach C which worked."
Output: "A, B failed. C succeeded."
```

### Tier 3 — Extractive (85-95% compression)
Keep only: entities, decisions, blockers, action items, key numbers.
Drop: explanations, context, rationale, alternatives not chosen.

## Rules
- Numbers, dates, percentages, IDs → always preserve verbatim
- Proper nouns, filenames, function names → always preserve
- Action items and decisions → always preserve
- Repeated information → keep first occurrence only
- Code snippets → keep signature + 1-line summary; drop body
- Error messages → keep error type + code; drop full trace
- Logs → keep timestamps + severity + message; drop metadata

## Output format
- Use bullet points (not prose)
- Prefix: `[K]` = key fact, `[D]` = decision, `[A]` = action, `[B]` = blocker
