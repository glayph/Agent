// Minimal @jest/globals shim (describe/it/expect with toBe/toMatch/toMatchObject) so the repo's own resolver tests can run offline.
import assert from 'node:assert/strict'
const results = { pass: 0, fail: 0, failures: [] }
let prefix = []
const queue = []
export const describe = (n, fn) => { prefix.push(n); fn(); prefix.pop() }
export const it = (n, fn) => queue.push([[...prefix, n].join(' > '), fn])
const sub = (a, b) => b && typeof b === 'object' ? Object.keys(b).every((k) => sub(a?.[k], b[k])) : a === b
export const expect = (v) => ({
  toBe: (x) => assert.strictEqual(v, x), toEqual: (x) => assert.deepStrictEqual(v, x),
  toMatch: (re) => assert.match(String(v), re), toMatchObject: (x) => assert.ok(sub(v, x), `expected ${JSON.stringify(v)} to match ${JSON.stringify(x)}`),
  toBeDefined: () => assert.notStrictEqual(v, undefined), toBeUndefined: () => assert.strictEqual(v, undefined), toContain: (x) => assert.ok(v.includes(x)),
})
export async function runAll() { for (const [n, fn] of queue) { try { await fn(); results.pass++ } catch (e) { results.fail++; results.failures.push(n + ' :: ' + e.message.split('\n')[0]) } } return results }
