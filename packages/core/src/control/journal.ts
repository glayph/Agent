import * as fs from "fs";
import * as path from "path";

export interface ControlJournalEntry {
  operationId: string;
  status: string;
  capability: string;
  action: string;
  risk: string;
  input: Record<string, unknown>;
  at: string;
  changed?: boolean;
  pending_restart?: boolean;
  approval_request_id?: string;
  error?: unknown;
}

export class ControlJournal {
  private readonly filePath: string;
  private entries: ControlJournalEntry[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.entries = this.load();
  }

  append(entry: ControlJournalEntry): void {
    this.entries.push(entry);
    if (this.entries.length > 500) this.entries = this.entries.slice(-500);
    this.persist();
  }

  list(limit = 100): ControlJournalEntry[] {
    return this.entries
      .slice(-Math.max(1, Math.min(500, limit)))
      .map((entry) => ({
        ...entry,
        input: JSON.parse(JSON.stringify(entry.input)),
      }));
  }

  private load(): ControlJournalEntry[] {
    try {
      const parsed = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((entry): entry is ControlJournalEntry => {
        if (!entry || typeof entry !== "object") return false;
        const value = entry as Record<string, unknown>;
        return (
          typeof value.operationId === "string" &&
          typeof value.status === "string" &&
          typeof value.capability === "string" &&
          typeof value.action === "string" &&
          typeof value.risk === "string" &&
          typeof value.at === "string" &&
          Boolean(
            value.input &&
            typeof value.input === "object" &&
            !Array.isArray(value.input),
          )
        );
      });
    } catch {
      return [];
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.tmp`;
      fs.writeFileSync(temp, `${JSON.stringify(this.entries, null, 2)}\n`, {
        mode: 0o600,
      });
      if (process.platform === "win32") {
        fs.copyFileSync(temp, this.filePath);
        fs.rmSync(temp, { force: true });
      } else {
        fs.renameSync(temp, this.filePath);
      }
    } catch {
      // A journal failure must not turn a successful guarded operation into an
      // unhandled process failure. The caller still receives the operation result.
    }
  }
}
