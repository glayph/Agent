'use strict';

const Database = require('better-sqlite3');
const db = new Database(process.argv[2]);
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_%' ORDER BY name").all().map(row => row.name);
const counts = {};
for (const table of tables) {
  counts[table] = db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count;
}
const regions = db.prepare("SELECT region, COUNT(*) AS count FROM memory_chunk_index GROUP BY region ORDER BY region").all();
console.log(JSON.stringify({ tables, counts, regions }, null, 2));
db.close();
