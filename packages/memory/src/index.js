'use strict';

const TemporalKnowledgeGraph = require('./temporal-knowledge-graph');
const WorkingMemoryAnchor = require('./working-memory-anchor');
const SpecialEventHighlighter = require('./special-event-highlighter');
const MemoryConsolidationDaemon = require('./memory-consolidation-daemon');
const AgentMemoryIntegration = require('./agent-memory-integration');
const TemporaryMemory = require('./temporary-memory');
const MultiHopRetriever = require('./multi-hop-retriever');
const NodeGraph = require('./node-graph');
const GraphCognitiveMemory = require('./graph-cognitive-memory');
const SelectiveMemoryEngine = require('./selective-memory-engine');
const {
  REGIONS,
  ALL_REGIONS,
  REGION_LABELS,
  isDurableRegion,
  DEFAULT_REGION,
  CANONICAL_REGIONS,
  REGION_ALIASES,
  canonicalRegion,
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
  NodeGraph,
  GraphCognitiveMemory,
  SelectiveMemoryEngine,
  REGIONS,
  ALL_REGIONS,
  REGION_LABELS,
  isDurableRegion,
  DEFAULT_REGION,
  CANONICAL_REGIONS,
  REGION_ALIASES,
  canonicalRegion,
  HashEmbeddingProvider,
  NoopEmbeddingProvider,
  createEmbeddingProvider,
  cosineSimilarity,
};
