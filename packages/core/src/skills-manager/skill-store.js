import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { extractTarGz } from "@miki/installer";
import { normalizeSkillName, validateSkillName } from "../skill-utils.js";
import { parseSkillMarkdown, readFrontmatterFields } from "./frontmatter.js";
import { isZip, readZip, ZipError } from "./zip.js";
import { scanSkillFiles, summarizeFindings, } from "./scan.js";
export class SkillStoreError extends Error {
    status;
    code;
    details;
    constructor(status, message, code = "skill_error", details) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}
const MARKER = ".miki-skill.json";
const SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);
const MAX_FILES = 2000;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_LISTED_FILES = 200;
const SCRIPT_EXTENSIONS = new Set([
    ".py",
    ".js",
    ".mjs",
    ".cjs",
    ".sh",
    ".ps1",
    ".rb",
    ".pl",
    ".bat",
    ".cmd",
]);
function readMarker(dir) {
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8"));
        return parsed && typeof parsed === "object" ? parsed : {};
    }
    catch {
        return {};
    }
}
function insideDir(root, target) {
    const relative = path.relative(root, target);
    return (relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative)));
}
/** Relative POSIX paths of regular files below `dir`, symlinks skipped. */
function walkFiles(dir, limit = MAX_LISTED_FILES) {
    const out = [];
    const visit = (current, prefix) => {
        if (out.length >= limit)
            return;
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            return;
        }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            if (out.length >= limit)
                return;
            if (entry.name === MARKER || entry.isSymbolicLink())
                continue;
            const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                if (!SKIP_DIRS.has(entry.name))
                    visit(path.join(current, entry.name), rel);
            }
            else if (entry.isFile())
                out.push(rel);
        }
    };
    visit(dir, "");
    // SKILL.md first, then plain code-point order, so the listing is stable across locales.
    return out.sort((a, b) => a === "SKILL.md" ? -1 : b === "SKILL.md" ? 1 : a < b ? -1 : a > b ? 1 : 0);
}
function firstParagraph(body) {
    for (const line of body.split(/\r?\n/)) {
        const text = line.trim();
        if (text && !text.startsWith("#") && !text.startsWith("```"))
            return text.slice(0, 300);
    }
    return "";
}
export class SkillStore {
    options;
    bundledCache = null;
    now;
    constructor(options) {
        this.options = options;
        this.now = options.now ?? Date.now;
    }
    get userDir() {
        return this.options.userDir;
    }
    // ---- discovery ----------------------------------------------------------
    recordFromDir(dir, fallbackName, kind, category) {
        const skillMd = path.join(dir, "SKILL.md");
        let text;
        try {
            text = fs.readFileSync(skillMd, "utf8");
        }
        catch {
            return null;
        }
        const doc = parseSkillMarkdown(text);
        const fields = readFrontmatterFields(doc.data);
        const name = normalizeSkillName(fields.name || fallbackName);
        if (!name)
            return null;
        const marker = kind === "builtin" ? {} : readMarker(dir);
        const files = walkFiles(dir, 400);
        return {
            name,
            path: dir,
            source: kind === "builtin" ? "builtin" : "workspace",
            description: fields.description || firstParagraph(doc.body),
            origin_kind: marker.origin_kind === "third_party" ? "third_party" : kind,
            category: fields.category || category,
            tags: fields.tags,
            version: fields.version,
            author: fields.author,
            registry_name: marker.registry_name,
            registry_url: marker.registry_url,
            installed_version: marker.installed_version,
            installed_at: marker.installed_at,
            deletable: kind !== "builtin",
            scripts: files.filter((file) => SCRIPT_EXTENSIONS.has(path.extname(file).toLowerCase())),
        };
    }
    scanBundled() {
        const root = this.options.bundledRoot;
        const records = new Map();
        const disabled = new Set();
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(root, "deth_skills.json"), "utf8"));
            for (const id of raw.uninstalled_skills ?? [])
                disabled.add(id);
        }
        catch {
            /* optional file */
        }
        const visit = (dir, depth, segments) => {
            if (depth > 3)
                return;
            let entries;
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            }
            catch {
                return;
            }
            entries.sort((a, b) => a.name.localeCompare(b.name));
            if (segments.length > 0 &&
                entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
                const id = segments.join("/");
                if (!disabled.has(id)) {
                    const record = this.recordFromDir(dir, segments[segments.length - 1], "builtin", segments.length > 1 ? segments[0] : undefined);
                    if (record && !records.has(record.name))
                        records.set(record.name, record);
                }
                return;
            }
            for (const entry of entries) {
                if (entry.isDirectory() &&
                    !entry.name.startsWith(".") &&
                    !SKIP_DIRS.has(entry.name))
                    visit(path.join(dir, entry.name), depth + 1, [
                        ...segments,
                        entry.name,
                    ]);
            }
        };
        visit(root, 0, []);
        return [...records.values()];
    }
    bundled() {
        const stamp = this.now();
        if (!this.bundledCache || stamp - this.bundledCache.at > 60_000)
            this.bundledCache = { at: stamp, records: this.scanBundled() };
        return this.bundledCache.records;
    }
    scanUser() {
        const records = [];
        let entries = [];
        try {
            entries = fs.readdirSync(this.options.userDir, { withFileTypes: true });
        }
        catch {
            return records;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith("."))
                continue;
            const record = this.recordFromDir(path.join(this.options.userDir, entry.name), entry.name, "manual");
            if (record)
                records.push(record);
        }
        return records;
    }
    /** Every available skill. User skills win over extras; bundled skills can never be shadowed. */
    async list() {
        const merged = new Map();
        for (const record of this.bundled())
            merged.set(record.name, record);
        for (const record of this.scanUser())
            if (!merged.has(record.name))
                merged.set(record.name, record);
        if (this.options.extraSkills) {
            try {
                for (const record of await this.options.extraSkills())
                    if (!merged.has(record.name))
                        merged.set(record.name, record);
            }
            catch {
                /* the installer registry is optional */
            }
        }
        return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    async has(name) {
        return (await this.find(name)) !== null;
    }
    async find(name) {
        const wanted = normalizeSkillName(name);
        if (!wanted)
            return null;
        return (await this.list()).find((record) => record.name === wanted) ?? null;
    }
    async get(name) {
        const record = await this.find(name);
        if (!record)
            return null;
        let content = "";
        try {
            content = fs.readFileSync(path.join(record.path, "SKILL.md"), "utf8");
        }
        catch {
            /* extra records may have no SKILL.md */
        }
        return { ...record, content, files: walkFiles(record.path) };
    }
    /** Read one text file inside a skill folder. The path may not leave the folder. */
    async readFile(name, relative, maxBytes = 256 * 1024) {
        const record = await this.find(name);
        if (!record)
            throw new SkillStoreError(404, "Skill not found", "not_found");
        const root = fs.realpathSync(record.path);
        const target = path.resolve(root, relative);
        if (!insideDir(root, target))
            throw new SkillStoreError(403, "Path is outside the skill folder.", "outside_skill");
        let stat;
        try {
            stat = fs.lstatSync(target);
        }
        catch {
            throw new SkillStoreError(404, "File not found in this skill.", "not_found");
        }
        if (stat.isSymbolicLink() || !stat.isFile())
            throw new SkillStoreError(400, "Only regular files can be read.", "not_a_file");
        if (!insideDir(root, fs.realpathSync(target)))
            throw new SkillStoreError(403, "Path is outside the skill folder.", "outside_skill");
        const handle = fs.openSync(target, "r");
        try {
            const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
            fs.readSync(handle, buffer, 0, buffer.length, 0);
            if (buffer.subarray(0, 4096).includes(0))
                throw new SkillStoreError(415, "Binary files cannot be read as text.", "binary_file");
            return {
                path: path.relative(root, target).split(path.sep).join("/"),
                content: buffer.toString("utf8"),
                truncated: stat.size > maxBytes,
            };
        }
        finally {
            fs.closeSync(handle);
        }
    }
    /** Keyword search over installed skills, best match first. */
    async search(query, limit = 20) {
        const words = query
            .toLowerCase()
            .split(/[^\p{L}\p{N}]+/u)
            .filter((word) => word.length > 1);
        const all = await this.list();
        if (!words.length)
            return all.slice(0, limit).map((record) => ({ ...record, score: 0 }));
        const scored = [];
        for (const record of all) {
            let score = 0;
            const name = record.name.toLowerCase();
            const description = record.description.toLowerCase();
            const tags = record.tags.map((tag) => tag.toLowerCase());
            for (const word of words) {
                if (name.includes(word))
                    score += 3;
                if (tags.some((tag) => tag.includes(word)))
                    score += 2;
                if (description.includes(word) ||
                    (record.category ?? "").toLowerCase().includes(word))
                    score += 1;
            }
            if (score > 0)
                scored.push({ ...record, score });
        }
        return scored
            .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
            .slice(0, limit);
    }
    // ---- install / import ---------------------------------------------------
    /** Install one or more skills from in-memory files (paths relative to the archive root). */
    async installFiles(files, meta, options = {}) {
        if (files.length > MAX_FILES)
            throw new SkillStoreError(413, `A skill package may have at most ${MAX_FILES} files.`, "too_many_files");
        const total = files.reduce((sum, file) => sum + file.data.length, 0);
        if (total > MAX_TOTAL_BYTES)
            throw new SkillStoreError(413, "Skill package is larger than 50 MB.", "too_large");
        if (files.some((file) => file.data.length > MAX_FILE_BYTES))
            throw new SkillStoreError(413, "A file in the package is larger than 10 MB.", "too_large");
        const roots = this.findRoots(files);
        if (!roots.length)
            throw new SkillStoreError(400, "No SKILL.md found in the package.", "no_skill_md");
        const prepared = roots.map((root) => this.prepare(root, files, options.nameHint, roots.length === 1));
        const names = prepared.map((item) => item.name);
        if (new Set(names).size !== names.length)
            throw new SkillStoreError(400, "The package contains two skills with the same name.", "duplicate_name");
        const bundled = new Set(this.bundled().map((record) => record.name));
        const existing = new Set(this.scanUser().map((record) => record.name));
        for (const item of prepared) {
            if (bundled.has(item.name))
                throw new SkillStoreError(409, `"${item.name}" is a built-in skill and cannot be replaced.`, "builtin_conflict");
            if (existing.has(item.name) && !options.force)
                throw new SkillStoreError(409, `Skill "${item.name}" is already installed. Use force to replace it.`, "already_installed");
        }
        const findings = prepared.flatMap((item) => scanSkillFiles(item.files.map((file) => ({
            path: `${item.name}/${file.path}`,
            data: file.data,
        }))));
        const suspicious = findings.length > 0;
        if (suspicious && !options.force)
            throw new SkillStoreError(409, `Install blocked: ${summarizeFindings(findings)} Review the skill and retry with force to install anyway.`, "suspicious", { findings, is_suspicious: true });
        fs.mkdirSync(this.options.userDir, { recursive: true });
        const stamp = this.now();
        const replaced = [];
        const warnings = prepared.flatMap((item) => item.warnings);
        for (const item of prepared) {
            const finalDir = path.join(this.options.userDir, item.name);
            if (!insideDir(this.options.userDir, finalDir))
                throw new SkillStoreError(400, "Invalid skill name.", "invalid_name");
            const staging = path.join(this.options.userDir, `.tmp-${randomUUID()}`);
            try {
                for (const file of item.files) {
                    const target = path.join(staging, ...file.path.split("/"));
                    if (!insideDir(staging, target))
                        throw new SkillStoreError(400, "Package contains an unsafe path.", "unsafe_path");
                    fs.mkdirSync(path.dirname(target), { recursive: true });
                    fs.writeFileSync(target, file.data, { mode: 0o644 });
                }
                const marker = {
                    origin_kind: meta.origin,
                    registry_name: meta.registry_name,
                    registry_url: meta.registry_url,
                    installed_version: meta.installed_version ?? item.version,
                    installed_at: stamp,
                    source: meta.source,
                    ...(suspicious ? { suspicious: true } : {}),
                };
                fs.writeFileSync(path.join(staging, MARKER), JSON.stringify(marker, null, 2), { mode: 0o644 });
                if (fs.existsSync(finalDir)) {
                    const backup = path.join(this.options.userDir, `.old-${randomUUID()}`);
                    fs.renameSync(finalDir, backup);
                    try {
                        fs.renameSync(staging, finalDir);
                    }
                    catch (error) {
                        fs.renameSync(backup, finalDir);
                        throw error;
                    }
                    fs.rmSync(backup, { recursive: true, force: true });
                    replaced.push(item.name);
                }
                else
                    fs.renameSync(staging, finalDir);
            }
            finally {
                fs.rmSync(staging, { recursive: true, force: true });
            }
        }
        const skills = [];
        for (const item of prepared) {
            const record = this.recordFromDir(path.join(this.options.userDir, item.name), item.name, "manual");
            if (record)
                skills.push(record);
        }
        return { skills, replaced, warnings, is_suspicious: suspicious, findings };
    }
    /** Outermost folders that contain a SKILL.md ("" means the archive root). */
    findRoots(files) {
        const candidates = files
            .map((file) => file.path)
            .filter((p) => p === "SKILL.md" || p.endsWith("/SKILL.md"))
            .map((p) => (p === "SKILL.md" ? "" : p.slice(0, -"/SKILL.md".length)));
        return candidates
            .filter((root) => !candidates.some((other) => other !== root && (other === "" || root.startsWith(`${other}/`))))
            .sort();
    }
    prepare(root, files, nameHint, single) {
        const prefix = root ? `${root}/` : "";
        const own = files
            .filter((file) => (root ? file.path.startsWith(prefix) : true))
            .map((file) => ({
            path: file.path.slice(prefix.length),
            data: file.data,
        }))
            .filter((file) => file.path !== MARKER &&
            !file.path
                .split("/")
                .some((part) => SKIP_DIRS.has(part) && part !== "dist"));
        const skillMd = own.find((file) => file.path === "SKILL.md");
        if (!skillMd)
            throw new SkillStoreError(400, "SKILL.md is missing.", "no_skill_md");
        const doc = parseSkillMarkdown(skillMd.data.toString("utf8"));
        if (doc.error)
            throw new SkillStoreError(400, `SKILL.md frontmatter is invalid: ${doc.error}`, "invalid_frontmatter");
        const fields = readFrontmatterFields(doc.data);
        const folder = root ? root.split("/").pop() : undefined;
        const name = normalizeSkillName(fields.name || folder || (single ? nameHint : undefined) || "");
        const validity = validateSkillName(name);
        if (!validity.valid)
            throw new SkillStoreError(400, `${validity.error ?? "Invalid skill name"}. Add a "name:" to the SKILL.md frontmatter.`, "invalid_name");
        const warnings = [];
        if (!fields.description)
            warnings.push(`"${name}" has no description in its frontmatter, so the agent may never pick it automatically.`);
        return { name, version: fields.version, files: own, warnings };
    }
    /** Unpack a ZIP or tar.gz into memory without installing it (used to pick a sub-folder). */
    async extractForSelection(data) {
        if (isZip(data)) {
            try {
                return readZip(data);
            }
            catch (error) {
                if (error instanceof ZipError)
                    throw new SkillStoreError(400, error.message, "bad_archive");
                throw error;
            }
        }
        if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b)
            return this.readTarGz(data);
        throw new SkillStoreError(415, "Unsupported archive. Use .zip or .tar.gz.", "unsupported_type");
    }
    /** Install from raw bytes: ZIP, tar.gz or a single SKILL.md. */
    async importBuffer(data, filename, meta, options = {}) {
        if (!data.length)
            throw new SkillStoreError(400, "The file is empty.", "empty_file");
        const base = path
            .basename(filename)
            .replace(/\.(zip|tar\.gz|tgz|md)$/i, "");
        let files;
        if (isZip(data)) {
            try {
                files = readZip(data);
            }
            catch (error) {
                if (error instanceof ZipError)
                    throw new SkillStoreError(400, error.message, "bad_archive");
                throw error;
            }
        }
        else if (data.length > 2 && data[0] === 0x1f && data[1] === 0x8b) {
            files = await this.readTarGz(data);
        }
        else {
            const text = data.toString("utf8");
            if (data.subarray(0, 4096).includes(0) || !text.trim())
                throw new SkillStoreError(415, "Unsupported file. Upload a .zip, .tar.gz or SKILL.md file.", "unsupported_type");
            files = [{ path: "SKILL.md", data }];
        }
        return this.installFiles(files, meta, {
            force: options.force,
            nameHint: base,
        });
    }
    async readTarGz(data) {
        const work = fs.mkdtempSync(path.join(os.tmpdir(), "miki-skill-"));
        try {
            const archive = path.join(work, "skill.tgz");
            const out = path.join(work, "out");
            fs.writeFileSync(archive, data);
            try {
                await extractTarGz(archive, out, {
                    stripComponents: 0,
                    maxEntries: MAX_FILES,
                    maxExtractedBytes: MAX_TOTAL_BYTES,
                });
            }
            catch (error) {
                throw new SkillStoreError(400, `Could not extract archive: ${error instanceof Error ? error.message : String(error)}`, "bad_archive");
            }
            const files = [];
            for (const rel of walkFiles(out, MAX_FILES + 1)) {
                const absolute = path.join(out, ...rel.split("/"));
                if (fs.lstatSync(absolute).isSymbolicLink())
                    continue;
                files.push({ path: rel, data: fs.readFileSync(absolute) });
            }
            return files;
        }
        finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    }
    // ---- removal ------------------------------------------------------------
    async remove(name) {
        const wanted = normalizeSkillName(name);
        const record = await this.find(wanted);
        if (!record)
            throw new SkillStoreError(404, "Skill not found", "not_found");
        if (record.source === "builtin")
            throw new SkillStoreError(403, "Built-in skills cannot be deleted.", "builtin_protected");
        const dir = path.resolve(this.options.userDir, record.name);
        if (insideDir(this.options.userDir, dir) &&
            dir !== path.resolve(this.options.userDir) &&
            fs.existsSync(dir)) {
            fs.rmSync(dir, { recursive: true, force: true });
            return { name: record.name };
        }
        if (this.options.removeExtra &&
            (await this.options.removeExtra(record.name)))
            return { name: record.name };
        throw new SkillStoreError(404, "Skill could not be removed.", "not_removable");
    }
}
