'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * Temporal awareness engine for time-based memory management.
 * Handles decay scoring, temporal validity windows, timeline operations,
 * and temporal clustering for the GraphRAG memory system.
 */
class TemporalEngine {
  constructor() {
    /**
     * Memory temporal records.
     * @type {Map<string, {validFrom: string, validUntil: string|null, createdAt: string, lastAccessed: string, accessCount: number, supersededBy: string|null}>}
     */
    this.records = new Map();
  }

  // ─────────────────────────────────────────────
  //  Timestamp Management
  // ─────────────────────────────────────────────

  /**
   * Get the current time as an ISO 8601 string.
   * @returns {string} ISO 8601 timestamp.
   */
  now() {
    return new Date().toISOString();
  }

  /**
   * Parse a date string into a Date object.
   * Supports ISO 8601 and most common date formats via the Date constructor.
   * @param {string} dateStr - The date string to parse.
   * @returns {Date} Parsed Date object.
   * @throws {Error} If the date string cannot be parsed.
   */
  parse(dateStr) {
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      throw new Error(`Cannot parse date string: "${dateStr}"`);
    }
    return date;
  }

  /**
   * Format a Date object to a readable string using a pattern.
   * Supported tokens: YYYY, MM, DD, HH, mm, ss, SSS.
   * @param {Date} date - The Date object to format.
   * @param {string} [pattern='YYYY-MM-DD HH:mm:ss'] - Format pattern.
   * @returns {string} Formatted date string.
   */
  format(date, pattern = 'YYYY-MM-DD HH:mm:ss') {
    const tokens = {
      'YYYY': date.getFullYear().toString(),
      'MM': String(date.getMonth() + 1).padStart(2, '0'),
      'DD': String(date.getDate()).padStart(2, '0'),
      'HH': String(date.getHours()).padStart(2, '0'),
      'mm': String(date.getMinutes()).padStart(2, '0'),
      'ss': String(date.getSeconds()).padStart(2, '0'),
      'SSS': String(date.getMilliseconds()).padStart(3, '0')
    };

    let result = pattern;
    for (const [token, value] of Object.entries(tokens)) {
      result = result.replace(token, value);
    }
    return result;
  }

  // ─────────────────────────────────────────────
  //  Temporal Validity
  // ─────────────────────────────────────────────

  /**
   * Set the temporal validity window for a memory.
   * Creates the record if it doesn't already exist.
   * @param {string} memoryId - Memory identifier.
   * @param {string} validFrom - ISO 8601 start of validity.
   * @param {string|null} validUntil - ISO 8601 end of validity, or null for indefinite.
   */
  setValidity(memoryId, validFrom, validUntil) {
    const now = this.now();
    if (this.records.has(memoryId)) {
      const record = this.records.get(memoryId);
      record.validFrom = validFrom;
      record.validUntil = validUntil;
    } else {
      this.records.set(memoryId, {
        validFrom,
        validUntil,
        createdAt: now,
        lastAccessed: now,
        accessCount: 0,
        supersededBy: null
      });
    }
  }

  /**
   * Check whether a memory is valid at a given point in time.
   * @param {string} memoryId - Memory identifier.
   * @param {string} [atTime] - ISO 8601 timestamp to check against (defaults to now).
   * @returns {boolean} True if the memory is valid at the specified time.
   */
  isValid(memoryId, atTime) {
    const record = this.records.get(memoryId);
    if (!record) return false;

    const checkTime = atTime ? this.parse(atTime) : new Date();
    const from = this.parse(record.validFrom);

    if (checkTime < from) return false;

    if (record.validUntil !== null) {
      const until = this.parse(record.validUntil);
      if (checkTime >= until) return false;
    }

    return true;
  }

  /**
   * Get all memory IDs that are valid at a given point in time.
   * @param {string} [atTime] - ISO 8601 timestamp to check against (defaults to now).
   * @returns {string[]} Array of valid memory IDs.
   */
  getValidMemories(atTime) {
    const results = [];
    for (const memoryId of this.records.keys()) {
      if (this.isValid(memoryId, atTime)) {
        results.push(memoryId);
      }
    }
    return results;
  }

  /**
   * Invalidate a memory by setting its validUntil to now.
   * @param {string} memoryId - Memory identifier.
   * @throws {Error} If the memory record does not exist.
   */
  invalidate(memoryId) {
    const record = this.records.get(memoryId);
    if (!record) {
      throw new Error(`Memory record "${memoryId}" not found`);
    }
    record.validUntil = this.now();
  }

  /**
   * Supersede an old memory with a new one.
   * Invalidates the old memory and records the link to its successor.
   * @param {string} oldMemoryId - The memory being superseded.
   * @param {string} newMemoryId - The replacement memory.
   * @throws {Error} If the old memory record does not exist.
   */
  supersede(oldMemoryId, newMemoryId) {
    const oldRecord = this.records.get(oldMemoryId);
    if (!oldRecord) {
      throw new Error(`Memory record "${oldMemoryId}" not found`);
    }

    oldRecord.validUntil = this.now();
    oldRecord.supersededBy = newMemoryId;
  }

  // ─────────────────────────────────────────────
  //  Time-Decay Scoring
  // ─────────────────────────────────────────────

  /**
   * Calculate exponential time-decay score.
   * Formula: 0.5 ^ (hoursElapsed / halfLifeHours)
   * @param {string} createdAt - ISO 8601 creation timestamp.
   * @param {number} [halfLifeHours=168] - Half-life in hours (default 1 week).
   * @returns {number} Decay score between 0 and 1.
   */
  calculateDecay(createdAt, halfLifeHours = 168) {
    const created = this.parse(createdAt);
    const nowMs = Date.now();
    const hoursElapsed = (nowMs - created.getTime()) / (1000 * 60 * 60);
    return Math.pow(0.5, hoursElapsed / halfLifeHours);
  }

  /**
   * Calculate the relevance score for a memory.
   * Combines time-decay with access frequency.
   * Formula: decay * (1 + log(1 + accessCount))
   * @param {string} memoryId - Memory identifier.
   * @returns {number} Relevance score, or 0 if the memory doesn't exist.
   */
  getRelevanceScore(memoryId) {
    const record = this.records.get(memoryId);
    if (!record) return 0;

    const decay = this.calculateDecay(record.createdAt);
    return decay * (1 + Math.log(1 + record.accessCount));
  }

  // ─────────────────────────────────────────────
  //  Timeline Operations
  // ─────────────────────────────────────────────

  /**
   * Get all memory IDs whose createdAt falls within the specified time range.
   * @param {string} startTime - ISO 8601 range start (inclusive).
   * @param {string} endTime - ISO 8601 range end (inclusive).
   * @returns {string[]} Array of memory IDs within the range.
   */
  getTimeRange(startTime, endTime) {
    const start = this.parse(startTime);
    const end = this.parse(endTime);
    const results = [];

    for (const [memoryId, record] of this.records.entries()) {
      const created = this.parse(record.createdAt);
      if (created >= start && created <= end) {
        results.push(memoryId);
      }
    }

    return results;
  }

  /**
   * Truncate an ISO 8601 date string to a given granularity.
   * @param {Date} date - The Date object to truncate.
   * @param {string} granularity - 'hour' | 'day' | 'week' | 'month'.
   * @returns {string} Truncated period key.
   * @private
   */
  _truncateDate(date, granularity) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');

    switch (granularity) {
      case 'hour':
        return `${year}-${month}-${day}T${hour}`;
      case 'day':
        return `${year}-${month}-${day}`;
      case 'week': {
        // ISO 8601 week number
        const jan4 = new Date(year, 0, 4);
        const dayOfYear = Math.floor((date - new Date(year, 0, 1)) / 86400000) + 1;
        const jan4DayOfWeek = (jan4.getDay() + 6) % 7; // Monday = 0
        const weekNumber = Math.floor((dayOfYear + jan4DayOfWeek - 1) / 7) + 1;
        return `${year}-W${String(weekNumber).padStart(2, '0')}`;
      }
      case 'month':
        return `${year}-${month}`;
      default:
        return `${year}-${month}-${day}`;
    }
  }

  /**
   * Group memories by time period, producing a timeline.
   * @param {string} [granularity='day'] - Grouping granularity: 'hour' | 'day' | 'week' | 'month'.
   * @returns {Array<{period: string, count: number, memoryIds: string[]}>} Timeline entries sorted chronologically.
   */
  getTimeline(granularity = 'day') {
    const groups = new Map();

    for (const [memoryId, record] of this.records.entries()) {
      const created = this.parse(record.createdAt);
      const period = this._truncateDate(created, granularity);

      if (!groups.has(period)) {
        groups.set(period, []);
      }
      groups.get(period).push(memoryId);
    }

    // Sort by period key (lexicographic sort works for ISO-based keys)
    const sortedPeriods = [...groups.keys()].sort();

    return sortedPeriods.map(period => ({
      period,
      count: groups.get(period).length,
      memoryIds: groups.get(period)
    }));
  }

  /**
   * Cluster memories by temporal proximity.
   * Groups events where consecutive createdAt timestamps are within maxGapMs.
   * @param {number} [maxGapMs=3600000] - Maximum gap in milliseconds between events in the same cluster (default 1 hour).
   * @returns {Array<{startTime: string, endTime: string, memoryIds: string[]}>} Array of temporal clusters.
   */
  getTemporalClusters(maxGapMs = 3600000) {
    if (this.records.size === 0) return [];

    // Sort records by createdAt
    const sorted = [...this.records.entries()]
      .map(([id, record]) => ({ id, createdAt: this.parse(record.createdAt) }))
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    const clusters = [];
    let currentCluster = {
      startTime: sorted[0].createdAt,
      endTime: sorted[0].createdAt,
      memoryIds: [sorted[0].id]
    };

    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].createdAt.getTime() - currentCluster.endTime.getTime();

      if (gap <= maxGapMs) {
        // Extend current cluster
        currentCluster.endTime = sorted[i].createdAt;
        currentCluster.memoryIds.push(sorted[i].id);
      } else {
        // Finalize current cluster and start a new one
        clusters.push({
          startTime: currentCluster.startTime.toISOString(),
          endTime: currentCluster.endTime.toISOString(),
          memoryIds: currentCluster.memoryIds
        });
        currentCluster = {
          startTime: sorted[i].createdAt,
          endTime: sorted[i].createdAt,
          memoryIds: [sorted[i].id]
        };
      }
    }

    // Push the last cluster
    clusters.push({
      startTime: currentCluster.startTime.toISOString(),
      endTime: currentCluster.endTime.toISOString(),
      memoryIds: currentCluster.memoryIds
    });

    return clusters;
  }

  // ─────────────────────────────────────────────
  //  Temporal Metadata
  // ─────────────────────────────────────────────

  /**
   * Record an access event for a memory.
   * Updates lastAccessed timestamp and increments accessCount.
   * Creates the record if it doesn't already exist.
   * @param {string} memoryId - Memory identifier.
   */
  recordAccess(memoryId) {
    const now = this.now();

    if (this.records.has(memoryId)) {
      const record = this.records.get(memoryId);
      record.lastAccessed = now;
      record.accessCount++;
    } else {
      this.records.set(memoryId, {
        validFrom: now,
        validUntil: null,
        createdAt: now,
        lastAccessed: now,
        accessCount: 1,
        supersededBy: null
      });
    }
  }

  /**
   * Get temporal statistics across all memory records.
   * @returns {{totalMemories: number, validMemories: number, invalidMemories: number, supersededMemories: number, ageDistribution: {newest: string|null, oldest: string|null, medianAgeHours: number}, averageAccessCount: number, mostAccessed: {memoryId: string|null, accessCount: number}}}
   */
  getTemporalStats() {
    const total = this.records.size;
    if (total === 0) {
      return {
        totalMemories: 0,
        validMemories: 0,
        invalidMemories: 0,
        supersededMemories: 0,
        ageDistribution: { newest: null, oldest: null, medianAgeHours: 0 },
        averageAccessCount: 0,
        mostAccessed: { memoryId: null, accessCount: 0 }
      };
    }

    const nowMs = Date.now();
    let validCount = 0;
    let supersededCount = 0;
    let totalAccessCount = 0;
    let mostAccessedId = null;
    let mostAccessedCount = 0;
    const ages = [];
    const createdAtDates = [];

    for (const [memoryId, record] of this.records.entries()) {
      // Validity check
      if (this.isValid(memoryId)) {
        validCount++;
      }

      // Superseded count
      if (record.supersededBy !== null) {
        supersededCount++;
      }

      // Access stats
      totalAccessCount += record.accessCount;
      if (record.accessCount > mostAccessedCount) {
        mostAccessedCount = record.accessCount;
        mostAccessedId = memoryId;
      }

      // Age calculation
      const created = this.parse(record.createdAt);
      createdAtDates.push(created);
      const ageHours = (nowMs - created.getTime()) / (1000 * 60 * 60);
      ages.push(ageHours);
    }

    // Sort for median and min/max
    ages.sort((a, b) => a - b);
    createdAtDates.sort((a, b) => a.getTime() - b.getTime());

    const medianAgeHours = ages.length % 2 === 0
      ? (ages[ages.length / 2 - 1] + ages[ages.length / 2]) / 2
      : ages[Math.floor(ages.length / 2)];

    return {
      totalMemories: total,
      validMemories: validCount,
      invalidMemories: total - validCount,
      supersededMemories: supersededCount,
      ageDistribution: {
        newest: createdAtDates[createdAtDates.length - 1].toISOString(),
        oldest: createdAtDates[0].toISOString(),
        medianAgeHours: Math.round(medianAgeHours * 100) / 100
      },
      averageAccessCount: Math.round((totalAccessCount / total) * 100) / 100,
      mostAccessed: {
        memoryId: mostAccessedId,
        accessCount: mostAccessedCount
      }
    };
  }

  // ─────────────────────────────────────────────
  //  Persistence
  // ─────────────────────────────────────────────

  /**
   * Save all temporal records to a JSON file.
   * @param {string} filePath - Absolute or relative path to the output file.
   * @returns {Promise<void>}
   */
  async save(filePath) {
    const data = {
      version: 1,
      savedAt: this.now(),
      records: Object.fromEntries(this.records)
    };

    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * Load temporal records from a JSON file, replacing all current data.
   * @param {string} filePath - Absolute or relative path to the input file.
   * @returns {Promise<void>}
   * @throws {Error} If the file cannot be read or parsed.
   */
  async load(filePath) {
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);

      this.records.clear();

      for (const [memoryId, record] of Object.entries(data.records)) {
        this.records.set(memoryId, record);
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

module.exports = TemporalEngine;
