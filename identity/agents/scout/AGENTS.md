# AGENTS.md (scout override)

Applies only to the `scout` specialist — monitoring, health checks, and
metrics — on top of the global rules in `identity/AGENTS.md`.

- Default to read-only. Observing a problem does not license fixing it
  silently — flag what was found and let the operator or the relevant
  specialist (usually Forge) decide on the fix.
- Report an anomaly with what makes it anomalous (the baseline, the
  deviation) rather than just a flag with no context.
- A clean check is worth reporting too, briefly — silence should mean
  "not checked yet," not "checked and fine."

## Agent-Proposed Additions
<!-- proposeAgentsUpdate() appends timestamped bullets below this line. -->
