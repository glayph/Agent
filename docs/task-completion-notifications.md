# Background task completion notifications

When a durable scheduled task reaches a terminal state, Miki writes one assistant notification into the task's canonical session. The notification is therefore available in the main conversation even when the dashboard was closed during execution.

The notification contains the task title, `succeeded` or `failed` status, a concise result or error summary, artifact references, execution duration, and a retry command in the form `/retry <task-id>`. Artifact references are rendered as links when they are URLs or file references.

Notification delivery is idempotent. SQLite stores `notification_sent_at` together with the task terminal state. The scheduler marks the notification identity before invoking the notifier, and uses a stable history message ID derived from the task ID and completion timestamp. Repeated scheduler ticks, process restarts, or duplicate completion handling therefore cannot append the same completion notification twice. Recurring schedules receive a new notification identity only after advancing to their next execution.

The notification is linked to the task ID as its turn and run metadata, and failed notifications are rendered as assistant error messages while retaining the retry command. The task's `result_summary`, `artifact_refs`, title, and notification timestamp are persisted in `scheduled-tasks.db`.
