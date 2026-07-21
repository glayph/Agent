# gateway — API Gateway

Express-based reverse proxy that serves the dashboard UI, proxies API/WS/MCP traffic
to the core backend, manages LiteLLM proxy process, and enforces CORS/CIDR rules.

```
gateway/
├── src/
│   ├── index.ts                     Gateway server (1169 lines)
│   │                                - HTTP reverse proxy to core API
│   │                                - WebSocket relay
│   │                                - LiteLLM subprocess supervisor
│   │                                - Static dashboard file serving
│   │                                - MCP endpoint proxying
│   │                                - CORS and CIDR enforcement
│   ├── runtime-utils.ts             Core process management (spawn, health check, restart)
│   ├── mcp-proxy.ts                 MCP protocol proxy to core
│   └── types.ts                     Shared gateway type definitions
├── dist/                            Compiled output
├── package.json
└── tsconfig.json
```
