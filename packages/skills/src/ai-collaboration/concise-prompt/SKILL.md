---
name: concise-prompt
description: "Compress verbose instructions into minimal, high-density prompts without losing meaning."
version: 1.0.0
author: Hiro
license: MIT
platforms: [linux, macos, windows]
metadata:
  Hiro:
    tags: [prompt-engineering, compression, token-efficiency]
    related_skills: [semantic-summarization]
---

# Concise Prompt Engineering (Instruction Compression)

## Principles
- Remove all filler words, hedging, and redundancy
- Use terse, imperative structure
- Prefer single words over phrases
- Eliminate polite formalities ("please", "could you")
- Use abbreviations where unambiguous
- Flatten nested instructions into ordered lists

## Compression ratio target
- Aim for 60-80% reduction in token count
- Never sacrifice task correctness for brevity

## Technique patterns
1. **Ellipsis**: Remove subjects/objects implied by context
   - "You should analyze the code" → "Analyze code"
2. **Imperative stacking**: Chain actions without connectors
   - "First do X, then do Y" → "Do X. Do Y."
3. **Category labels**: Replace descriptions with known labels
   - "fix syntax errors in TypeScript" → "tsc --noEmit"
4. **Token-efficient framing**: Use `{ }` templates for variable slots
5. **Delete meta-commentary**: Remove "I'll", "Let's", "We need to"

## Example
Input (78 tokens):
"You should carefully review the entire codebase and find any bugs that might exist, and then provide a detailed report of what you found."

Output (15 tokens):
"Review codebase. Find bugs. Report findings."
