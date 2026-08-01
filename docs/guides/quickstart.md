# 🎯 Quickstart Guide

## Overview

Welcome to glayph/agent! This guide will help you get up and running with the autonomous AI agent framework in minutes. We'll cover installation, configuration, and basic usage to get your agent operational.

---

## 📋 Prerequisites

| Requirement | Version / Installation | Notes |
|-------------|-----------------------|-------|
| **Node.js** | `^20.19.0 || ^22.13.0 || >=24` | npm 10.8.2 |
| **Go** | optional | Only needed for CLI from source |
| **pnpm** | via Corepack | Required for web UI build |

### Installing Dependencies

```bash
# Install Node.js dependencies
npm ci --no-audit --no-fund

# Install Python dependencies (optional, for skills)
python -m pip install --user -r requirements.txt
```

> **Note**: The `allowScripts` setting in package.json permits the `better-sqlite3` native rebuild.

---

## ⚙️ Configuration

### Creating Environment File

```bash
# Copy example to production config
copy .env.example .env
```

### Required Environment Variables

| Variable | Purpose | Example |
|----------|---------|---------|
| `GEMINI_API_KEY` | Primary LLM provider | `AIzaSy...` |
| `DEFAULT_MODEL` | Default model selection | `google/gemini-2.0-flash-001` |
| `CORE_HOST` | Core agent endpoint | `127.0.0.1:8000` |
| `GATEWAY_HOST` | Dashboard/gateway endpoint | `127.0.0.1:18800` |

### Example `.env` File

```bash
# LLM Configuration
GEMINI_API_KEY=AIzaSyD_example_api_key_here
DEFAULT_MODEL=google/gemini-2.0-flash-001

# Network Configuration
CORE_HOST=127.0.0.1:8000
GATEWAY_HOST=127.0.0.1:18800

# Optional - API Key Authentication
ENABLE_API_KEY_AUTH=true
API_KEY_SECRET=your-secret-key-here

# Optional - MCP Support
ENABLE_MCP=false

# Optional - Allowed Origins
Hiro_ALLOWED_ORIGINS=http://localhost:18800,http://127.0.0.1:18800
```

---

## 🚀 Getting Started

### Step 1: Build the Agent

```bash
# Build all packages (recommended)
npm run build:all

# Or build specific components
npm run build:webui      # React web UI
npm run build:go-backend # Go launcher backend
npm run build:cli       # Go CLI binary
```

### Step 2: Initialize Configuration

```bash
# Run health checks
npm run doctor

# Initialize configuration if needed
agent doctor
```

### Step 3: Start the Agent

```bash
# Start with dashboard and runtime
npm start

# OR for development with live rebuilds
npm run dev
```

> **Web Dashboard**: Access at `http://127.0.0.1:18800`

---

## 🎛️ Basic Agent Initialization

### TypeScript/JavaScript Integration

```typescript
import { Agent } from '@glayph/agent';

// Initialize agent with configuration
const agent = new Agent({
  name: 'Research Assistant',
  persona: 'Miki',
  model: 'google/gemini-2.0-flash-001',
  tools: ['browser_navigate', 'file_read', 'web_search'],
  memory: {
    enabled: true,
    type: 'sqlite-vector',
    persistence: true
  },
  channels: {
    hiro: true,
    web: true
  },
  safety: {
    sandbox: true,
    validation: 'strict'
  }
});

// Start the agent
await agent.start();
```

### Core Concepts

#### 1. **ReAct Loop**
- **Reason**: Analyze task and plan approach
- **Act**: Execute tools and functions
- **Observe**: Process results and refine

#### 2. **Skill System**
- Dynamic tool registration
- Context-aware execution
- Safety sandboxing

#### 3. **Memory Architecture**
- Three-tier memory: episodic, semantic, procedural
- Vector store for semantic search
- Temporal graph for event tracking

#### 4. **Communication Channels**
- Direct WebSocket for real-time messaging
- HTTP APIs for external integrations
- Event-driven architecture via Hermes bus

---

## 🛠️ Running Locally

### Development Setup

```bash
# Set up development environment
npm run dev

# Build only runtime if stale
npm run build-runtime-if-stale
```

### Production Deployment

```bash
# Start with supervisor (recommended)
agent start

# Or start gateway directly
npm start

# Check agent health
agent doctor
```

### Configuration Examples

#### Agent Configuration (`config/agent.yaml`)

```yaml
name: "Research Assistant"
persona: "Miki"
resource_profile: "balanced"

browser:
  headless: false
  user_agent: "Mozilla/5.0..."
  viewport: {width: 1920, height: 1080}

memory:
  enabled: true
  server: "graphrag-memory"
  port: 3777

heartbeat:
  interval: 30
  timeout: 60

concurrency:
  max_tasks: 5
  tool_timeout: 30

self_improvement:
  enabled: true
  quality_threshold: 0.85
```

#### Tools Configuration (`config/tools.yaml`)

```yaml
permissions:
  shell_execute: "full"
  file_read: "read-only"
  file_write: "workspace-only"
  browser_navigate: "allowed"

timeouts:
  shell_execute: 300
  web_search: 60
  browser_navigate: 120

output_caps:
  shell_execute: "100MB"
  web_search: "10KB"
```

---

## 🚀 Deployment

### Production Setup

1. **Database Setup**
   ```bash
   # Initialize agent memory database
   npx glayph-agent init-db
   ```

2. **Security Configuration**
   - Set up secret vault
   - Configure API key authentication
   - Set up SSL certificates

3. **Monitoring**
   - Enable audit logging
   - Set up health checks
   - Configure backup strategies

### Multi-Agent Deployment

```typescript
import { AgentCluster } from '@glayph/agent-cluster';

const cluster = new AgentCluster({
  agents: {
    general: 'Research Assistant',
    engineer: 'Code Specialist',
    researcher: 'Data Analyst',
    planner: 'Project Manager'
  },
  router: {
    strategy: 'task-based',
    specialization: true
  },
  blackboard: {
    shared_memory: true,
    synchronization: 'eventual'
  }
});

await cluster.deploy();
```

---

## 🔧 Troubleshooting

### Common Issues

#### Chat fails with missing credential error
**Fix**: No LLM API key configured
```bash
# Set via .env
GEMINI_API_KEY=your-key

# OR via dashboard
# Navigate to Models/Credentials page

# OR via CLI
agent config set GEMINI_API_KEY your-key
```

#### Provider rejects API key
**Fix**: Invalid stored API key
```bash
# Update in dashboard
# Navigate to Credentials -> Update

# OR regenerate key
# Delete old key and create new one
```

#### Gateway health times out
**Fix**: Port conflicts or service issues
```bash
# Check logs
agent logs --gateway

# Free configured ports
# Check: lsof -i:18800
# Kill conflicting processes
```

### Debug Mode

```typescript
const debugAgent = new Agent({
  debug: true,
  logLevel: 'verbose',
  safety: {
    sandbox: 'strict',
    validation: 'enhanced'
  }
});
```

---

## 📚 Further Reading

- [Skills Guide](/guides/skills.md) - Learn to create custom skills
- [Architecture Overview](/architecture/react.md) - Deep dive into ReAct engine
- [Ecosystem Guide](/ecosystem/hermes.md) - Message bus and communication

---

## 🚀 Get Started Now!

```bash
# Quick start in 3 steps:
1. npm install
2. npm start
3. Visit http://127.0.0.1:18800
```

Your agent is ready to assist! 🎉

---