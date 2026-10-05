import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { isSandboxModeEnabled, readMikiEnv } from "@miki/config";
const Miki_NS = "Miki";
function osConfigRoot() {
    if (process.env["XDG_CONFIG_HOME"])
        return path.resolve(process.env["XDG_CONFIG_HOME"]);
    if (process.platform === "win32" && process.env["APPDATA"])
        return path.resolve(process.env["APPDATA"]);
    return path.join(os.homedir(), ".config");
}
function osDataRoot() {
    if (process.env["XDG_DATA_HOME"])
        return path.resolve(process.env["XDG_DATA_HOME"]);
    if (process.platform === "win32" && process.env["LOCALAPPDATA"])
        return path.resolve(process.env["LOCALAPPDATA"]);
    return path.join(os.homedir(), ".local", "share");
}
function osCacheRoot() {
    if (process.env["XDG_CACHE_HOME"])
        return path.resolve(process.env["XDG_CACHE_HOME"]);
    if (process.platform === "win32" && process.env["LOCALAPPDATA"])
        return path.resolve(process.env["LOCALAPPDATA"], "cache");
    return path.join(os.homedir(), ".cache");
}
function resolveLegacyDir() {
    const envDir = readMikiEnv("MIKI_WORKSPACE_DIR");
    if (envDir)
        return path.resolve(envDir);
    const runtimeRoot = readMikiEnv("MIKI_RUNTIME_ROOT");
    if (runtimeRoot)
        return path.resolve(runtimeRoot);
    return null;
}
function migrationNeeded(legacyDir, configDir) {
    const oldConfig = path.join(legacyDir, "config", "agent.yaml");
    const newConfig = path.join(configDir, "agent.yaml");
    return fs.existsSync(oldConfig) && !fs.existsSync(newConfig);
}
function migrateDirectory(source, dest) {
    if (!fs.existsSync(source))
        return;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
        fs.cpSync(source, dest, { recursive: true, force: false });
    }
    catch {
        console.warn(`[paths] Could not migrate ${source} -> ${dest}`);
    }
}
export function normalizeRuntimePaths(paths) {
    if (!paths)
        return resolveRuntimePaths();
    if (typeof paths === "string") {
        const sourceDir = path.resolve(paths);
        const dataDir = path.join(sourceDir, "data");
        return {
            configDir: path.join(sourceDir, "config"),
            dataDir,
            // User/agent-created skills stay under data/, never under source src/skills
            // or a repo-root skills/ tree. Bundled catalog is packages/skills/src only.
            skillsDir: path.join(dataDir, "skills"),
            cacheDir: path.join(dataDir, "cache"),
            binDir: path.join(sourceDir, "bin"),
            docsDir: path.join(sourceDir, "docs"),
            outputDir: path.join(sourceDir, "output"),
            identityDir: path.join(sourceDir, "identity"),
            sourceDir,
        };
    }
    const sourceDir = path.resolve(paths.sourceDir ?? paths.configDir ?? paths.dataDir ?? process.cwd());
    const configDir = paths.configDir ?? path.join(sourceDir, "config");
    const dataDir = paths.dataDir ?? path.join(sourceDir, "data");
    const skillsDir = paths.skillsDir ?? path.join(dataDir, "skills");
    const cacheDir = paths.cacheDir ?? path.join(dataDir, "cache");
    const binDir = paths.binDir ?? path.join(sourceDir, "bin");
    const docsDir = paths.docsDir ?? path.join(sourceDir, "docs");
    const outputDir = paths.outputDir ?? path.join(sourceDir, "output");
    const identityDir = paths.identityDir ?? path.join(sourceDir, "identity");
    return {
        configDir,
        dataDir,
        skillsDir,
        cacheDir,
        binDir,
        docsDir,
        outputDir,
        identityDir,
        sourceDir: paths.sourceDir ? path.resolve(paths.sourceDir) : sourceDir,
    };
}
/**
 * Where downloaded/installed skills should actually be written.
 *
 * With security.sandbox_mode: true in agent.yaml (the default), this is
 * always <dataDir>/downloaded-skills — a location fully isolated from the
 * agent's own source/workspace tree and from the bundled skill catalog
 * (packages/skills/src), even when RuntimePaths was constructed from a raw
 * workspace path (dev mode). User skillsDir is always under dataDir/skills
 * (or MIKI_RUNTIME_ROOT/skills), never under the source tree.
 *
 * This exists specifically so that cleaning up or resetting the workspace
 * can never accidentally delete a skill fetched from the internet that the
 * agent still needs — full system access elsewhere is unaffected; this
 * only isolates internet-sourced content.
 *
 * With sandbox_mode: false, falls back to the legacy runtimePaths.skillsDir
 * for backward compatibility with existing setups that rely on that path.
 */
export function resolveDownloadedSkillsDir(runtimePaths, workspaceDir) {
    const wd = workspaceDir ?? runtimePaths.sourceDir;
    if (isSandboxModeEnabled(wd)) {
        return path.join(runtimePaths.dataDir, "downloaded-skills");
    }
    return runtimePaths.skillsDir;
}
export function resolveRuntimePaths() {
    const legacyDir = resolveLegacyDir();
    // An explicit runtime root is an isolation boundary for supervised, test,
    // and multi-instance deployments. Do not silently fall back to the shared
    // OS-level Miki directories when the supervisor has selected a runtime.
    const explicitRuntimeRoot = readMikiEnv("MIKI_RUNTIME_ROOT");
    const runtimeRoot = explicitRuntimeRoot
        ? path.resolve(explicitRuntimeRoot)
        : undefined;
    const configDir = runtimeRoot
        ? path.join(runtimeRoot, "config")
        : path.join(osConfigRoot(), Miki_NS);
    const dataDir = runtimeRoot
        ? path.join(runtimeRoot, "data")
        : path.join(osDataRoot(), Miki_NS);
    const skillsDir = runtimeRoot
        ? path.join(runtimeRoot, "skills")
        : path.join(osDataRoot(), Miki_NS, "skills");
    const cacheDir = runtimeRoot
        ? path.join(runtimeRoot, "cache")
        : path.join(osCacheRoot(), Miki_NS);
    const binDir = runtimeRoot
        ? path.join(runtimeRoot, "bin")
        : path.join(osDataRoot(), Miki_NS, "bin");
    const docsDir = runtimeRoot
        ? path.join(runtimeRoot, "docs")
        : path.join(osDataRoot(), Miki_NS, "docs");
    const outputDir = runtimeRoot
        ? path.join(runtimeRoot, "output")
        : path.join(osDataRoot(), Miki_NS, "output");
    // identity/ (SOUL.md/AGENTS.md/IDENTITY.md/USER.md/TOOLS.md) is
    // human-authored and edited the same way config/agent.yaml is, so it
    // follows the config root, not the data root, in an OS-installed release.
    const identityDir = runtimeRoot
        ? path.join(runtimeRoot, "identity")
        : path.join(osConfigRoot(), Miki_NS, "identity");
    const sourceDir = legacyDir ?? process.cwd();
    const paths = {
        configDir,
        dataDir,
        skillsDir,
        cacheDir,
        binDir,
        docsDir,
        outputDir,
        identityDir,
        sourceDir,
    };
    if (legacyDir && migrationNeeded(legacyDir, configDir)) {
        migrateDirectory(path.join(legacyDir, "config"), configDir);
        migrateDirectory(path.join(legacyDir, "data"), dataDir);
        migrateDirectory(path.join(legacyDir, "docs"), docsDir);
        migrateDirectory(path.join(legacyDir, "output"), outputDir);
        migrateDirectory(path.join(legacyDir, "src", "skills"), skillsDir);
        migrateDirectory(path.join(legacyDir, "skills"), skillsDir);
        migrateDirectory(path.join(legacyDir, "identity"), identityDir);
    }
    for (const dir of Object.values(paths)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    return paths;
}
