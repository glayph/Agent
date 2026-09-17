# 06 — CLI & Skills

## packages/cli

Self-contained package that publishes the `miki` binary. Can be installed globally.

```
packages/cli/
├── package.json                 # @miki/cli — bin: miki → dist/pack/bin/miki.js
├── README.md                    # Usage documentation for the CLI
├── main.go                      # Go entry for terminal dashboard (TUI)
├── tui.go / styles.go           # Terminal UI rendering
├── config.go / runtime.go       # Config & runtime management
├── process_unix.go / process_windows.go  # Platform process handling
├── terminal_selection_*.go      # Terminal selection helpers
├── logbuffer.go                 # Log buffering
├── help.go / plain.go           # Help and plain-output modes
├── agent.js                     # Node-side agent helper
├── go.mod / go.sum              # Go module definition
├── pnpm-lock.yaml
└── scripts/
    └── pack-self-contained.mjs  # Builds the self-contained distribution tarball
```

**Comments**
- Primary user-facing command: `miki`, `miki start`, `miki doctor`, `miki install`, `miki uninstall`.
- When a Go binary is present it shows a terminal dashboard; otherwise falls back to headless mode with web UI still available.
- The pack script embeds a complete runtime so the published npm package does not require the full monorepo.

## packages/skills

Pre-bundled skills that the agent can load and execute under governance.

```
packages/skills/
├── package.json                 # @miki/skills
├── tsconfig.json
├── validate-skills.mjs          # Skill validation utility
└── src/
    ├── index.ts                 # Skill registry / exports
    └── goal-completion/         # Example / built-in skill modules
        └── index.ts
```

**Comments**
- Skills are discovered and governed by the skill-governance engine inside core.
- Validation script ensures skill manifests meet expected contracts before packaging.
