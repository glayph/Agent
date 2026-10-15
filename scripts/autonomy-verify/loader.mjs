// Offline TS loader: transpiles the project's real .ts sources; stubs only third-party packages that are not installed
import fs from 'node:fs'; import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
const here = path.dirname(fileURLToPath(import.meta.url))
const req = createRequire(import.meta.url)
const ts = (() => { for (const id of [process.env.TS_PATH, 'typescript', path.join(here, '../../node_modules/typescript')].filter(Boolean)) { try { return req(id) } catch {} } throw new Error('TypeScript not found: run `npm install` in the project or set TS_PATH=/path/to/node_modules/typescript') })()
const STUBS = { '@jest/globals': 'stub-jest.mjs', '@miki/config': 'stub-config.mjs', express: 'stub-express.mjs', 'better-sqlite3': 'stub-express.mjs' }
export async function resolve(spec, ctx, next) {
  if (STUBS[spec]) return { url: pathToFileURL(path.join(here, STUBS[spec])).href, shortCircuit: true }
  if ((spec.startsWith('.') || spec.startsWith('/')) && ctx.parentURL?.startsWith('file:')) {
    const parent = fileURLToPath(ctx.parentURL)
    const base = spec.startsWith('.') ? path.resolve(path.dirname(parent), spec) : spec
    for (const c of [base, base.replace(/\.js$/, '.ts'), base + '.ts', path.join(base, 'index.ts')])
      if (fs.existsSync(c) && fs.statSync(c).isFile() && /\.(ts|mjs|js)$/.test(c)) {
        // prefer .ts sibling over stale compiled .js
        const tsSibling = c.replace(/\.js$/, '.ts')
        const pick = c.endsWith('.js') && fs.existsSync(tsSibling) ? tsSibling : c
        return { url: pathToFileURL(pick).href, shortCircuit: true }
      }
  }
  return next(spec, ctx)
}
export async function load(url, ctx, next) {
  if (!url.endsWith('.ts')) return next(url, ctx)
  const source = fs.readFileSync(fileURLToPath(url), 'utf8')
  const out = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: false }, fileName: fileURLToPath(url) })
  return { format: 'module', source: out.outputText, shortCircuit: true }
}
