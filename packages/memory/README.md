# GraphRAG Memory System for Agentic AI

A high-performance, temporal, graph-based memory system designed specifically for stateful AI Agents. It implements a hybrid vector-graph architecture with semantic text chunking, time-decay scoring, temporal validity constraints, entity auto-extraction, and data optimization pipelines.

Includes a stunning, real-time dark-mode visual web dashboard.

---

## 🚀 Key Features

*   **Three-Tier Memory System**:
    *   **Episodic Memory**: Logged experiences and interactions indexed temporally.
    *   **Semantic Memory**: Structured facts, entities, and conceptual relations constructed as a knowledge graph.
    *   **Procedural Memory**: Operations provenance and details logs.
*   **Intelligent Chunk Engine**: Automatically splits text using the best strategy: Fixed-overlap, Sentence boundary, Paragraph boundary, Hierarchical (headers), or Semantic topic shifts (via token Jaccard similarity changes).
*   **Vector Search & BM25 Hybrid Index**: Pure JavaScript implementations of TF-IDF Cosine Similarity and BM25 search ranking. Integrates with the knowledge graph and temporal relevance to produce weighted multi-dimensional search scores.
*   **Temporal Awareness Engine**: Exponential time-decay relevance calculation, validity window tracking, event supersession management, and chronologically grouped timeline queries.
*   **Data Optimizer & Pruning Pipeline**: Jaccard similarity deduplication for entity consolidation, orphan node cleanup, TTL-based memory pruning, co-access edge weight reinforcements, and community re-clustering.
*   **Web Dashboard**: Fully interactive SPA containing visual force-directed graph canvas (physics-based layouts), timeline event activity charts, memories explorer grid, hybrid search sliders, and management panels.

---

## 🛠️ Tech Stack & Requirements

*   **Core**: Node.js (v18+)
*   **Dependencies**: Express.js, CORS, ws (WebSocket)
*   **Web Dashboard**: Vanilla HTML5, CSS3, ES6 Javascript (using Canvas API, zero external framework libraries)

---

## 📦 Directory Structure

```
.
├── public/                 # Web Dashboard
│   ├── index.html          # Dashboard Shell
│   ├── styles.css          # Premium Dark Theme Stylesheet
│   ├── app.js              # View router and API connection script
│   ├── graph-viz.js        # Force-directed Canvas Graph renderer
│   └── timeline-viz.js     # Horizontal Canvas Timeline chart
├── src/
│   ├── api/
│   │   ├── server.js       # HTTP server, WS broadcaster, API entry point
│   │   └── routes.js       # API endpoint route bindings
│   ├── core/
│   │   ├── graph-store.js  # In-memory graph store, BFS, Louvain clusters
│   │   ├── temporal-engine.js # Validity windows, decay scoring, timeline
│   │   ├── chunk-engine.js # Sentence, semantic, hierarchical chunker
│   │   ├── vector-index.js # Stemmer, TF-IDF Cosine, BM25 hybrid search
│   │   ├── optimizer.js    # text normalizer, dedup, merge, orphan cleaning
│   │   └── memory-manager.js # Main orchestrator layer
│   ├── config.js           # Parameter controls and default weights
│   └── test/
│       └── test-runner.js  # Automated integration test suite
├── package.json            # Run scripts and dependencies
└── README.md               # Operations guide
```

---

## 🚦 API Reference

### Memory CRUD

*   `POST /api/memory`
    *   Store a new memory. Runs tokenization, auto-extracts entities, chunks content, creates node associations, and indexes for hybrid search.
    *   **Body**: `{ "content": "OpenAI launched a new GPT-5 model today in San Francisco.", "metadata": { "category": "fact", "tags": ["AI", "Release"] } }`
*   `GET /api/memory/:id`
    *   Retrieve memory details with chunks, logs, lastAccessed update, and related nodes list.
*   `PUT /api/memory/:id`
    *   Update contents of a memory (removes old index mappings, re-chunks new text, updates labels).
*   `DELETE /api/memory/:id`
    *   Delete memory node, its child chunks, search indexes, and temporal records.
*   `GET /api/memories`
    *   List all stored memories paginated, supporting `?type=entity` filters.

### Search & Context Assembly

*   `POST /api/search`
    *   Execute full multi-dimensional search over stored memories.
    *   **Body**: `{ "query": "OpenAI GPT-5", "topK": 5, "weights": { "vector": 0.4, "bm25": 0.3, "graph": 0.2, "temporal": 0.1 } }`
*   `POST /api/context`
    *   Generate a **Minimum Viable Context** prompt ready to inject directly into Agent LLM context windows.
    *   **Body**: `{ "query": "GPT-5 release locations", "maxTokens": 2048 }`

### Graph & Timeline Operations

*   `GET /api/graph`
    *   Fetch full graph nodes and relationships list for visual mapping.
*   `GET /api/graph/neighbors/:id`
    *   Extract local subgraph around node using BFS traversal.
*   `GET /api/timeline`
    *   Get date-bucket grouped timeline metrics and temporal proximity event clusters.

---

## 🧠 NodeGraphRAG Usage (No UI)

You can use the memory engine directly from Node without any web UI:

```bash
node src/cli.js store "NodeGraphRAG stores facts in a graph for retrieval"
node src/cli.js search "graph retrieval"
node src/cli.js context "retrieval memory"
```

Or from another module:

```js
const NodeGraphRAG = require('./src/nodegraphrag');
const rag = new NodeGraphRAG({ dataDir: './data' });
await rag.initialize();
const memoryId = await rag.addMemory('Important fact');
const results = await rag.search('important fact');
const context = await rag.getContext('important fact');
```

## 🏃 Getting Started

### 1. Installation

Install minimal server dependencies:

```bash
npm install
```

### 2. Running Integration Tests

Validate that all core modules (Graph, Temporal, Chunks, Vector Search, Optimizer, Manager) are operating correctly:

```bash
npm test
```

### 3. Launching Server & Dashboard

Start the application server:

```bash
npm start
```

Once running, access the premium dashboard at:
👉 **[http://localhost:3777](http://localhost:3777)**
