# 06 — CLI and Bundled Skill Subsystem

## packages/cli

`@miki/cli` provides the supported `miki` command and runtime lifecycle controller. Its TypeScript source owns command parsing, diagnostics, gateway start/stop/restart, the interactive terminal dashboard and self-contained package assembly. The CLI consumes built Gateway/Core/Memory/UI artifacts; use the root build pipeline or the documented CLI build script before testing a distribution.

Common commands:

```bash
miki                 # start the runtime
miki start           # explicit start
miki doctor          # environment and runtime diagnostics
miki install         # create/register runtime workspace as supported
miki uninstall      # remove registration; retained data is not implied to be deleted
miki help
```

Consult [packages/cli/README.md](../../packages/cli/README.md) and the CLI source for current options. Older notes describing a required Go TUI are historical; Go compatibility sources are not required for the current TypeScript CLI path.

## Bundled skills location

There is no independent `packages/skills/` workspace in this repository. The bundled catalogue, manager/discovery, governance integration and installer implementation are all located within `packages/core/src/plugins/skills/` and are built as part of `@miki/core`.

A skill is reusable procedural knowledge. Its presence does not create a worker, grant a permission, enable a tool, install an external plugin or bypass an approval requirement. Runtime tool registration and authorization remain authoritative.

This structure guide is not a Skill definition. Skill catalogue files such as `SKILL.md` are a protected scope during the Agent-Miki persona/documentation upgrade and must not be modified as part of that work.
