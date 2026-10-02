import * as fs from "node:fs";
import * as path from "node:path";
import type { CronJob, CronStoreSnapshot } from "./types.js";

/**
 * JSON file-backed cron job store.
 * Path convention: <stateDir>/cron/jobs.json
 */
export class CronJobStore {
  private readonly filePath: string;
  private jobs = new Map<string, CronJob>();

  constructor(stateDir: string) {
    const dir = path.join(stateDir, "cron");
    fs.mkdirSync(dir, { recursive: true });
    this.filePath = path.join(dir, "jobs.json");
    this.load();
  }

  get path(): string {
    return this.filePath;
  }

  list(): CronJob[] {
    return [...this.jobs.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  get(id: string): CronJob | undefined {
    return this.jobs.get(id);
  }

  upsert(job: CronJob): void {
    this.jobs.set(job.id, job);
    this.persist();
  }

  remove(id: string): boolean {
    const ok = this.jobs.delete(id);
    if (ok) this.persist();
    return ok;
  }

  /** Replace in-memory state from disk (restart / multi-process reload). */
  reload(): void {
    this.jobs.clear();
    this.load();
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.persist();
        return;
      }
      const raw = fs.readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as CronStoreSnapshot;
      if (data?.version === 1 && Array.isArray(data.jobs)) {
        for (const job of data.jobs) {
          if (job?.id) this.jobs.set(job.id, job);
        }
      }
    } catch {
      // corrupt store → start empty; next persist rewrites
      this.jobs.clear();
    }
  }

  private persist(): void {
    const snapshot: CronStoreSnapshot = {
      version: 1,
      jobs: this.list(),
    };
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snapshot, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}
