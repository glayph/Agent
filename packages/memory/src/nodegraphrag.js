'use strict';

const path = require('path');
const MemoryManager = require('./core/memory-manager');

/**
 * NodeGraphRAG
 *
 * A lightweight, agent-friendly wrapper around the existing GraphRAG memory engine.
 * It exposes a simple API for initialization, memory insertion, retrieval, search,
 * and context creation without requiring any UI layer.
 */
class NodeGraphRAG extends MemoryManager {
  constructor(options = {}) {
    super(options);
    this.options = {
      dataDir: './data',
      autoSaveIntervalMs: 60000,
      ...options
    };
  }

  async initialize(dataDir = this.options.dataDir) {
    const resolvedDir = dataDir ? path.resolve(dataDir) : path.resolve(this.options.dataDir || './data');
    await super.initialize(resolvedDir);
    return this;
  }

  async addMemory(content, metadata = {}) {
    if (!this.initialized) {
      await this.initialize(this.options.dataDir);
    }
    return super.store(content, metadata);
  }

  async remember(content, metadata = {}) {
    return this.addMemory(content, metadata);
  }

  async getMemory(memoryId) {
    return super.retrieve(memoryId);
  }

  async updateMemory(memoryId, content, metadata = {}) {
    return super.update(memoryId, content, metadata);
  }

  async deleteMemory(memoryId) {
    return super.remove(memoryId);
  }

  async search(query, options = {}) {
    if (!this.initialized) {
      await this.initialize(this.options.dataDir);
    }
    return super.search(query, options);
  }

  async getContext(query, maxTokens = 2048) {
    if (!this.initialized) {
      await this.initialize(this.options.dataDir);
    }
    return super.getContext(query, maxTokens);
  }

  async shutdown() {
    await super.shutdown();
    return true;
  }
}

module.exports = NodeGraphRAG;
