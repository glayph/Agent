'use strict';

/**
 * Functional regions matching the Agent brain diagram.
 * These are the top-level partitions of the knowledge graph.
 */
const REGIONS = Object.freeze({
  LONG_TERM: 'long_term',       // Memory / Knowledge
  DAILY: 'daily',               // Day to Day – Scheduling / Tasks
  STATIC: 'static',             // Core / Stable Data
  SKILL: 'skill',               // Abilities / Tools
  RULE_EMOTION: 'rule_emotion', // Guidelines / Behaviour
  TEMPORARY: 'temporary',       // Project-scoped transient work
});

const ALL_REGIONS = Object.freeze(Object.values(REGIONS));

/**
 * Human labels for docs / debug.
 */
const REGION_LABELS = Object.freeze({
  [REGIONS.LONG_TERM]: 'Long-term (Memory / Knowledge)',
  [REGIONS.DAILY]: 'Day to Day (Scheduling / Tasks)',
  [REGIONS.STATIC]: 'Static (Core / Stable Data)',
  [REGIONS.SKILL]: 'Skill (Abilities / Tools)',
  [REGIONS.RULE_EMOTION]: 'Rule, Emotion (Guidelines / Behaviour)',
  [REGIONS.TEMPORARY]: 'Temporary (Ongoing Project Work)',
});

/**
 * Which regions are durable (survive consolidation) vs ephemeral.
 */
function isDurableRegion(region) {
  return region !== REGIONS.TEMPORARY;
}

/**
 * Default region when classification fails.
 */
const DEFAULT_REGION = REGIONS.DAILY;

module.exports = {
  REGIONS,
  ALL_REGIONS,
  REGION_LABELS,
  isDurableRegion,
  DEFAULT_REGION,
};
