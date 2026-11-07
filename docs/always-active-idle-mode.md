# Always-Active Idle Mode

Miki's default Idle Mode starts with the autonomous supervisor, not with a
user-inactivity countdown. While the process is running and the operator has
not paused it, Miki can inspect its environment, choose useful work, execute
tracked goals, and continue without waiting for another user message.

## Runtime cycle

An LLM completion is one finite provider request; the model does not recursively send
another API request after returning its answer. The persistent gateway-side
`AutonomousSupervisor` owns the next request. When its live state is RUNNING,
Idle LLM decisions are enabled, and it is not paused, it starts fresh model calls
without requiring another user message. A user prompt defines a goal; it does not
activate, upgrade, or replace the supervisor.

1. The supervisor starts and makes an initial decision when
   `heartbeat.proactive.startup_decision` is enabled (default: `true`).
2. Before an ambient decision, Miki captures a fresh local computer observation
   when both `autonomy.tool_policy.allow_computer_use` and
   `heartbeat.proactive.observe_computer` allow it. The default observer timeout
   is 15 seconds and adapts after slow responses. Its redacted snapshot is
   ephemeral prompt context, not a chat
   message, durable memory entry, or log record.
3. The model observes/researches and decides whether useful work exists.
4. Useful execution work is added as a durable goal with deterministic
   acceptance evidence. The separate goal lane performs the work and verifies
   its result.
5. When a goal settles or a meaningful lifecycle/configuration event arrives,
   the supervisor is woken immediately and evaluates the next step.
6. When the environment is quiet and no event or goal completion wakes it,
   `decision_interval_seconds` is the next observation/decision cadence. The
   shipped default is 5 seconds. This is not a post-action delay.

The agent engine itself continues its model/tool turn loop while a run is in
progress. The supervisor continues polling and servicing scheduled work while
an ambient decision is in flight. A textual acknowledgement without a queued
goal does not cause an immediate LLM hot loop; it returns to the quiet cadence.
If an observation/decision takes longer than that cadence, the next decision
starts as soon as the current one settles rather than adding another full wait.

## Foreground interaction

- A pending user request takes priority for the ambient decision lane.
- Only the assistant reply linked to that user message in the same session
  releases the foreground gate when the schema supports reply linkage.
- A proactive notice or another session's assistant reply is not treated as the
  answer to the user's message.
- Persisted autonomous goals remain a separate lane and are not discarded by a
  foreground chat turn.

## Capability lanes

The ambient lane may use the read-only workspace, memory search, web search,
browser inspection, and computer observation tools. It cannot use arbitrary
shell commands, write user workspace files, click/type into applications, or
invoke arbitrary external side effects. The narrowly scoped discovery and drive
records update Miki-owned autonomy state; discovery notices are server-gated
and deduplicated. User-workspace mutations and external actions are executed as
tracked goals under the configured goal-execution policy.

`auto_approve_all` does not widen the ambient tool registry. It applies only to
tools admitted to the durable goal-execution lane. Real provider authorization,
OS permissions, user permissions, and other runtime boundaries still apply.

## Configuration

- `heartbeat.proactive.enabled`: enables proactive ambient decisions (default:
  `true`).
- `heartbeat.proactive.llm_when_idle`: enables idle LLM decisions (default:
  `true`). Setting it to `false` leaves scheduled/durable goal execution active.
- `heartbeat.proactive.startup_decision`: controls whether the first ambient
  decision occurs immediately at startup (default: `true`). If false, the first
  quiet-environment decision waits for the configured interval or an event.
- `heartbeat.proactive.decision_interval_seconds`: quiet-environment cadence
  in seconds (default: `5`, minimum `5`). Meaningful events and settled goals
  bypass this cadence, but not provider retry backoff.
- `heartbeat.proactive.observe_computer`: enables ambient computer observation
  when computer use is also authorized (default: `true`).
- `idle_after_seconds: 0`: no user-inactivity activation countdown.

The owner can explicitly pause or stop autonomy. The loop does not override
those controls. “Always active” describes default behavior while the host,
application, network, provider, and required permissions remain available; it
does not mean the process can run while the machine is powered off.

## Status and diagnostics

`GET /api/autonomy/status` exposes the supervisor's live loop state, restart
state, idle mode, observation status, quiet cadence, provider backoff, and
pending work. The `proactive_loop` status includes `mode`, `ambient_in_flight`,
`wake_pending`, `last_decision_at`, `observer`, and
`next_decision_in_seconds`. `proactive_loop.llm_call_lifecycle` states that
individual model calls do not self-schedule, identifies the host supervisor as
the caller responsible for follow-up requests, and reports whether autonomous
follow-up scheduling is enabled and whether provider backoff is active.

The background agent still needs its normal tests and a real deployment soak
test. A running gateway alone is not proof that ambient observations and
follow-up goals are progressing.
