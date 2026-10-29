# Miki Heartbeat Checklist
# Lines are proactive checks run on the heartbeat lane (never interrupts main user sessions).
# Optional prefixes: [notify] [tool] [memory] [noop]
# Built-in checks that need NO model run inside the gateway on their own (database, model reachability, channels,
# reply outbox, event-loop lag, recovery state; see GET /gateway/health). They keep working when the model is down.
# The lines below are carried out by the model, so they must not be the only way an outage is noticed.

- [notify] Check for stuck tasks in the command queue
- [memory] Record heartbeat cycle health snapshot
- [tool] Read the built-in health report (GET /gateway/health) and the latest recovery incidents; mention only what is degraded
- Review unresolved verifier flags
