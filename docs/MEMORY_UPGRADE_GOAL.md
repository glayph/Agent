# Miki Memory System Upgrade Goal

Single goal: fix and upgrade the memory system so it is robust, fast, and closer to true persistent Knowledge Graph + RAG without Python, keeping TypeScript direction and local-first 24/7 design.

## Problems being solved
1. ~~No FTS / weak keyword search (LIKE only)~~ ✅ FTS5 (unicode61) for events + entities
2. ~~Extremely weak entity extraction (English Capitalized regex only; no Bengali)~~ ✅ Unicode-aware + stable Unicode entity ids
3. ~~No algorithmic context budget (plain slice)~~ ✅ Priority sections under token budget
4. ~~Package still named graphrag-memory / residual Hiro naming~~ ✅ `@miki/memory`
5. ~~Init race (fire-and-forget initialize)~~ ✅ `initializeSync()` + bridge awaits schema
6. ~~Foundation for future embeddings (pluggable, offline-first)~~ ✅ `embedding-provider.js` (hash/noop)

## Success criteria
- [x] FTS5 search works and is used by query + context paths
- [x] Entity extraction handles Unicode letters (including Bengali) and better patterns
- [x] getContextWindow respects an approximate token budget with priority
- [x] Package name and docs are Miki-aligned (@miki/memory)
- [x] Existing tests pass / updated tests pass
- [x] No Python; better-sqlite3 remains the only heavy dep for this phase
- [x] Core still loads memory via bridge without breaking

## Out of scope for this goal (later phases)
- Full @xenova/transformers embedding model (optional later)
- Complete rewrite of every .js file to .ts (incremental; bridge remains)
- LLM-assisted NER on every write
- Persistent vector storage / ANN index over embeddings
