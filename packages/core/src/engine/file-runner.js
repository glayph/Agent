import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isSensitivePath, resolveWorkspacePath } from "./workspace-paths.js";
import { errorMessage, redactSecrets } from "./util.js";
export class FileRunError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.name = "FileRunError";
        this.status = status;
        this.code = code;
    }
}
/**
 * Script types the runner understands. Native executables are intentionally
 * absent unless `allowNative` is set: running an arbitrary binary is a bigger
 * step than running a script through a known interpreter.
 */
const INTERPRETERS = {
    ".js": { commands: [process.execPath] },
    ".mjs": { commands: [process.execPath] },
    ".cjs": { commands: [process.execPath] },
    ".py": { commands: process.platform === "win32" ? ["python", "py"] : ["python3", "python"] },
    ".sh": { commands: ["bash", "sh"], platforms: ["linux", "darwin", "freebsd", "openbsd"] },
    ".ps1": {
        commands: ["pwsh", "powershell"],
        prefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"],
    },
    ".bat": { commands: ["cmd.exe"], prefix: ["/d", "/c"], platforms: ["win32"] },
    ".cmd": { commands: ["cmd.exe"], prefix: ["/d", "/c"], platforms: ["win32"] },
};
export function supportedRunExtensions(platform = process.platform) {
    return Object.entries(INTERPRETERS)
        .filter(([, value]) => !value.platforms || value.platforms.includes(platform))
        .map(([extension]) => extension);
}
/** Variables a script may inherit. Everything else (API keys, tokens...) is dropped. */
const ENV_ALLOWLIST = [
    "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "TMPDIR", "TEMP", "TMP",
    "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
];
export function buildRunEnvironment(source = process.env, extra = {}) {
    const env = {};
    for (const key of ENV_ALLOWLIST) {
        const value = source[key];
        if (typeof value === "string")
            env[key] = value;
    }
    return { ...env, ...extra, MIKI_FILE_RUN: "1" };
}
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024;
const MAX_SCRIPT_BYTES = 5 * 1024 * 1024;
const MAX_ARGS = 32;
const MAX_ARG_LENGTH = 2048;
const KILL_GRACE_MS = 2_000;
let activeRuns = 0;
const MAX_CONCURRENT_RUNS = Number(process.env.MIKI_FILE_RUN_MAX_CONCURRENT || 3);
export function activeFileRuns() {
    return activeRuns;
}
/** Throw if the file cannot be run; return everything needed to start it. */
export function prepareRun(options) {
    const root = path.resolve(options.root);
    const restrictToRoot = options.restrictToRoot !== false;
    let absFile;
    try {
        absFile = restrictToRoot
            ? resolveWorkspacePath(root, options.file)
            : path.isAbsolute(options.file)
                ? path.resolve(options.file)
                : path.resolve(root, options.file);
    }
    catch (error) {
        throw new FileRunError(403, "outside_workspace", errorMessage(error));
    }
    if (isSensitivePath(absFile))
        throw new FileRunError(403, "sensitive_file", "Credential and secret files cannot be executed.");
    let stat;
    try {
        stat = fs.lstatSync(absFile);
    }
    catch {
        throw new FileRunError(404, "not_found", "File does not exist.");
    }
    if (stat.isSymbolicLink())
        throw new FileRunError(400, "symlink", "Symbolic links cannot be executed.");
    if (!stat.isFile())
        throw new FileRunError(400, "not_a_file", "Only regular files can be run.");
    if (stat.size > MAX_SCRIPT_BYTES)
        throw new FileRunError(413, "too_large", "Script is larger than the 5 MB execution limit.");
    const args = options.args ?? [];
    if (args.length > MAX_ARGS || args.some((arg) => typeof arg !== "string" || arg.length > MAX_ARG_LENGTH || arg.includes("\0")))
        throw new FileRunError(400, "bad_arguments", `At most ${MAX_ARGS} string arguments of ${MAX_ARG_LENGTH} characters are allowed.`);
    let cwd = path.dirname(absFile);
    if (options.cwd) {
        try {
            cwd = restrictToRoot
                ? resolveWorkspacePath(root, options.cwd)
                : path.isAbsolute(options.cwd)
                    ? path.resolve(options.cwd)
                    : path.resolve(root, options.cwd);
        }
        catch (error) {
            throw new FileRunError(403, "outside_workspace", errorMessage(error));
        }
        if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
            throw new FileRunError(400, "bad_cwd", "Working directory is not a directory.");
    }
    const extension = path.extname(absFile).toLowerCase();
    const interpreter = INTERPRETERS[extension];
    if (interpreter && interpreter.platforms && !interpreter.platforms.includes(process.platform))
        throw new FileRunError(400, "unsupported_platform", `${extension} files cannot be run on ${process.platform}.`);
    if (interpreter) {
        return {
            absFile,
            cwd,
            args,
            candidates: interpreter.commands.map((command) => ({
                command,
                args: [...(interpreter.prefix ?? []), absFile, ...args],
            })),
        };
    }
    if (options.allowNative) {
        const executable = process.platform === "win32" ? extension === ".exe" : (stat.mode & 0o111) !== 0;
        if (executable)
            return { absFile, cwd, args, candidates: [{ command: absFile, args }] };
    }
    throw new FileRunError(400, "unsupported_type", `Cannot run "${extension || path.basename(absFile)}" files. Supported types: ${supportedRunExtensions().join(", ")}.`);
}
function killTree(child, signal) {
    if (!child.pid)
        return;
    try {
        if (process.platform === "win32")
            child.kill(signal);
        else
            process.kill(-child.pid, signal); // negative pid = the whole process group
    }
    catch {
        try {
            child.kill(signal);
        }
        catch {
            /* already exited */
        }
    }
}
function startProcess(candidate, cwd, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(candidate.command, candidate.args, {
            cwd,
            env,
            shell: false,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
        });
        child.once("error", reject);
        child.once("spawn", () => {
            child.removeListener("error", reject);
            resolve(child);
        });
    });
}
/** Run a workspace script and capture its output. Never goes through a shell. */
export async function runWorkspaceFile(options) {
    const prepared = prepareRun(options);
    if (activeRuns >= MAX_CONCURRENT_RUNS)
        throw new FileRunError(429, "busy", `Too many scripts are running (limit ${MAX_CONCURRENT_RUNS}). Try again shortly.`);
    if (options.signal?.aborted)
        throw new FileRunError(499, "cancelled", "The run was cancelled before it started.");
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(100, options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
    const cap = Math.max(1024, options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT);
    const env = buildRunEnvironment(process.env, options.env);
    const home = env.HOME || os.homedir();
    if (!env.HOME && home)
        env.HOME = home;
    activeRuns += 1;
    const started = Date.now();
    try {
        let child;
        let used;
        let lastError;
        for (const candidate of prepared.candidates) {
            try {
                child = await startProcess(candidate, prepared.cwd, env);
                used = candidate;
                break;
            }
            catch (error) {
                lastError = error;
                if (error.code !== "ENOENT")
                    break;
            }
        }
        if (!child || !used) {
            const names = prepared.candidates.map((c) => c.command).join(" / ");
            throw new FileRunError(501, "interpreter_missing", `Could not start the interpreter (${names}): ${errorMessage(lastError)}.`);
        }
        const running = child;
        const chunks = { stdout: [], stderr: [] };
        const sizes = { stdout: 0, stderr: 0 };
        const truncated = { stdout: false, stderr: false };
        let outcome;
        let killTimer;
        const stop = (reason) => {
            if (outcome)
                return;
            outcome = reason;
            killTree(running, "SIGTERM");
            killTimer = setTimeout(() => killTree(running, "SIGKILL"), KILL_GRACE_MS);
        };
        const collect = (stream) => (data) => {
            if (sizes[stream] >= cap) {
                truncated[stream] = true;
                // A script that floods output is stopped instead of being drained forever.
                if (sizes.stdout + sizes.stderr > cap * 8)
                    stop("output_limit");
                return;
            }
            const room = cap - sizes[stream];
            const piece = data.length > room ? data.subarray(0, room) : data;
            if (data.length > room)
                truncated[stream] = true;
            chunks[stream].push(piece);
            sizes[stream] += piece.length;
        };
        running.stdout?.on("data", collect("stdout"));
        running.stderr?.on("data", collect("stderr"));
        const timeout = setTimeout(() => stop("timeout"), timeoutMs);
        const onAbort = () => stop("cancelled");
        options.signal?.addEventListener("abort", onAbort, { once: true });
        const exit = await new Promise((resolve) => {
            running.once("error", () => resolve({ code: null, signal: null }));
            running.once("close", (code, signal) => resolve({ code, signal }));
        });
        clearTimeout(timeout);
        if (killTimer)
            clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", onAbort);
        // Anything the script left running in its process group goes with it.
        killTree(running, "SIGKILL");
        const text = (stream) => redactSecrets(Buffer.concat(chunks[stream]).toString("utf8"));
        return {
            status: outcome ?? (exit.code === 0 ? "ok" : "failed"),
            exitCode: exit.code,
            signal: exit.signal,
            stdout: text("stdout"),
            stderr: text("stderr"),
            stdoutTruncated: truncated.stdout,
            stderrTruncated: truncated.stderr,
            durationMs: Date.now() - started,
            command: [path.basename(used.command), ...used.args.map((arg) => (arg === prepared.absFile ? path.relative(path.resolve(options.root), arg) || arg : arg))].join(" "),
            file: path.relative(path.resolve(options.root), prepared.absFile),
        };
    }
    finally {
        activeRuns -= 1;
    }
}
/** One-line description of a finished run, used for HTTP errors and audit logs. */
export function summarizeRun(result) {
    const tail = (text) => text.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]?.slice(0, 240) ?? "";
    switch (result.status) {
        case "ok":
            return `Finished with exit code 0 in ${result.durationMs} ms.`;
        case "timeout":
            return `Stopped: the script ran longer than its time limit (${result.durationMs} ms).`;
        case "cancelled":
            return "Stopped: the run was cancelled.";
        case "output_limit":
            return "Stopped: the script produced too much output.";
        default: {
            const detail = tail(result.stderr) || tail(result.stdout);
            return `Exited with code ${result.exitCode ?? "unknown"}${result.signal ? ` (signal ${result.signal})` : ""}${detail ? `: ${detail}` : "."}`;
        }
    }
}
