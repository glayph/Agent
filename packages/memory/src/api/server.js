'use strict';
/**
 * Minimal memory API stub — full TKG server not yet shipped in this build.
 * Keeps process manager happy so Miki can start with npm run dev.
 */
const http = require('http');

const port = Number(process.env.MIKI_MEMORY_PORT || process.env.MEMORY_PORT || 18700);

const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, service: 'miki-memory-stub', version: '2.0.0-stub' }));
    return;
  }
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'not_found', message: 'Memory API stub — limited endpoints' }));
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[memory-stub] listening on http://127.0.0.1:${port}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
