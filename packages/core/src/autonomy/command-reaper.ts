/**
 * Review of commands Miki started during a run that has since ended.
 *
 * A command started with terminal_run (not background:true) belongs to the run that started it. If that run
 * ends while the command is still going, nothing else will ever look at it again. This module decides, from
 * the run's state and the command's own output, which of those commands should be stopped. It never touches
 * commands that a run still owns, commands marked background, or anything Miki did not start.
 */

/** The parts of a ManagedProcess (gateway/process-manager.ts) this review reads. Kept structural to avoid a dependency cycle. */
export interface OwnedCommand {
  id: string;
  command: string;
  runId?: string;
  detached: boolean;
  status: string;
  startedAt: number;
  stdout: { tail(maxChars: number): string };
  stderr: { tail(maxChars: number): string };
}

/** What the review remembers about each command between ticks: the last output seen and when it last changed. */
export interface CommandWatchEntry {
  snapshot: string;
  changedAt: number;
}

export interface CommandReviewInput {
  commands: OwnedCommand[];
  isRunActive(runId: string): boolean;
  now: number;
  /** How long an orphaned command may stay silent before it is stopped. */
  idleMs: number;
  state: Map<string, CommandWatchEntry>;
}

export interface CommandStopAction {
  id: string;
  command: string;
  idleMinutes: number;
  reason: string;
}

const OUTPUT_TAIL_CHARS = 2000;

export function reviewOrphanCommands(input: CommandReviewInput): CommandStopAction[] {
  const actions: CommandStopAction[] = [];
  const stillTracked = new Set<string>();
  for (const command of input.commands) {
    // Only commands Miki started inside a run and did not mark as background are reviewed.
    if (command.status !== "running" || command.detached || !command.runId) continue;
    // A command whose run is still active belongs to that run; it is not an orphan.
    if (input.isRunActive(command.runId)) {
      input.state.delete(command.id);
      continue;
    }
    stillTracked.add(command.id);
    const snapshot = `${command.stdout.tail(OUTPUT_TAIL_CHARS)}\n${command.stderr.tail(OUTPUT_TAIL_CHARS)}`;
    const entry = input.state.get(command.id);
    if (!entry || entry.snapshot !== snapshot) {
      input.state.set(command.id, { snapshot, changedAt: input.now });
      continue;
    }
    const silentMs = input.now - entry.changedAt;
    if (silentMs >= input.idleMs) {
      const idleMinutes = Math.round(silentMs / 60_000);
      actions.push({
        id: command.id,
        command: command.command,
        idleMinutes,
        reason: `its run ended and it printed nothing for ${idleMinutes} min`,
      });
    }
  }
  // Forget commands that have finished or been stopped, so the map does not grow forever.
  for (const id of [...input.state.keys()]) {
    if (!stillTracked.has(id)) input.state.delete(id);
  }
  return actions;
}
