// LOCAL STUB of an OpenAI-compatible endpoint (my own scripted test double — NOT a real model/provider).
import http from 'node:http'
export async function startStub(brain) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      if (req.method === 'GET' && /\/models$/.test(req.url)) { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'stub-model' }] })) }
      let parsed = {}; try { parsed = JSON.parse(body || '{}') } catch {}
      requests.push({ auth: req.headers.authorization ?? null, tools: (parsed.tools || []).map((t) => t.function?.name), json: Boolean(parsed.response_format), model: parsed.model, n: parsed.messages?.length })
      const out = brain(parsed, requests.length) || { content: 'NO_ACTION' }
      if (out.status) { res.statusCode = out.status; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ error: { message: out.error || 'error' } })) }
      const message = { role: 'assistant', content: out.content ?? null, ...(out.tool_calls ? { tool_calls: out.tool_calls.map((c, i) => ({ id: `call_${requests.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })) } : {}) }
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ id: 'stub-' + requests.length, object: 'chat.completion', model: parsed.model, choices: [{ index: 0, message, finish_reason: out.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${server.address().port}/v1`, requests, close: () => new Promise((r) => server.close(r)) }
}
const text = (m) => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''))
export const firstUser = (req) => text((req.messages || []).find((m) => m.role === 'user'))
export const toolCount = (req) => (req.messages || []).filter((m) => m.role === 'tool').length
export const kind = (req) => /AUTONOMOUS GOAL #/.test(firstUser(req)) ? 'goal' : /background autonomous loop/.test(firstUser(req)) ? 'ambient' : /verif|JSON/i.test((req.messages||[]).map(text).join(' ').slice(0, 400)) && req.response_format ? 'json' : 'other'
// A realistic 5-tool-call goal: mkdir, write, read-back, list, memory note, then a final answer
export const FIVE_STEP = [
  { name: 'file_mkdir', args: { path: 'autonomy/out' } },
  { name: 'file_write', args: { path: 'autonomy/out/report.txt', content: 'status: ok\n' } },
  { name: 'file_read', args: { path: 'autonomy/out/report.txt' } },
  { name: 'workspace_list', args: { path: 'autonomy/out' } },
  { name: 'memory_add', args: { content: 'Wrote autonomy/out/report.txt and verified it.' } },
]
export const goalBrain = (steps = FIVE_STEP) => (req) => {
  const n = toolCount(req)
  return n < steps.length ? { tool_calls: [steps[n]] } : { content: 'DONE: wrote autonomy/out/report.txt (status: ok) and read it back.' }
}
