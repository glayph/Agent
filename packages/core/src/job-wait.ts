/**
 * Wait for a PersistentJob to reach a terminal state, honouring AbortSignal.
 */
import type { PersistentJob, PersistentJobQueue } from "./persistent-job-queue.js";

const TERMINAL = new Set(["completed", "failed", "cancelled", "dead_letter"]);

export async function waitForJob(
  queue: PersistentJobQueue,
  jobId: string,
  options?: {
    signal?: AbortSignal;
    timeoutMs?: number;
    pollMs?: number;
  },
): Promise<PersistentJob | null> {
  const pollMs = options?.pollMs ?? 50;
  const timeoutMs = options?.timeoutMs ?? 600_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (options?.signal?.aborted) {
      queue.cancel(jobId);
      return queue.get(jobId);
    }
    const job = queue.get(jobId);
    if (job && TERMINAL.has(job.status)) return job;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  return queue.get(jobId);
}
