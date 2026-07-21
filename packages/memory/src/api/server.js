'use strict';

const express = require('express');
const cors = require('cors');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const config = require('../config');
const MemoryManager = require('../core/memory-manager');
const setupRoutes = require('./routes');

/**
 * GraphRAG Memory System - API Server
 * 
 * Provides REST API endpoints and WebSocket connections for the
 * GraphRAG memory system. Serves the web dashboard and handles
 * all memory operations.
 */

const app = express();
const server = http.createServer(app);

// WebSocket server for real-time updates
const wss = new WebSocketServer({ server, path: '/ws' });

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Serve static dashboard files - Disabled by request
// app.use(express.static(path.join(__dirname, '..', '..', 'public')));

// Initialize Memory Manager
const memoryManager = new MemoryManager(config);

/**
 * Broadcast data to all connected WebSocket clients
 * @param {string} event - Event name
 * @param {Object} data - Event data
 */
function broadcast(event, data) {
  const message = JSON.stringify({ event, data, timestamp: new Date().toISOString() });
  wss.clients.forEach(client => {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(message);
    }
  });
}

// Wire up memory events to WebSocket broadcasts
memoryManager.on('memory:stored', (data) => broadcast('memory:stored', data));
memoryManager.on('memory:retrieved', (data) => broadcast('memory:retrieved', data));
memoryManager.on('memory:updated', (data) => broadcast('memory:updated', data));
memoryManager.on('memory:removed', (data) => broadcast('memory:removed', data));
memoryManager.on('search:completed', (data) => broadcast('search:completed', data));
memoryManager.on('optimize:completed', (data) => broadcast('optimize:completed', data));

// WebSocket connection handler
wss.on('connection', (ws) => {
  console.log('[WS] Client connected');
  
  // Send current stats on connect
  memoryManager.getStats().then(stats => {
    ws.send(JSON.stringify({ event: 'stats:update', data: stats, timestamp: new Date().toISOString() }));
  });

  ws.on('close', () => {
    console.log('[WS] Client disconnected');
  });

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message);
  });
});

// Setup API routes
setupRoutes(app, memoryManager);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

// Catch-all: return 404 for non-API routes
app.get('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('[API Error]', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

// Start server
async function start() {
  try {
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║     GraphRAG Memory System for Agentic AI       ║');
    console.log('║     ─────────────────────────────────────        ║');
    console.log('║     Knowledge Graph + Temporal + Chunking        ║');
    console.log('╚══════════════════════════════════════════════════╝');
    console.log('');

    // Initialize memory manager (creates dirs, loads data)
    await memoryManager.initialize(config.dataDir);
    console.log(`[INIT] Memory system initialized at ${config.dataDir}`);

    // Start HTTP server
    server.listen(config.port, config.host, () => {
      console.log(`[SERVER] API running at http://${config.host}:${config.port}`);
      console.log(`[SERVER] WebSocket at ws://${config.host}:${config.port}/ws`);
      console.log('');
      console.log('[READY] System is ready for memories.');
    });

  } catch (err) {
    console.error('[FATAL] Failed to start:', err);
    process.exit(1);
  }
}

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n[SHUTDOWN] Received ${signal}, saving data...`);
  try {
    await memoryManager.shutdown();
    console.log('[SHUTDOWN] All data saved. Goodbye.');
    process.exit(0);
  } catch (err) {
    console.error('[SHUTDOWN] Error during shutdown:', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle uncaught errors
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT]', err);
});

process.on('unhandledRejection', (err) => {
  console.error('[UNHANDLED REJECTION]', err);
});

start();

module.exports = { app, server, memoryManager };
