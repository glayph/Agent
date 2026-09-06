'use strict';

class AgentMemoryIntegration {
  constructor(tkg, options = {}) {
    this.tkg = tkg;
    this.graphMemory = options.graphMemory || tkg?.graphMemory || null;
    this.defaultScope = options.scope || {
      agentId: process.env.MIKI_AGENT_ID || 'miki',
      ownerId: process.env.MIKI_OWNER_ID || 'default-owner',
      workspaceId: process.env.MIKI_WORKSPACE_ID || 'default-workspace',
    };
  }

  _scope(systemState = {}, metadata = {}) {
    return systemState.memoryScope || metadata.memoryScope || metadata.scope || this.defaultScope;
  }

  preExecutionHook(userMessage, systemState = {}) {
    const anchor = this.tkg.getWorkingAnchor();
    const query = typeof userMessage === 'string' ? userMessage : (userMessage?.content || '');
    const graphContextRaw = this.graphMemory
      ? this.graphMemory.getContext(query, { scope: this._scope(systemState), limit: 4, maxTokens: 400, taskReference: systemState.taskId || systemState.runId || null })
      : { items: [], text: '' };
    const specialEvents = this.tkg.getSpecialEvents(5, true);

    const selectiveContext = typeof this.tkg.getSelectiveContext === 'function'
      ? this.tkg.getSelectiveContext(query, {
        scope: this._scope(systemState),
        maxSelected: 8,
        maxDepth: 1,
        maxTokens: 800,
        taskReference: systemState.taskId || systemState.runId || null,
      })
      : null;

    const selectiveTexts = new Set(
      (selectiveContext?.items || [])
        .map((item) => this._normalizeMemoryText(item.text))
        .filter(Boolean),
    );
    const graphItems = (graphContextRaw.items || [])
      .filter((item) => !selectiveTexts.has(this._normalizeMemoryText(item.text)))
      .slice(0, 4);
    const graphContext = {
      ...graphContextRaw,
      items: graphItems,
      text: graphItems
        .map((item) => `[${item.category || 'memory'}/${item.memoryType || 'graph'}] ${item.text}`)
        .join('\n'),
    };

    // The legacy broad context window is used only when an older TKG does not
    // expose selective retrieval. New runtimes never replay the full history
    // as part of the default agent prompt.
    const context = selectiveContext && typeof selectiveContext.text === 'string'
      ? (selectiveContext.text || this._formatAnchor(anchor))
      : this.tkg.getContextWindow(query, 25);

    return {
      anchor,
      specialEvents,
      contextWindow: context,
      selectiveContext,
      graphContext,
      formattedGraphContext: graphContext.text || '',
      formattedAnchor: this._formatAnchor(anchor),
      formattedSpecialEvents: this._formatSpecialEvents(specialEvents)
    };
  }

  postExecutionHook(agentOutput, userInput, metadata = {}) {
    const eventData = {
      content: agentOutput,
      source: 'agent',
      event_type: 'message',
      metadata: {
        userInput: typeof userInput === 'string' ? userInput.substring(0, 1000) : '',
        ...metadata
      }
    };

    const result = this.tkg.writeEvent(eventData);
    const memoryCategory = result && result.memoryCategory ? result.memoryCategory : undefined;
    const graphMemory = this.graphMemory
      ? this.graphMemory.ingest({
        scope: this._scope(metadata),
        content: typeof agentOutput === 'string' ? agentOutput : JSON.stringify(agentOutput || ''),
        category: metadata.category || 'conversation',
        memoryType: metadata.memoryType || 'assistant_response',
        sourceType: 'agent',
        sourceReference: metadata.messageId || metadata.runId || null,
        taskReference: metadata.taskId || metadata.runId || null,
        metadata: { userInput: typeof userInput === 'string' ? userInput.substring(0, 1000) : '' },
      })
      : null;

    const entities = this.tkg._extractEntities({ content: agentOutput });
    for (const entity of entities) {
      this.tkg._ensureEntity(entity, memoryCategory);
    }

    return { ...result, graphMemory };
  }

  logInteraction(userMessage, agentResponse, metadata = {}) {
    const userEvent = this.tkg.writeEvent({
      content: typeof userMessage === 'string' ? userMessage : (userMessage?.content || ''),
      source: 'user',
      event_type: 'message',
      metadata: { ...metadata, role: 'user' }
    });

    const agentEvent = this.tkg.writeEvent({
      content: typeof agentResponse === 'string' ? agentResponse : (agentResponse?.content || ''),
      source: 'agent',
      event_type: 'message',
      metadata: { ...metadata, role: 'assistant' }
    });

    const graphEvents = this.graphMemory ? [
      this.graphMemory.ingest({ scope: this._scope(metadata), content: typeof userMessage === 'string' ? userMessage : (userMessage?.content || ''), category: metadata.category || 'conversation', memoryType: 'user_message', sourceType: 'user', sourceReference: metadata.messageId || null, taskReference: metadata.taskId || metadata.runId || null, metadata: { role: 'user' } }),
      this.graphMemory.ingest({ scope: this._scope(metadata), content: typeof agentResponse === 'string' ? agentResponse : (agentResponse?.content || ''), category: metadata.category || 'conversation', memoryType: 'assistant_response', sourceType: 'agent', sourceReference: metadata.messageId || null, taskReference: metadata.taskId || metadata.runId || null, metadata: { role: 'assistant' } }),
    ] : [];
    return { userEvent, agentEvent, graphEvents };
  }

  logToolCall(toolName, args, result, metadata = {}) {
    const legacy = this.tkg.writeEvent({
      content: `Tool: ${toolName}\nArgs: ${JSON.stringify(args).substring(0, 500)}\nResult: ${String(result).substring(0, 1000)}`,
      source: 'tool',
      event_type: 'tool_call',
      metadata: { toolName, ...metadata }
    });
    const graphMemory = this.graphMemory ? this.graphMemory.ingest({
      scope: this._scope(metadata),
      content: `Tool ${toolName} completed. Result: ${String(result).substring(0, 1000)}`,
      category: 'procedural',
      memoryType: 'tool_outcome',
      sourceType: 'tool',
      sourceReference: metadata.toolCallId || toolName,
      taskReference: metadata.taskId || metadata.runId || null,
      metadata: { toolName },
      explicit: true,
    }) : null;
    return { ...legacy, graphMemory };
  }

  logSystemEvent(eventType, content, metadata = {}) {
    return this.tkg.writeEvent({
      content,
      source: 'system',
      event_type: eventType || 'system',
      metadata
    });
  }

  getEnhancedSystemPrompt(userMessage) {
    const hook = this.preExecutionHook(userMessage);

    const parts = [];
    parts.push('=== MEMORY CONTEXT ===');
    parts.push('');
    parts.push(hook.formattedAnchor);
    parts.push('');

    if (hook.formattedSpecialEvents) {
      parts.push(hook.formattedSpecialEvents);
      parts.push('');
    }

    if (hook.formattedGraphContext) {
      parts.push('=== GRAPH COGNITIVE MEMORY ===');
      parts.push(hook.formattedGraphContext);
      parts.push('');
    }

    const contextLines = hook.contextWindow
      .split('\\n')
      .filter(l => l.trim())
      .slice(0, hook.selectiveContext ? 8 : 16);
    if (contextLines.length > 0) {
      parts.push(contextLines.join('\n'));
    }

    parts.push('');
    parts.push('Use the above selective memory context to inform your responses. Retrieved chunks are bounded, scoped, and may be incomplete; follow provenance and confidence, and ask for clarification when facts conflict.');

    return parts.join('\n');
  }

  _normalizeMemoryText(text) {
    return String(text || '').toLowerCase().replace(/\\s+/g, ' ').trim().slice(0, 1200);
  }

  _formatAnchor(anchor) {
    const now = new Date(anchor.current_timestamp);
    const timeStr = now.toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    });

    let entities = [];
    try { entities = JSON.parse(anchor.key_entities || '[]'); } catch {}

    // Detect script from the anchor's situation text so the prefix stays
    // contextually appropriate instead of always being Bengali.
    const situation = anchor.current_situation || '';
    const selfLabel = this._detectSelfLabel(situation);

    const parts = [];
    parts.push(`${selfLabel} [${timeStr}]`);
    if (situation) {
      parts.push(`Current Situation: ${situation}`);
    }
    if (entities.length > 0) {
      parts.push(`Active Entities: ${entities.join(', ')}`);
    }
    return parts.join(' | ');
  }

  /**
   * Return a context-appropriate first-person label for the working-memory
   * anchor prefix. Falls back to the Bengali "আমি" that was previously
   * hardcoded, so behaviour is unchanged when no other language is detected.
   *
   * Detection is intentionally lightweight: we check for the presence of
   * characters from common Unicode blocks rather than doing full NLP, which
   * keeps this dependency-free and synchronous.
   */
  _detectSelfLabel(text) {
    if (!text) return '\u0986\u09ae\u09bf'; // আমি  — Bengali default

    // Arabic / Urdu block (U+0600–U+06FF)
    if (/[\u0600-\u06FF]/.test(text)) return '\u0623\u0646\u0627'; // أنا

    // Devanagari (Hindi/Marathi etc.) block (U+0900–U+097F)
    if (/[\u0900-\u097F]/.test(text)) return '\u092E\u0948\u0902'; // मैं

    // CJK Unified Ideographs (Chinese/Japanese Kanji)
    if (/[\u4E00-\u9FFF]/.test(text)) return '\u6211'; // 我

    // Hangul (Korean)
    if (/[\uAC00-\uD7A3]/.test(text)) return '\ub098'; // 나

    // Cyrillic (Russian etc.)
    if (/[\u0400-\u04FF]/.test(text)) return '\u044F'; // я

    // Latin script — use English
    if (/[a-zA-Z]/.test(text)) return 'I';

    // Default: Bengali
    return '\u0986\u09ae\u09bf'; // আমি
  }

  _formatSpecialEvents(events) {
    if (!events || events.length === 0) return '';
    const lines = events.map((e, i) =>
      `[SPECIAL] ${e.event_name} (importance: ${e.importance})${e.summary ? `: ${e.summary.substring(0, 150)}` : ''}`
    );
    return '=== HIGHLIGHTED SPECIAL EVENTS ===\n' + lines.join('\n');
  }
}

module.exports = AgentMemoryIntegration;
