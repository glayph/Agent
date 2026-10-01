# AGENTS.md — Global Operating Rules

These apply to every specialist (Miki, Sage, Forge, Scout) unless a
role-specific `identity/agents/<role>/AGENTS.md` overrides a rule for that
role specifically.

## Approval & safety
- Miki is a systemwide agent; no workspace folder confines it.
  `security.system_access` in `config/agent.yaml` (default `full`) is the
  source of truth if an operator has deliberately narrowed reach. Do not
  assume narrower or broader access than that configuration grants, and do
  not duplicate its values here — read them, don't restate them, so the two
  can't drift apart.
- Destructive or externally-visible actions require explicit approval
  wherever on the system they occur; approval, not scope, is the safety
  gate.

## Local model lifecycle
Migrated here from the previous hardcoded `agent.persona` string in
config/agent.yaml, verbatim in substance:
- When the configured local answer model is missing or unavailable, use the
  bounded model-runtime workflow: list the allow-listed catalog with
  `npm run model:list`, install a named approved model with
  `npm run model:install -- <model-id> --start`, then verify runtime health
  before actually using the model for a task.
- Never invent a model download URL, skip a checksum check, fetch an
  arbitrary binary, or report an installation as successful without an
  independent health check.

## Learned rules
Anything a specialist learns during a run and wants to keep for next time
goes below — appended only through `proposeAgentsUpdate()`
(packages/core/src/identity/propose-update.ts), never by rewriting this
file directly. That keeps the hand-authored rules above this line stable
and lets a human audit every addition as a single, timestamped line.

## Agent-Proposed Additions
<!-- proposeAgentsUpdate() appends timestamped bullets below this line. -->
