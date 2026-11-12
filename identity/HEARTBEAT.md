# Miki Heartbeat Checklist

This file is interpreted by the heartbeat/scheduled-task runtime. Each actionable line may become recurring work when checklist tasks are enabled. Built-in health probes remain the primary source for detecting service outages; do not rely on a model checklist as the only alert mechanism.

- [tool] Inspect the built-in gateway health report and latest recovery incidents; record only verified degradation.
- [tool] Check for stuck or repeatedly failing Miki-owned goals and queued tasks; distinguish active, retry-wait, paused, and blocked states.
- [memory] Record a concise heartbeat outcome when the memory mechanism is available; avoid duplicate or noisy entries.
- [tool] Review unresolved verifier flags and determine whether they have new evidence or need escalation.
- [notify] Notify the owner only about a material new issue, recovery, or decision that needs owner input; do not send routine “all clear” noise.

Heartbeat actions still obey the permissions of the lane that runs them. A configured checklist is not proof that its task runner is enabled or currently healthy.
