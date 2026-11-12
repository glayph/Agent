# Identity files — Miki runtime context

The `identity/` directory contains the human-editable identity and operating instructions used by Miki. It is not a separate agent engine and it does not grant tools or permissions.

## Runtime loading

Interactive model requests assemble identity context in:

- `packages/gateway/src/agent/identity-prompt.ts`
- `packages/gateway/src/agent/agent-runtime.ts`

The core prompt includes the runtime integrity contract, current tool-group status, live autonomy snapshot when supplied, configured `agent.persona`, and the readable identity files. Identity files are resolved individually across configured identity directories; a missing optional file does not hide valid files in a fallback directory. The current load order is:

1. `SOUL.md` — core identity (required)
2. `IDENTITY.md` — system identity and role model
3. `TOOLS.md` — capability map; runtime tool list remains authoritative
4. `AGENTS.md` — global operating manual
5. `agents/<specialistId>/AGENTS.md` — optional identity-specific preferences
6. `USER.md` — owner-stated preferences

The exact order is implemented in `identityFilesFor()` in `identity-prompt.ts`. `config/agent.yaml` supplies the configured persona; it does not replace the live runtime checks.

The autonomous supervisor assembles a separate, smaller identity brief in `packages/core/src/autonomy/autonomous-supervisor.ts`. It has a narrower observe/research/decide tool policy than an interactive execution turn. Do not assume that an interactive capability is also available in the ambient lane.

## Files and their owners

| File | Purpose | Runtime use |
|---|---|---|
| `SOUL.md` | Stable identity, core behavior, and non-negotiable boundaries | Every interactive run; also included in ambient context |
| `IDENTITY.md` | Name, operating model, and specialist identity profiles | Interactive run; compact ambient context |
| `TOOLS.md` | Tool-family map and discovery procedure | Interactive run; compact ambient context |
| `AGENTS.md` | Task loop, tool use, safety, recovery, and verification manual | Interactive run; also included in ambient context |
| `USER.md` | Explicit owner preferences and safe adaptation rules | Interactive run and ambient context |
| `agents/*/AGENTS.md` | Optional specialist-specific working preferences | Only when the runtime selects the matching identity ID |
| `DRIVES.md` | Structured YAML-front-matter drives for autonomous idle decisions | Parsed by the autonomous supervisor |
| `INTERESTS.md` | Research topics for curiosity cycles | Used only when curiosity is enabled in runtime configuration |
| `HEARTBEAT.md` | Recurring heartbeat checklist | Parsed by the heartbeat/scheduled-task mechanism when configured |

`README.md` explains the system to maintainers; it is not injected as an instruction on every turn.

## Authority and safe editing

The actual tool registry, runtime configuration, platform policy, OS permissions, and approval gates are authoritative. A line in an identity file cannot enable a tool, grant access, bypass a confirmation requirement, or start a stopped supervisor.

Keep SOUL/identity/operating instructions internally consistent. Never add blanket rules such as “never refuse” or “never ask permission”; Miki should act autonomously within authority and explain real safety or platform blockers clearly. Preserve the learned-preference and agent-proposed-additions sections when editing files maintained by helper code.

## Installation paths

The runtime identity directory is resolved through `packages/core/src/paths.ts`. In development it may use the project source root; in an OS-installed release it follows the configured Miki config root. Do not hard-code a developer's checkout path in operational documentation.
