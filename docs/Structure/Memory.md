# Hiro-memory — GraphRAG Memory

Standalone GraphRAG memory server (plain JavaScript) providing temporal knowledge graphs,
intelligent text chunking, hybrid BM25 + vector search, and memory optimization.

```
Hiro-memory/
├── src/
│   ├── cli.js                       CLI entry point for running the memory server
│   ├── config.js                    Memory server configuration
│   ├── nodegraphrag.js              Main library entry point
│   ├── api/                         Express memory API
│   │   ├── server.js                Standalone Express server (forked child process)
│   │   └── routes.js                REST API routes for memory operations
│   ├── core/                        Memory engine
│   │   ├── memory-manager.js        Memory CRUD and graph operations
│   │   ├── graph-store.js           Knowledge graph storage and retrieval
│   │   ├── chunk-engine.js          Intelligent text chunking for embedding
│   │   ├── vector-index.js          Hybrid BM25 + vector similarity search
│   │   ├── temporal-engine.js       Time-aware memory recall and decay
│   │   └── optimizer.js             Memory optimization and pruning
│   └── test/                        Test runner
├── data/                            Memory persistence storage
├── package.json
└── README.md
```
