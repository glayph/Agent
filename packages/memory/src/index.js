'use strict';

const TemporalKnowledgeGraph = require('./temporal-knowledge-graph');
const WorkingMemoryAnchor = require('./working-memory-anchor');
const SpecialEventHighlighter = require('./special-event-highlighter');
const MemoryConsolidationDaemon = require('./memory-consolidation-daemon');
const AgentMemoryIntegration = require('./agent-memory-integration');
const TemporaryMemory = require('./temporary-memory');
const MultiHopRetriever = require('./multi-hop-retriever');
const {
  REGIONS,
  ALL_REGIONS,
  REGION_LABELS,
  isDurableRegion,
  DEFAULT_REGION,
} = require('./regions');
const {
  HashEmbeddingProvider,
  NoopEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
} = require('./embedding-provider');

module.exports = {
  TemporalKnowledgeGraph,
  WorkingMemoryAnchor,
  SpecialEventHighlighter,
  MemoryConsolidationDaemon,
  AgentMemoryIntegration,
  TemporaryMemory,
  MultiHopRetriever,
  REGIONS,
  ALL_REGIONS,
  REGION_LABELS,
  isDurableRegion,
  DEFAULT_REGION,
  HashEmbeddingProvider,
  NoopEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
};
