# identity/ — Workspace-Identity Files (upgrade step 01)

This is Miki's version of OpenClaw's SOUL/AGENTS/IDENTITY/USER/TOOLS
convention: plain, human-editable files that give every agent run the same
starting context, loaded once per turn and assembled into a prompt prefix.

## Why "identity/" and not "workspace/"

The upgrade plan's own spec names this directory `workspace/`. It was
renamed here because "workspace" already means two other things in this
codebase:

- `RuntimePaths.sourceDir` / `MIKI_WORKSPACE_DIR` — the install root in an
  OS-installed release.
- `workspace-folders` (`packages/core/src/workspace-folders/`) — the
  user-managed project folders Miki indexes and works within, each of which
  can carry its own `.miki/rules.md`.

Reusing "workspace" a third time would make all three easy to confuse.
Behavior and file layout otherwise follow the plan as written.

## Files

| File | Loaded for | Notes |
|---|---|---|
| `SOUL.md` | every run | Read-only to agent tools — see below. |
| `AGENTS.md` | every run | Global operating rules. |
| `agents/<specialistId>/AGENTS.md` | that specialist only | Optional override, layered after the global file. `miki`/`sage`/`forge`/`scout` are seeded; any other specialist id added later works the same way. |
| `IDENTITY.md` | every run | Name/persona notes. |
| `USER.md` | every run | Operator & project context. Optional — fine to leave blank. |
| `TOOLS.md` | every run | Capability registry snapshot. Optional. |

Load order (fixed, see `packages/core/src/identity/loader.ts`):
`SOUL → AGENTS (global) → AGENTS (role) → IDENTITY → USER → TOOLS`.

A missing file just means that section is skipped — nothing crashes, and
nothing falls back to old behavior on a per-file basis. Fallback to the
legacy `agent.persona` string in `config/agent.yaml` only happens when this
entire directory doesn't exist yet (i.e., before step 01 was adopted).

## Systemwide scope (no workspace confinement)

Miki is a systemwide agent. `RuntimePaths.sourceDir` (the install root) is
Miki's home for its own config/data and the default base for relative
paths and shell cwd — it is **not** a permission boundary. File and shell
tools are confined to it only if an operator explicitly sets
`agent.security.system_access` to `workspace_only` or `isolated` in
`config/agent.yaml` (default: `full`). Read by
`packages/core/src/tools/executor/system-access.ts` and applied through
`ToolRegistry.applySystemAccessMode()`. Destructive actions are gated by
approval (`tools.require_confirm_*`), independent of scope.

## SOUL.md is read-only to agent tools

Enforced in code, not just by convention: `file_write`/`file_delete`
(`packages/core/src/tools/executor/file-security.ts`) refuse any call that
resolves to this directory's `SOUL.md`, logging the refusal the same way
other denied file operations are logged. Edit it directly, as a human,
outside of any agent tool call.

This does not stop a raw shell command from editing the file — that gap
closes with step 04's tool-exec-permissions layer, not this one.

## Adding to AGENTS.md / TOOLS.md programmatically

Never via a raw file write. Use the controlled helpers in
`packages/core/src/identity/propose-update.ts`:

- `proposeAgentsUpdate(identityDir, note, specialistId?)` — appends one
  timestamped bullet under `## Agent-Proposed Additions` in the global or a
  role's `AGENTS.md`.
- `proposeToolsUpdate(identityDir, { tool, role?, note })` — appends one
  structured row under `## Learned Capabilities` in `TOOLS.md`.

Both are append-only and validate their input; neither is wired up as a
callable LLM tool yet. That's intentionally left for step 04/05, once
there's a permission-gated tool layer to register them against.

## Where this plugs in

- `RuntimePaths.identityDir` (`packages/core/src/paths.ts`) — defaults to
  `<sourceDir>/identity` in dev mode, `<config root>/Miki/identity` in an
  OS-installed release. Overridable per-run via `agent.identity.path` in
  `config/agent.yaml`.
- `Agent._buildSystemContent` (`packages/core/src/agent.ts`) — calls
  `loadIdentityContext(identityDir, routeDecision.selected.id, fileMemoryBlock)`
  once per turn and uses the assembled text as the system persona block.

## Memory lives here too (step 02)

`packages/core/src/memory-files/` implements OpenClaw-style file memory,
rooted at this same `identityDir` (one memory for the whole agent —
systemwide, not per workspace folder):

- `MEMORY.md` — curated long-term facts/decisions, appended to by the
  `memory_note` tool (`scope: long_term`) or directly by a human. Read-only
  to the agent's own file tools in the same sense `SOUL.md` is (see above);
  the agent writes to it only through `memory_note`, never `file_write`.
- `memory/YYYY-MM-DD.md` — a running daily note (`memory_note` with
  `scope: daily`, and the silent pre-compaction "flush").
- `memory/YYYY-MM-DD-HHMM-<slug>.md` — one file per finished session,
  written in the background when a session ends, goes idle, or the process
  shuts down.
- `memory/compactions/*.md` — archives of context that was folded into a
  rolling summary when a session's context window filled up. Nothing is
  deleted; the full session history stays in the session store, and the
  compacted turns are also kept here in full.

Agent-facing tools: `memory_search` (BM25 over all of the above),
`memory_get` (read one file / line range), `memory_note` (write). All three
refuse to touch anything outside `MEMORY.md` / `memory/**.md`.

This is independent of the older SQLite/TKG memory (`packages/memory/`),
which keeps running unchanged — its writes just move to a background queue
(`AgentOrchestrator.fileMemory.background(...)`) so they can never delay a
turn. Config: `agent.memory.files.*` in `config/agent.yaml`.
