---
name: rag-context
description: Use when the user asks for RAG, retrieval-augmented generation, dynamic context injection, knowledge base queries, or context retrieval strategies. Dynamically fetch and inject relevant context from files, codebases, docs, or external sources into the active prompt window.
---

# Retrieval-Augmented Context (Dynamic RAG)

## Trigger conditions
- User mentions RAG, retrieval, context injection, knowledge base
- Task requires info not in active conversation (code reference, API docs, config)
- User asks "check X" or "look up Y"

## Retrieval strategy (ordered by cost)

### 1. Exact match (fastest)
- Grep/RG for known symbols, filenames, error strings
- Use glob for file patterns

### 2. Semantic (codebase)
- Read file headers, imports, exports, type signatures
- Grep for function/class definitions matching intent

### 3. Structural (docs/config)
- Read README, package.json, tsconfig, config YAML
- Scan directory tree for relevant paths

### 4. External (web)
- Fetch docs URLs, search web for API references
- Fetch GitHub raw content for library source

## Context injection rules
- **Prefer excerpts over whole files** — extract 5-20 relevant lines
- **Tag source origin**: `[src/path.ts:42]` or `[web: docs.url]`
- **Summarize what you found** before quoting
- **If nothing found**: say so immediately — don't fabricate

## Multi-turn RAG
- Track what's already retrieved in-session
- Don't re-fetch same content unless explicitly asked
- On ambiguity: retrieve top 2-3 candidates, present choices
