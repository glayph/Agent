'use strict';

class WorkingMemoryAnchor {
  constructor(tkg) {
    this.tkg = tkg;
  }

  getAnchor() {
    return this.tkg.getWorkingAnchor();
  }

  updateSituation(situation, entities = [], context = '') {
    return this.tkg.getOrSetWorkingAnchor({
      situation,
      entities,
      context
    });
  }

  addActiveEntity(entityName, entityType = 'entity') {
    const anchor = this.tkg.getWorkingAnchor();
    let currentEntities = [];
    try {
      currentEntities = JSON.parse(anchor.key_entities || '[]');
    } catch {}
    if (!currentEntities.includes(entityName)) {
      currentEntities.push(entityName);
      if (currentEntities.length > 20) currentEntities.shift();
    }
    return this.tkg.getOrSetWorkingAnchor({
      situation: anchor.current_situation,
      entities: currentEntities,
      context: anchor.active_context
    });
  }

  removeActiveEntity(entityName) {
    const anchor = this.tkg.getWorkingAnchor();
    let currentEntities = [];
    try {
      currentEntities = JSON.parse(anchor.key_entities || '[]');
    } catch {}
    const filtered = currentEntities.filter(e => e !== entityName);
    return this.tkg.getOrSetWorkingAnchor({
      situation: anchor.current_situation,
      entities: filtered,
      context: anchor.active_context
    });
  }

  clearContext() {
    return this.tkg.getOrSetWorkingAnchor({
      situation: '',
      entities: [],
      context: ''
    });
  }

  formatAnchorString() {
    const anchor = this.getAnchor();
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
    try {
      entities = JSON.parse(anchor.key_entities || '[]');
    } catch {}

    let parts = [];
    parts.push(`\u0986\u09ae\u09bf [${timeStr}]`);

    if (anchor.current_situation) {
      parts.push(`Current Situation: ${anchor.current_situation}`);
    }

    if (entities.length > 0) {
      parts.push(`Active Entities: ${entities.join(', ')}`);
    }

    return parts.join(' | ');
  }
}

module.exports = WorkingMemoryAnchor;
