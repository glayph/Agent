import assert from 'node:assert/strict'
import { resolveModel, describeResolution } from './common.mjs'
const label = process.env.MIKI_SRC?.includes('orig') ? 'BASELINE' : 'FIXED'
let pass = 0, fail = 0
const FAKE = 'test-key-0123456789abcdef' // throwaway fake string for structural validation only; never sent anywhere
const entry = (payload, isDefault = true) => ({ payload: { enabled: true, ...payload }, isDefault })
const cases = [
  ['3.1 stored openai-compatible @ local URL, no key', [entry({ provider: 'openai-compatible', model: 'm', api_base: 'http://127.0.0.1:8000/v1' })], {}, (r) => r.configured === true],
  ['3.2 stored gemini model, NO key anywhere', [entry({ provider: 'gemini', model: 'gemini-3.5-flash-lite' })], {}, (r) => r.configured === false && /API key/.test(r.reason)],
  ['3.3 stored gemini model, placeholder key', [entry({ provider: 'gemini', model: 'g', api_key: 'your_api_key' })], {}, (r) => r.configured === false && r.keyCheck.status === 'placeholder'],
  ['3.4 stored gemini model, key only in GEMINI_API_KEY env', [entry({ provider: 'gemini', model: 'g' })], { GEMINI_API_KEY: FAKE }, (r) => r.configured === true],
  ['3.5 .env.example style: DEFAULT_MODEL=gemini/... + GEMINI_API_KEY, nothing stored', [], { DEFAULT_MODEL: 'gemini/gemini-3.5-flash-lite', GEMINI_API_KEY: FAKE }, (r) => r.configured === true && r.provider === 'gemini' && r.model === 'gemini-3.5-flash-lite'],
  ['3.6 DEFAULT_MODEL=google/gemini-2.0-flash-001 + GOOGLE_API_KEY', [], { DEFAULT_MODEL: 'google/gemini-2.0-flash-001', GOOGLE_API_KEY: FAKE }, (r) => r.configured === true && r.model === 'gemini-2.0-flash-001'],
  ['3.7 DEFAULT_MODEL set but provider key missing -> still NOT configured (no key invented)', [], { DEFAULT_MODEL: 'gemini/gemini-3.5-flash-lite' }, (r) => r.configured === false && /API key/.test(r.reason)],
  ['3.8 regression: MIKI_MODEL + MIKI_PROVIDER=llama.cpp (miki-model.mjs style) unchanged', [], { MIKI_MODEL: 'llama.cpp/lfm2.5-1.2b', MIKI_PROVIDER: 'llama.cpp' }, (r) => r.configured === true && r.model === 'llama.cpp/lfm2.5-1.2b' && r.keyCheck.status === 'not_required'],
  ['3.9 precedence: stored default beats env DEFAULT_MODEL', [entry({ provider: 'openai-compatible', model: 'stored-one', api_base: 'http://127.0.0.1:1/v1' })], { DEFAULT_MODEL: 'gemini/x', GEMINI_API_KEY: FAKE }, (r) => r.model === 'stored-one'],
  ['3.10 precedence: MIKI_MODEL beats DEFAULT_MODEL', [], { MIKI_MODEL: 'env-one', MIKI_PROVIDER: 'openai-compatible', DEFAULT_MODEL: 'gemini/x', GEMINI_API_KEY: FAKE }, (r) => r.model === 'env-one'],
  ['3.11 stored model disabled -> not configured with reason', [entry({ provider: 'openai-compatible', model: 'm', api_base: 'http://127.0.0.1:1/v1', enabled: false })], {}, (r) => r.configured === false && /disabled/.test(r.reason)],
]
console.log(`##### ${label} source: model-resolution matrix (real resolveModel, in-memory data, no real credentials)`)
for (const [name, stored, env, ok] of cases) {
  const r = resolveModel(stored, undefined, env)
  let good = false; try { good = ok(r) } catch {}
  good ? pass++ : fail++
  console.log(`${good ? 'PASS' : 'FAIL'} ${name}\n      -> configured=${r.configured} provider=${r.provider} model="${r.model}" key=${r.keyCheck.status}${r.reason ? ' reason="' + r.reason.slice(0, 90) + '"' : ''}`)
}
console.log(`SUMMARY ${label}: pass=${pass} fail=${fail}`)
