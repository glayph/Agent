'use strict';
const path = require('path');

/**
 * Central Configuration for the GraphRAG Memory System
 */
const config = {
  // Server Configuration
  port: parseInt(process.env.MEMORY_PORT) || 3777,
  host: process.env.MEMORY_HOST || 'localhost',
  
  // Storage Locations
  dataDir: process.env.MEMORY_DATA_DIR || path.join(__dirname, '..', 'data'),
  backupDir: process.env.MEMORY_BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups'),
  
  // Storage Options
  autoSaveIntervalMs: 60000, // 1 minute auto-save
  maxBackups: 5,            // Keep top 5 snapshots
  
  // Temporal Scoring Params
  decayHalfLifeHours: 168,  // 1 week half life for memory decay
  defaultValidityDays: 365, // Memories are active for a year by default
  pruneAfterDays: 90,       // Prune memories unused for 3 months with low interaction count
  
  // Chunking Controls
  defaultChunkStrategy: 'semantic',
  maxChunkSize: 1024,
  chunkOverlap: 64,
  
  // Search Retrieval Weight distribution
  searchWeights: {
    vector: 0.4,
    bm25: 0.3,
    graph: 0.2,
    temporal: 0.1
  },
  defaultTopK: 10,
  
  // Graph Dynamics
  communityDetectionIterations: 10,
  maxTraversalDepth: 5,
  
  // Optimizer threshold
  duplicateThreshold: 0.85,     // Jaccard token similarity for merges
  minAccessCountForRetention: 3, // Minimum accesses to keep aged memories
  
  // Diagnostics
  logLevel: process.env.LOG_LEVEL || 'info'
};

module.exports = config;
