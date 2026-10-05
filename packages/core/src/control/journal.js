import * as fs from "fs";
import * as path from "path";
export class ControlJournal {
    filePath;
    entries;
    constructor(filePath) {
        this.filePath = filePath;
        this.entries = this.load();
    }
    append(entry) {
        this.entries.push(entry);
        if (this.entries.length > 500)
            this.entries = this.entries.slice(-500);
        this.persist();
    }
    list(limit = 100) {
        return this.entries
            .slice(-Math.max(1, Math.min(500, limit)))
            .map((entry) => ({
            ...entry,
            input: JSON.parse(JSON.stringify(entry.input)),
        }));
    }
    load() {
        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
            if (!Array.isArray(parsed))
                return [];
            return parsed.filter((entry) => {
                if (!entry || typeof entry !== "object")
                    return false;
                const value = entry;
                return (typeof value.operationId === "string" &&
                    typeof value.status === "string" &&
                    typeof value.capability === "string" &&
                    typeof value.action === "string" &&
                    typeof value.risk === "string" &&
                    typeof value.at === "string" &&
                    Boolean(value.input &&
                        typeof value.input === "object" &&
                        !Array.isArray(value.input)));
            });
        }
        catch {
            return [];
        }
    }
    persist() {
        try {
            fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
            const temp = `${this.filePath}.tmp`;
            fs.writeFileSync(temp, `${JSON.stringify(this.entries, null, 2)}\n`, {
                mode: 0o600,
            });
            if (process.platform === "win32") {
                fs.copyFileSync(temp, this.filePath);
                fs.rmSync(temp, { force: true });
            }
            else {
                fs.renameSync(temp, this.filePath);
            }
        }
        catch {
            // A journal failure must not turn a successful guarded operation into an
            // unhandled process failure. The caller still receives the operation result.
        }
    }
}
