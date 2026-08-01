'use strict';

class AgentMemoryIntegration {
  constructor(tkg) {
    this.tkg = tkg;
  }

  preExecutionHook(userMessage, systemState = {}) {
    const anchor = this.tkg.getWorkingAnchor();
    const specialEvents = this.tkg.getSpecialEvents(5, true);

    const context = this.tkg.getContextWindow(
      typeof userMessage === 'string' ? userMessage : (userMessage?.content || ''),
      25
    );

    return {
      anchor,
      specialEvents,
      contextWindow: context,
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

    const entities = this.tkg._extractEntities({ content: agentOutput });
    for (const entity of entities) {
      this.tkg._ensureEntity(entity);
    }

    return result;
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

    return { userEvent, agentEvent };
  }

  logToolCall(toolName, args, result, metadata = {}) {
    return this.tkg.writeEvent({
      content: `Tool: ${toolName}\nArgs: ${JSON.stringify(args).substring(0, 500)}\nResult: ${String(result).substring(0, 1000)}`,
      source: 'tool',
      event_type: 'tool_call',
      metadata: { toolName, ...metadata }
    });
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

    const contextLines = hook.contextWindow.split('\n').filter(l => l.trim()).slice(0, 40);
    if (contextLines.length > 0) {
      parts.push(contextLines.join('\n'));
    }

    parts.push('');
    parts.push('Use the above temporal memory context to inform your responses. Past events, active entities, and highlighted special events are provided for continuity.');

    return parts.join('\n');
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
