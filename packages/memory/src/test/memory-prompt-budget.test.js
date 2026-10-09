const assert = require('assert');
const { test } = require('node:test');
const AgentMemoryIntegration = require('../agent-memory-integration');

test('AgentMemoryIntegration deduplicates graph context and applies selective normal-turn limits', () => {
    let selectiveOptions;
    const tkg = {
      getWorkingAnchor: () => ({
        current_timestamp: '2026-08-21T10:00:00.000Z',
        current_situation: 'English verification',
        key_entities: '[]',
      }),
      getSpecialEvents: () => [],
      getSelectiveContext: (_query, options) => {
        selectiveOptions = options;
        return {
          items: [{ text: 'I prefer concise answers in Bengali for future conversations.' }],
          text: '[long_term/user_stated] I prefer concise answers in Bengali for future conversations.',
        };
      },
      getContextWindow: () => 'legacy fallback',
    };
    const graphMemory = {
      getContext: (_query, options) => {
        assert.equal(options.limit, 4);
        assert.equal(options.maxTokens, 400);
        return {
          items: [
            { text: 'I prefer concise answers in Bengali for future conversations.', category: 'conversation', memoryType: 'user_message' },
            { text: 'The workspace uses a bounded retrieval graph.', category: 'procedural', memoryType: 'tool_outcome' },
          ],
          text: 'legacy text is replaced by the filtered item list',
        };
      },
    };
    const integration = new AgentMemoryIntegration(tkg, { graphMemory });
    const hook = integration.preExecutionHook('What style do I prefer?');

    assert.equal(selectiveOptions.maxSelected, 8);
    assert.equal(selectiveOptions.maxDepth, 1);
    assert.equal(selectiveOptions.maxTokens, 800);
    assert.equal(hook.graphContext.items.length, 1);
    assert.equal(hook.graphContext.items[0].text, 'The workspace uses a bounded retrieval graph.');
    assert.ok(!hook.formattedGraphContext.includes('I prefer concise answers'));
    assert.ok(hook.formattedGraphContext.includes('bounded retrieval graph'));

    const prompt = integration.getEnhancedSystemPrompt('What style do I prefer?');
    assert.equal((prompt.match(/I prefer concise answers in Bengali/g) || []).length, 1);
});

test('getPromptContext reports whether anything was actually recalled', () => {
  const anchor = { current_timestamp: '2026-08-21T10:00:00.000Z', current_situation: null, key_entities: '[]' };
  const base = { getWorkingAnchor: () => anchor, getSpecialEvents: () => [], getContextWindow: () => '' };

  const empty = new AgentMemoryIntegration({
    ...base,
    getSelectiveContext: () => ({ items: [], text: '' }),
  });
  const none = empty.getPromptContext('anything');
  assert.equal(none.hasContent, false);
  assert.equal(typeof none.text, 'string');

  const seen = [];
  const filled = new AgentMemoryIntegration({
    ...base,
    getSelectiveContext: (_q, options) => {
      seen.push(options.scope);
      return { items: [{ text: 'User deploys Miki inside VirtualBox.' }], text: '[long_term/user_stated] User deploys Miki inside VirtualBox.' };
    },
  });
  const some = filled.getPromptContext('where do I deploy?', { memoryScope: { agentId: 'a', ownerId: 'o', workspaceId: 'w' } });
  assert.equal(some.hasContent, true);
  assert.match(some.text, /VirtualBox/);
  // The scope is the global owner scope, never a per-chat one.
  assert.deepEqual(seen[0], { agentId: 'a', ownerId: 'o', workspaceId: 'w' });
  // The legacy single-argument API keeps working.
  assert.match(filled.getEnhancedSystemPrompt('where do I deploy?'), /VirtualBox/);
});
