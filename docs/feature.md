# Feature Notes

[README](README.md) | [Documentation](Documentation.md)

Hiro is built as a practical local assistant runtime. The feature
set is grouped around running the agent, inspecting what it did, configuring the
model/tool surface, and keeping the local environment recoverable.

## Runtime

The root launcher starts the complete local stack. It checks required artifacts,
starts the Go CLI, starts the gateway, and lets the gateway supervise the core
API and LiteLLM process. The same entrypoint works for a source checkout and a
packaged runtime.

## Dashboard

The dashboard is the main operating surface. It includes chat, model/provider
configuration, credentials, channel setup, skill management, tool settings,
agent run history, health checks, logs, config editing, file browsing, and
workspace indexing.

The UI is intentionally operational rather than decorative: most pages are
there to configure, run, inspect, or recover the local agent.

## Agent Core

The core runtime manages chat sessions, tool calls, memory, goals, scheduled
tasks, model access, skill loading, MCP sessions, channels, and safety systems.
Memory is backed by SQLite and includes sessions, messages, facts, goals,
habits, heartbeat records, tasks, profiles, and model records.

## Tools And Skills

Tools are exposed through a registry with policy-aware execution. The runtime
includes support for shell/file style work, browser/crawler flows, project
workflow helpers, dependency resolution, and registry state management.

Skills can be bundled, installed, imported, inspected, searched, and removed.
The installer supports local, git, npm, and ClawHub-style sources.

## MCP

An in-process MCP server is mounted at `/mcp`. The gateway proxies MCP traffic,
and the core handles tools, resources, prompts, discovery, connector helpers,
and session permissions.

## Channels

Hiro includes local surfaces for hiro/Web chat plus channel configuration for
Telegram, Discord, Slack, Matrix, IRC, OneBot, MQTT, LINE, WhatsApp, WeChat,
WeCom, Feishu, DingTalk, QQ, and generic form-backed integrations. The default
Node runtime includes functional adapters for Telegram, Discord, Slack, Matrix,
IRC, OneBot, MQTT, LINE, WhatsApp bridge, Feishu/Lark webhooks, DingTalk robot
webhooks, and QQ webhook callbacks.

WeChat/WeCom are represented in the UI and configuration layers, but their live
runtime adapters are currently partial: the dashboard may show setup steps, yet
service-level handshakes and message handling are not fully wired through the
runtime.

External channels need credentials and provider setup before they become
production-ready. Probe results should report `ready`, `needs_config`,
`degraded`, or a concrete error rather than implying a false success.

## Operations

The Health and enhancement APIs cover the operational side of the runtime:

- config validation
- doctor checks
- full health reports
- safe mode
- backups and rollback
- migrations
- persistent jobs
- watchdog probes
- audit events
- secret scanning
- performance timing
- agent run records and exports

## Security Defaults

The default configuration is local-first:

- loopback dashboard origin
- optional API key authentication
- workspace-scoped file and shell behavior
- destructive-action confirmation
- secret masking in dashboard flows
- audit logging
- gateway security headers

This gives a safe local baseline while still allowing explicit production
hardening through `.env` and config files.
