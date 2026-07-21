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

    const parts = [];
    parts.push(`\u0986\u09ae\u09bf [${timeStr}]`);
    if (anchor.current_situation) {
      parts.push(`Current Situation: ${anchor.current_situation}`);
    }
    if (entities.length > 0) {
      parts.push(`Active Entities: ${entities.join(', ')}`);
    }
    return parts.join(' | ');
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
