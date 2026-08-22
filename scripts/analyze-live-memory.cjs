const Database = require("better-sqlite3");
const path = require("path");

const dbPath = process.argv[2] || path.resolve("data/agent-memory.db");
const db = new Database(dbPath, { readonly: true });
const tables = [
  "memory_chunk_index",
  "memory_chunk_postings",
  "memory_chunk_edges",
  "memory_retrieval_events",
  "memory_events",
  "node_graph_nodes",
  "node_graph_edges",
];

function count(table) {
  try {
    return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count;
  } catch {
    return null;
  }
}

const scopes = db.prepare("SELECT scope_key, COUNT(*) AS count FROM memory_chunk_index GROUP BY scope_key ORDER BY count DESC").all();
const regions = db.prepare("SELECT region, COUNT(*) AS count FROM memory_chunk_index GROUP BY region ORDER BY count DESC").all();
const retrieval = db.prepare(`
  SELECT
    COUNT(*) AS count,
    COALESCE(AVG(candidate_count), 0) AS avgCandidates,
    COALESCE(AVG(selected_count), 0) AS avgSelected,
    COALESCE(AVG(token_budget), 0) AS avgBudget,
    COALESCE(AVG(tokens_used), 0) AS avgTokensUsed,
    COALESCE(AVG(latency_ms), 0) AS avgLatencyMs,
    COALESCE(SUM(CASE WHEN fallback_reason IS NOT NULL THEN 1 ELSE 0 END), 0) AS fallbacks
  FROM memory_retrieval_events
`).get();
const recent = db.prepare(`
  SELECT query, candidate_count, selected_count, token_budget, tokens_used, latency_ms, fallback_reason, created_at
  FROM memory_retrieval_events ORDER BY created_at DESC LIMIT 20
`).all();
const tokenRows = db.prepare(`
  SELECT
    COALESCE(SUM(LENGTH(content)), 0) AS contentChars,
    COALESCE(SUM(LENGTH(summary)), 0) AS summaryChars,
    COALESCE(SUM(LENGTH(metadata)), 0) AS metadataChars,
    COALESCE(SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END), 0) AS embeddedChunks
  FROM memory_chunk_index
`).get();
const duplicateHashes = db.prepare(`
  SELECT COUNT(*) AS duplicateGroups FROM (
    SELECT scope_key, content_hash FROM memory_chunk_index GROUP BY scope_key, content_hash HAVING COUNT(*) > 1
  )
`).get();
const result = {
  dbPath,
  tables: Object.fromEntries(tables.map((table) => [table, count(table)])),
  scopes,
  regions,
  retrieval,
  recent,
  storage: { ...tokenRows, duplicateGroups: duplicateHashes.duplicateGroups },
};
console.log(JSON.stringify(result, null, 2));
db.close();
