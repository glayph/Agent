// better-sqlite3-compatible surface over Node's built-in node:sqlite (the real package cannot be installed offline)
import { DatabaseSync } from 'node:sqlite'
export function openDb(file = ':memory:') {
  const raw = new DatabaseSync(file)
  let depth = 0
  const norm = (a) => a.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v))
  return {
    raw,
    exec: (s) => raw.exec(s),
    pragma: (s) => { try { raw.exec('PRAGMA ' + s) } catch {} },
    prepare: (s) => { const st = raw.prepare(s); return { run: (...a) => st.run(...norm(a)), get: (...a) => st.get(...norm(a)), all: (...a) => st.all(...norm(a)) } },
    transaction: (fn) => (...args) => {
      const nested = depth > 0; const sp = 'sp' + depth
      raw.exec(nested ? `SAVEPOINT ${sp}` : 'BEGIN'); depth++
      try { const r = fn(...args); depth--; raw.exec(nested ? `RELEASE ${sp}` : 'COMMIT'); return r }
      catch (e) { depth--; try { raw.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : 'ROLLBACK') } catch {} throw e }
    },
    close: () => raw.close(),
  }
}
