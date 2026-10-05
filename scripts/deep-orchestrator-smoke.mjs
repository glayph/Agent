import assert from 'node:assert/strict';
import { LayeredOrchestrator } from '../packages/core/dist/orchestration/layered-orchestrator.js';
import { ToolRegistry } from '../packages/core/dist/engine/tool-registry.js';

const delay = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
});

function makeLLM() {
  let evaluatorCalls = 0;
  return {
    model: 'mock',
    async complete(messages) {
      const system = String(messages?.[0]?.content || '');
      if (system.includes('semantic pre-execution router')) {
        return { choices: [{ message: { content: '{"mode":"FULL_AGENT","confidence":0.99,"reason":"complex"}' } }] };
      }
      if (system.includes('planning module')) {
        return { choices: [{ message: { content: '{"steps":[{"title":"Research A","depends_on":[]},{"title":"Research B","depends_on":[]},{"title":"Merge A and B","depends_on":[1,2]}]}' } }] };
      }
      if (system.includes("result evaluator")) {
        evaluatorCalls += 1;
        // First final answer fails; all other evaluations pass.
        const isFinal = String(messages?.[1]?.content || '').includes('final synthesized answer');
        if (isFinal && evaluatorCalls === 4) return { choices: [{ message: { content: '{"pass":false,"reason":"needs revision"}' } }] };
        return { choices: [{ message: { content: '{"pass":true,"reason":"supported by evidence"}' } }] };
      }
      if (system.includes('output synthesizer')) {
        return { choices: [{ message: { content: 'Initial synthesis' } }] };
      }
      if (system.includes('Revise the final answer')) {
        return { choices: [{ message: { content: 'Revised synthesis' } }] };
      }
      throw new Error(`Unexpected LLM prompt: ${system.slice(0,120)}`);
    },
  };
}

let active = 0;
let maxActive = 0;
const engine = {
  async run({ runId, goal, signal }) {
    active += 1; maxActive = Math.max(maxActive, active);
    try {
      await delay(20, signal);
      return { runId, status: 'completed', model: 'mock', goal, finalText: `done:${goal}`, turns: 1, toolCalls: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() };
    } finally { active -= 1; }
  }
};
const tools = new ToolRegistry();
const saves = [];
const memory = { async search(){ return []; }, async add(){ return { id: 'm1' }; } };
const state = { save(snapshot){ saves.push(structuredClone(snapshot)); }, load(){ return undefined; } };
const llm = makeLLM();
const orchestrator = new LayeredOrchestrator({ engine, tools, llmFor: () => llm, memory, state, maxSubtasks: 3, maxAttempts: 2, maxParallel: 2 });
const events = [];
const result = await orchestrator.run({ sessionId: 's1', history: [{ role:'user', content:'search data A and compare data B then merge them' }], onEvent:e=>events.push(e) });
console.log("DEBUG_RESULT", result.status, result.error, result.finalText, events.map(e=>[e.type,e.nodeId,e.pass,e.reason]).filter(x=>x[0]==="orchestrator.evaluation"));
assert.equal(result.status, 'completed');
assert.equal(result.finalText, 'Revised synthesis');
assert.equal(maxActive, 2);
assert.ok(events.some(e => e.type === 'orchestrator.evaluation' && e.nodeId === '__final__' && !e.pass));
assert.ok(events.some(e => e.type === 'orchestrator.evaluation' && e.nodeId === '__final__' && e.pass));
const terminal = saves.at(-1);
assert.equal(terminal.status, 'completed');
assert.equal(terminal.phase, 'DONE');
console.log('ORCHESTRATOR_COMPLEX_SMOKE_OK', JSON.stringify({ maxActive, terminalStatus: terminal.status, eventCount: events.length }));

let cancelledRun;
const slowEngine = { async run({ runId, goal, signal }) { await delay(200, signal).catch(()=>{}); return { runId, status: signal.aborted ? 'cancelled' : 'completed', model: 'mock', goal, finalText: signal.aborted ? '' : 'late', error: signal.aborted ? 'cancelled' : undefined, turns: 1, toolCalls: [], usage: {promptTokens:0,completionTokens:0,totalTokens:0}, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() }; } };
const cancelOrch = new LayeredOrchestrator({ engine: slowEngine, tools, llmFor: () => llm, memory, maxSubtasks: 1, evaluate: false });
cancelledRun = cancelOrch.run({ runId:'cancel-me', sessionId:'s2', history:[{role:'user',content:'search this task and then finish'}] });
await delay(30);
assert.equal(cancelOrch.cancelRun('cancel-me'), true);
const cancelled = await cancelledRun;
assert.equal(cancelled.status, 'cancelled');
console.log('ORCHESTRATOR_CANCEL_SMOKE_OK');

// Persistence ordering regression: intentionally delay alternating writes.
const persistedStates = [];
const delayedState = {
  async save(snapshot) {
    await delay(snapshot.phase === 'EXECUTE' ? 25 : 1);
    persistedStates.push(snapshot);
  },
};
const orderedOrch = new LayeredOrchestrator({ engine, tools, llmFor: () => llm, memory, state: delayedState, maxSubtasks: 3, maxAttempts: 1, maxParallel: 2 });
const ordered = await orderedOrch.run({ runId:'ordered-run', sessionId:'s3', history:[{ role:'user', content:'search data A and compare data B then merge them' }] });
assert.equal(ordered.status, 'completed');
assert.equal(persistedStates.at(-1).status, 'completed');
assert.equal(persistedStates.at(-1).phase, 'DONE');
console.log('PERSISTENCE_ORDER_SMOKE_OK');

