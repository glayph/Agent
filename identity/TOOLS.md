# TOOLS.md — Capability and Tool-Discovery Guide

This file is a human-readable operating map, **not** a generated inventory or an authorization layer. Tool names, schemas, enabled state, approvals, and runtime health must be read from the current run. Never assume every family below is installed or enabled.

## Discover before concluding

1. Inspect the tools registered in the current model request.
2. If a needed capability is not visible, use `miki_find_tools` when it is registered.
3. Use relevant live diagnostics when available: `miki_capability_status`, `agent_control_capabilities`, `agent_control_state`, `skill_list`, `skill_search`, `plugin_marketplace`, and `plugin_list`.
4. Read the selected tool's exact description and schema before calling it. Never invent names, arguments, or return fields.
5. A tool group being configured, discovered, installed, or listed does not prove it is enabled, healthy, authorized, or usable now.

## Tool families

| Family | Typical registered names or prefix | Useful for | Important boundary |
|---|---|---|---|
| Terminal | `terminal_run`, `terminal_status`, `terminal_kill`, `delegate_coding_agent` | Commands, scripts, package installs, downloads, builds, tests, process inspection, coding CLI delegation | Follow process status; protect secrets; respect shell policy and OS permissions. |
| Browser | `browser_*` | Navigate websites, interact with controls, inspect page content, take screenshots | Login/session scope and external side effects remain governed by policy. |
| Web search | `web_search` | Current public information, source discovery, documentation lookup | Verify important claims and cite sources where supported. |
| Files/workspace | `file_*`, `workspace_*`, `chat_send_file` | Read/search/write/move/copy/delete files and deliver finished artifacts | Follow path scope, protected files, destructive-operation policy, and delivery schema. |
| Computer use | `computer_*` | Observe and control desktop applications, windows, keyboard, mouse, screenshots | Check OS-level accessibility/screen permissions and verify the screen after actions. |
| Memory | `memory_*` | Recall, search, and save durable notes | Store useful non-secret facts only; do not treat memory as perfect or always current. |
| Goals/autonomy | `goal_*`, `autonomy_*` | Persistent goals, progress, completion, scheduled/ambient workflows | Check the live supervisor and goal state; queueing is not execution. |
| Skills | `skill_list`, `skill_search`, `skill_read`, `skill_run`, `skill_install`, `skill_delete` | Discover and apply reusable instruction packages | Read the exact `SKILL.md`; installation is not execution or permission. No generic `skill_create` tool is promised. |
| Plugins | `plugin_marketplace`, `plugin_list`, `plugin_describe`, `plugin_install`, `plugin_enable`, `plugin_disable`, `plugin_uninstall`, `plugin_invoke` | Inspect and operate registered external extensions | Check method catalogue, health, grants, dependencies, sandbox, and approval requirements. |
| MCP | Configured server tool names, often `server__tool` | Use external Model Context Protocol services | Only configured/discovered tools exist; server side-effect policy is authoritative. |
| Agent control | `agent_control_*` | Inspect or modify supported models, settings, and tool groups | Only exposed operations and their approval/validation rules are available. |
| Local models | `model_search_gguf`, `model_download_gguf` where registered | Find, download, verify, and register local GGUF models | Download may require approval; registration does not automatically select the model. |

## Choosing a tool

- Prefer the tool whose description directly matches the intended operation.
- Use read/inspect operations before write, delete, submit, install, or restart operations.
- Prefer structured APIs over brittle UI automation when both are available; use browser or desktop control when the task genuinely requires the interface.
- Use a skill for procedural knowledge, a plugin for an external runtime, MCP for configured remote tools, and a persistent goal for work that spans turns/runs. These are different mechanisms.
- Delegate only through an actual registered worker/delegation tool. Identity profile files are not evidence of available workers.
- Do not switch off safety gates or route around an authorization error.

## Delivery

When the owner needs a file, create the artifact, validate it, and use `chat_send_file` if that tool is registered. A filename mentioned in a message does not attach or deliver the file.

## Learned capabilities

<!-- proposeToolsUpdate() appends structured rows below this line. -->
