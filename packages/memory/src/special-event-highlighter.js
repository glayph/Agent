'use strict';

const crypto = require('crypto');

const IMPORTANCE_PATTERNS = {
  critical: [
    { pattern: /\b(urgent|critical|emergency|immediately|asap)\b/i, score: 0.9 },
    { pattern: /\b(security|breach|attack|vulnerability|exploit)\b/i, score: 0.85 },
    { pattern: /\b(deadline|overdue|expired|failing|crash(ed|ing)?)\b/i, score: 0.8 },
  ],
  emotional: [
    { pattern: /\b(angry|furious|devastated|terrible|horrible|disaster)\b/i, score: 0.8 },
    { pattern: /\b(excited|thrilled|amazing|incredible|breakthrough)\b/i, score: 0.75 },
    { pattern: /\b(frustrated|anxious|worried|concerned|disappointed)\b/i, score: 0.7 },
    { pattern: /\b(grateful|thankful|proud|impressed|delighted)\b/i, score: 0.65 },
  ],
  decisions: [
    { pattern: /\b(approved|rejected|denied|accepted|declined)\b/i, score: 0.75 },
    { pattern: /\b(decided|chosen|selected|elected|appointed)\b/i, score: 0.7 },
    { pattern: /\b(signed|committed|promised|agreed|contracted)\b/i, score: 0.7 },
    { pattern: /\b(launched|deployed|released|published|announced)\b/i, score: 0.7 },
  ],
  milestones: [
    { pattern: /\b(completed|finished|accomplished|achieved|succeeded)\b/i, score: 0.65 },
    { pattern: /\b(milestone|phase|version|release|update)\s*\d/i, score: 0.6 },
    { pattern: /\b(first|initial|inaugural|maiden|beta|alpha)\b/i, score: 0.55 },
  ],
  conflicts: [
    { pattern: /\b(argument|disagreement|conflict|dispute|debate)\b/i, score: 0.8 },
    { pattern: /\b(apologize|sorry|mistake|error|bug|issue)\b/i, score: 0.65 },
    { pattern: /\b(warning|caution|careful|problem|trouble)\b/i, score: 0.6 },
  ]
};

class SpecialEventHighlighter {
  constructor(tkg) {
    this.tkg = tkg;
  }

  classify(content, source, eventType, metadata = {}) {
    const scores = [];

    for (const [, patterns] of Object.entries(IMPORTANCE_PATTERNS)) {
      for (const { pattern, score } of patterns) {
        if (pattern.test(content)) {
          scores.push(score);
        }
      }
    }

    if (metadata.importance) {
      scores.push(metadata.importance);
    }

    const baseImportance = scores.length > 0
      ? Math.max(...scores)
      : 0.0;

    const adjusted = this._applyContextBoosts(baseImportance, content, source, eventType);

    return {
      importance: Math.min(1.0, Math.round(adjusted * 100) / 100),
      isSpecial: adjusted >= 0.7,
      patterns: scores
    };
  }

  _applyContextBoosts(importance, content, source, eventType) {
    let boosted = importance;

    if (source === 'user' && eventType === 'message') {
      boosted += 0.05;
    }

    if (source === 'tool' && eventType === 'tool_result') {
      const errorIndicators = /\b(error|fail|exception|timeout|denied|rejected)\b/i;
      if (errorIndicators.test(content)) {
        boosted += 0.15;
      }
    }

    const length = content.length;
    if (length > 500) boosted += 0.05;
    if (length > 2000) boosted += 0.05;

    return boosted;
  }

  getUnresolved(limit = 20) {
    return this.tkg.getSpecialEvents(limit, true);
  }

  getAll(limit = 20) {
    return this.tkg.getSpecialEvents(limit, false);
  }

  resolve(specialEventId) {
    return this.tkg.resolveSpecialEvent(specialEventId);
  }

  formatSpecialEventsSummary(limit = 5) {
    const events = this.getUnresolved(limit);
    if (events.length === 0) return 'No unresolved special events.';

    const lines = events.map((e, i) => {
      return `${i + 1}. ${e.event_name} (importance: ${e.importance})${e.summary ? ` - ${e.summary.substring(0, 150)}` : ''}`;
    });

    return '=== UNRESOLVED SPECIAL EVENTS ===\n' + lines.join('\n');
  }
}

module.exports = SpecialEventHighlighter;
