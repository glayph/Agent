# Miki Heartbeat Checklist
# Lines are proactive checks run on the heartbeat lane (never interrupts main user sessions).
# Optional prefixes: [notify] [tool] [memory] [noop]

- [notify] Check for stuck tasks in the command queue
- [memory] Record heartbeat cycle health snapshot
- [tool] Probe local model / gateway health if idle
- Review unresolved verifier flags
