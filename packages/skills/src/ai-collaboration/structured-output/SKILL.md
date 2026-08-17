---
name: structured-output
description: "Produce validated, schema-compliant structured data for direct consumption by tools, APIs, or pipelines."
version: 1.0.0
author: Hiro
license: MIT
platforms: [linux, macos, windows]
metadata:
  Hiro:
    tags: [structured-output, json, schema, tool-integration]
    related_skills: [testing-debugging]
---

# Structured Output & Tool Integration

## Output formats by use case

### JSON (machine consumption)
```json
{
  "action": "edit_file",
  "params": { "filePath": "...", "oldString": "...", "newString": "..." }
}
```

### CSV/TSV (tabular data)
```
name,type,path
main,entry,src/index.ts
```

### Markdown tables (human + machine)
```markdown
| Key | Value |
|-----|-------|
|`timeout`|30000|
```

### YAML (config generation)
```yaml
server:
  host: 127.0.0.1
  port: 8000
```

## Schema-first approach
1. Define output shape before generating content
2. Validate output against schema after generation
3. Reject + retry if validation fails (max 2 retries)

## Tool integration patterns

### Pattern A — Direct tool call
Output maps 1:1 to tool parameters. Produce JSON that feeds directly into tool execution.

### Pattern B — Pipeline format
Output is an ordered array of tool calls for sequential execution:
```json
[
  { "tool": "grep", "args": { "pattern": "foo", "path": "src" } },
  { "tool": "read", "args": { "filePath": "<result>" } }
]
```

### Pattern C — Conditional branching
Output includes `condition` field to decide next step:
```json
{
  "condition": "file_exists",
  "if_true": { "tool": "read", ... },
  "if_false": { "tool": "write", ... }
}
```

## Rules
- Always wrap JSON in code fences with language tag
- Flatten nesting to max 3 levels deep unless schema requires deeper
- Null fields: omit instead of including as `null`
- Arrays: prefer homogeneous types, no mixing
- Use snake_case for keys (matches opencode tool conventions)
