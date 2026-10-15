import { runAll } from './stub-jest.mjs'
await import(`file://${process.env.MIKI_SRC}/packages/gateway/src/model-resolution.test.ts`)
const r = await runAll()
console.log(`repo's own model-resolution.test.ts via offline shim (${process.env.MIKI_SRC.includes('orig') ? 'BASELINE' : 'FIXED'}): pass=${r.pass} fail=${r.fail}`)
r.failures.forEach((f) => console.log('  FAIL', f))
