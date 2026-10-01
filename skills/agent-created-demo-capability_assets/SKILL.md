---
name: demo-capability
description: "A safe demo skill that explains how to list current workspace files and report their count."
category: agent-created
tags: ["demo", "workspace", "utility"]
version: 0.1.0
enabled: true
---

# demo-capability

# Demo Capability Skill

This skill demonstrates how to inspect workspace files and report their count.

## Instructions
1. Use `workspace_inventory` or `shell_execute` (e.g., `ls -la`) to list all files in the active workspace.
2. Count the files and directories returned.
3. Report the exact file path list and total count clearly to the user.
