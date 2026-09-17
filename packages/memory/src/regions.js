'use strict';

/**
 * Canonical functional memory regions. Legacy aliases remain accepted so old
 * databases and callers can migrate without losing existing records.
 */
const REGIONS = Object.freeze({
  LONG_TERM: 'long_term',
  DAILY: 'daily',
  DAY_TO_DAY: 'day_to_day',
  STATIC: 'static',
  SKILL: 'skill',
  RULE_EMOTION: 'rule_emotion',
  TEMPORARY: 'temporary',
});

const CANONICAL_REGIONS = Object.freeze([
  'long_term',
  'day_to_day',
  'static',
  'skill',
  'rule_emotion',
]);

const ALL_REGIONS = Object.freeze([
  ...CANONICAL_REGIONS,
  REGIONS.DAILY,
  REGIONS.TEMPORARY,
]);

const REGION_LABELS = Object.freeze({
  long_term: 'Long-term (Memory / Knowledge)',
  daily: 'Day to Day (legacy alias)',
  day_to_day: 'Day to Day (Scheduling / Tasks)',
  static: 'Static (Core / Stable Data)',
  skill: 'Skill (Abilities / Tools)',
  rule_emotion: 'Rule, Emotion (Guidelines / Behaviour)',
  temporary: 'Temporary (Ongoing Project Work)',
});

const REGION_ALIASES = Object.freeze({
  long_term: 'long_term',
  knowledge: 'long_term',
  memory: 'long_term',
  daily: 'day_to_day',
  day_to_day: 'day_to_day',
  daytoday: 'day_to_day',
  scheduling: 'day_to_day',
  task: 'day_to_day',
  tasks: 'day_to_day',
  static: 'static',
  core: 'static',
  stable: 'static',
  skill: 'skill',
  skills: 'skill',
  tool: 'skill',
  tools: 'skill',
  rule_emotion: 'rule_emotion',
  rule: 'rule_emotion',
  rules: 'rule_emotion',
  emotion: 'rule_emotion',
  behaviour: 'rule_emotion',
  behavior: 'rule_emotion',
  temporary: 'temporary',
});

function canonicalRegion(value, fallback = 'day_to_day') {
  const key = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return REGION_ALIASES[key] || fallback;
}

function isDurableRegion(region) {
  return canonicalRegion(region) !== REGIONS.TEMPORARY;
}

const DEFAULT_REGION = REGIONS.DAY_TO_DAY;

module.exports = {
  REGIONS,
  CANONICAL_REGIONS,
  ALL_REGIONS,
  REGION_LABELS,
  REGION_ALIASES,
  canonicalRegion,
  isDurableRegion,
  DEFAULT_REGION,
};
