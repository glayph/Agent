// READ-ONLY diagnosis of YOUR machine's model configuration. Never prints keys, never writes anything.
//   MIKI_DATA_DIR=/path/to/data node --import ./register.mjs diagnose-live.mjs [path/to/miki-runtime.sqlite]
// NOTE: environment variables are read from THIS shell. The gateway may have been started with a different environment
// (service unit, launcher script, .env) — compare with the "model" block of GET /api/autonomy/status on the running gateway.
import fs from 'node:fs'; import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { resolveModel, describeResolution } from './common.mjs'
const SRC = new URL('../../', import.meta.url).pathname
const dataRoot = process.env.MIKI_DATA_DIR ? path.resolve(process.env.MIKI_DATA_DIR) : path.join(process.env.MIKI_WORKSPACE_DIR ? path.resolve(process.env.MIKI_WORKSPACE_DIR) : SRC, 'data')
const dbFile = process.argv[2] || path.join(dataRoot, 'miki-runtime.sqlite')
const mask = (k) => (k ? `<set, ${String(k).length} chars>` : '<empty>')
console.log('DB file:', dbFile, fs.existsSync(dbFile) ? '(found)' : '(NOT FOUND -> no UI-saved models can exist for this data dir)')
let stored = []
if (fs.existsSync(dbFile)) {
  const db = new DatabaseSync(dbFile, { readOnly: true })
  try { stored = db.prepare('SELECT payload,is_default FROM model_configs ORDER BY id').all().map((r) => ({ payload: JSON.parse(r.payload), isDefault: r.is_default === 1 })) } catch (e) { console.log('model_configs unreadable:', e.message) }
  console.log(`\nmodel_configs rows (Models page): ${stored.length}`)
  stored.forEach((m, i) => console.log(` #${i + 1} default=${m.isDefault} enabled=${m.payload.enabled !== false} provider=${m.payload.provider ?? '-'} model=${m.payload.model || m.payload.model_name || '-'} api_base=${m.payload.api_base ?? '-'} api_key=${mask(m.payload.api_key)}`))
  for (const [label, sql] of [['goals', 'SELECT id,status,title FROM pursue_goals ORDER BY id DESC LIMIT 5'], ['recent runs', 'SELECT run_id,status,attempt,error FROM autonomy_goal_runs ORDER BY rowid DESC LIMIT 5']]) {
    try { console.log(`\n${label}:`); db.prepare(sql).all().forEach((r) => console.log(' ', JSON.stringify(r))) } catch { console.log('  (table not present)') }
  }
}
const names = ['MIKI_MODEL', 'OPENAI_MODEL', 'DEFAULT_MODEL', 'MIKI_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_COMPATIBLE_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']
console.log('\nenvironment of this shell (presence only):'); names.forEach((n) => console.log(' ', n.padEnd(26), process.env[n] ? (/KEY/.test(n) ? '<set>' : process.env[n]) : '<unset>'))
const r = describeResolution(resolveModel(stored, undefined, process.env))
console.log('\nWHAT THE CHAT + BACKGROUND SUPERVISOR WILL USE:', JSON.stringify(r, null, 1))
console.log(r.configured ? '\nVERDICT: a model resolves; "no_provider" would NOT occur with this configuration.' : `\nVERDICT: no usable model -> supervisor reports no_provider. Missing: ${r.reason}`)
