'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const config = require('../config');
const MemoryManager = require('../core/memory-manager');
const TemporalKnowledgeGraph = require('../temporal-knowledge-graph');
const MemoryConsolidationDaemon = require('../memory-consolidation-daemon');
const setupRoutes = require('./routes');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

let memoryManager;
let tkg;
let consolidationDaemon;

function broadcast(event, data) {
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  if (memoryManager) {
    memoryManager.getStats().then(stats => {
      ws.send(JSON.stringify({ event: 'stats:update', data: stats, timestamp: new Date().toISOString() }));
    });
  }
  ws.on('close', () => console.log('[WS] Client disconnected'));
  ws.on('error', (err) => console.error('[WS] Error:', err.message));
});

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    mode: tkg ? 'v2-temporal-knowledge-graph' : 'v1-classic'
  });
});

app.get('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.use((err, req, res, next) => {
  console.error('[API Error]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

async function start() {
  try {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   Temporal Knowledge Graph Memory System v2     ║');
    console.log('║   Event-Driven Stream Architecture              ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');

    memoryManager = new MemoryManager(config);
    await memoryManager.initialize(config.dataDir);
    console.log(`[INIT] Classic MemoryManager initialized at ${config.dataDir}`);

    tkg = new TemporalKnowledgeGraph(path.join(config.dataDir, 'temporal-knowledge-graph.db'));
    await tkg.initialize();
    console.log('[INIT] TemporalKnowledgeGraph (SQLite) initialized');

    consolidationDaemon = new MemoryConsolidationDaemon(tkg);
    consolidationDaemon.start();
    console.log('[INIT] MemoryConsolidationDaemon started');

    if (memoryManager) {
      memoryManager.on('memory:stored', (data) => broadcast('memory:stored', data));
      memoryManager.on('memory:retrieved', (data) => broadcast('memory:retrieved', data));
      memoryManager.on('memory:updated', (data) => broadcast('memory:updated', data));
      memoryManager.on('memory:removed', (data) => broadcast('memory:removed', data));
      memoryManager.on('search:completed', (data) => broadcast('search:completed', data));
      memoryManager.on('optimize:completed', (data) => broadcast('optimize:completed', data));
    }

    setupRoutes(app, memoryManager, tkg);

    server.listen(config.port, config.host, () => {
      console.log(`[SERVER] API running at http://${config.host}:${config.port}`);
      console.log(`[SERVER] WebSocket at ws://${config.host}:${config.port}/ws`);
      console.log('[READY] System is ready.');
    });

  } catch (err) {
    console.error('[FATAL] Failed to start:', err);
    process.exit(1);
  }
}

async function shutdown(signal) {
  console.log(`\n[SHUTDOWN] Received ${signal}, saving data...`);
  try {
    if (consolidationDaemon) consolidationDaemon.stop();
    if (tkg) tkg.close();
    if (memoryManager) await memoryManager.shutdown();
    console.log('[SHUTDOWN] All data saved. Goodbye.');
    process.exit(0);
  } catch (err) {
    console.error('[SHUTDOWN] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});

start();

module.exports = { app, server, memoryManager, tkg, consolidationDaemon };
