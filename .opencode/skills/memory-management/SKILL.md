---
name: memory-management
description: Use when the user asks about external memory, state persistence, session memory, knowledge persistence, or cross-session context. Persist and retrieve structured state across sessions using local files as an external memory store.
---

# External Memory & State Management

## Storage format
Use `.opencode/memory/` directory. Each memory domain gets its own JSON file:

```
.opencode/memory/
├── project-state.json      # active tasks, decisions, blockers
├── known-bugs.json         # bugs discovered across sessions
├── conventions.json        # code style, arch patterns learned
└── changelog.json          # significant changes made
```

## Schema per domain

### project-state.json
```json
{
  "current_task": "string | null",
  "completed_tasks": ["string"],
  "decisions": [{ "what": "string", "why": "string", "date": "ISO" }],
  "blockers": ["string"]
}
```

### known-bugs.json
```json
{
  "bugs": [{ "id": "string", "symptom": "string", "cause": "string", "fix": "string", "status": "open|fixed" }]
}
```

### conventions.json
```json
{
  "conventions": [{ "pattern": "string", "rule": "string", "source": "string" }]
}
```

## Protocol
- **Read** memory at session start (check file mtime)
- **Write** memory on: task completion, bug discovery, arch decision
- **Update in place** — append-only for history, overwrite for current state
- **Keep entries under 3 lines** — avoid bloat

## Commands
- `save: <domain> <key> <value>` — persist a fact
- `read: <domain>` — retrieve all facts for domain
- `forget: <domain> <key>` — remove a fact
