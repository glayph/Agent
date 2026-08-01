'use strict';

const NodeGraphRAG = require('./nodegraphrag');
const MemoryManager = require('./core/memory-manager');
const TemporalKnowledgeGraph = require('./temporal-knowledge-graph');
const WorkingMemoryAnchor = require('./working-memory-anchor');
const SpecialEventHighlighter = require('./special-event-highlighter');
const MemoryConsolidationDaemon = require('./memory-consolidation-daemon');
const AgentMemoryIntegration = require('./agent-memory-integration');
const config = require('./config');

module.exports = {
  NodeGraphRAG,
  MemoryManager,
  TemporalKnowledgeGraph,
  WorkingMemoryAnchor,
  SpecialEventHighlighter,
  MemoryConsolidationDaemon,
  AgentMemoryIntegration,
  config
};
