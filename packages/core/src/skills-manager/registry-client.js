import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { downloadFile, downloadJson } from "@miki/installer";
import { normalizeSkillName } from "../skill-utils.js";
import { SkillStoreError, } from "./skill-store.js";
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._@/-]{0,127}$/;
const GITHUB_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_./-]+)?$/;
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function text(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
/** Parse registries from `name=url` pairs or a JSON array, as used by MIKI_SKILL_REGISTRIES. */
export function parseRegistryList(raw) {
    let items = [];
    if (Array.isArray(raw))
        items = raw;
    else if (typeof raw === "string" && raw.trim()) {
        const value = raw.trim();
        if (value.startsWith("[")) {
            try {
                const parsed = JSON.parse(value);
                if (Array.isArray(parsed))
                    items = parsed;
            }
            catch {
                items = [];
            }
        }
        else
            items = value.split(",").map((part) => {
                const [name, ...rest] = part.split("=");
                return rest.length
                    ? { name: name.trim(), url: rest.join("=").trim() }
                    : { url: part.trim() };
            });
    }
    const out = [];
    for (const item of items) {
        const entry = record(item);
        const url = text(entry?.url)?.replace(/\/+$/, "");
        if (!url)
            continue;
        let name = text(entry?.name);
        if (!name) {
            try {
                name = new URL(url).hostname;
            }
            catch {
                continue;
            }
        }
        if (!out.some((existing) => existing.name === name))
            out.push({ name, url });
    }
    return out;
}
function isPrivateHost(hostname) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".internal"))
        return true;
    if (host === "::1" ||
        host.startsWith("fc") ||
        host.startsWith("fd") ||
        host.startsWith("fe80"))
        return true;
    const parts = host.split(".").map(Number);
    if (parts.length === 4 &&
        parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
        const [a, b] = parts;
        return (a === 10 ||
            a === 127 ||
            a === 0 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168));
    }
    return false;
}
/** Turn a github.com page URL into a codeload tarball URL plus an optional sub-folder filter. */
export function resolveGithubSource(input, codeloadBase = "https://codeload.github.com") {
    let parsed;
    try {
        parsed = new URL(input);
    }
    catch {
        return null;
    }
    if (parsed.hostname !== "github.com")
        return null;
    const [owner, repoRaw, kind, ref, ...rest] = parsed.pathname
        .split("/")
        .filter(Boolean);
    const repo = repoRaw?.replace(/\.git$/, "");
    if (!owner || !repo)
        return null;
    const branch = kind === "tree" && ref ? ref : "HEAD";
    return {
        url: `${codeloadBase.replace(/\/+$/, "")}/${owner}/${repo}/tar.gz/${branch === "HEAD" ? "HEAD" : `refs/heads/${branch}`}`,
        subpath: kind === "tree" && rest.length ? rest.join("/") : undefined,
    };
}
export class SkillRegistryClient {
    options;
    constructor(options) {
        this.options = options;
    }
    insecure() {
        return this.options.allowInsecure?.() ?? false;
    }
    assertAllowedUrl(raw, label) {
        let url;
        try {
            url = new URL(raw);
        }
        catch {
            throw new SkillStoreError(400, `${label} is not a valid URL.`, "bad_url");
        }
        if (url.protocol !== "https:" &&
            !(url.protocol === "http:" && this.insecure()))
            throw new SkillStoreError(400, `${label} must use https.`, "insecure_url");
        if (isPrivateHost(url.hostname) && !this.insecure())
            throw new SkillStoreError(400, `${label} points to a local or private address.`, "private_url");
        return url;
    }
    mapResult(item, registry, installedNames) {
        const slug = text(item.slug) ?? text(item.name) ?? text(item.id);
        if (!slug)
            return null;
        const normalised = normalizeSkillName(slug.split("/").pop() ?? slug);
        return {
            score: typeof item.score === "number" ? item.score : 0,
            slug,
            id: text(item.id),
            display_name: text(item.display_name) ??
                text(item.displayName) ??
                text(item.title) ??
                text(item.name) ??
                slug,
            summary: text(item.summary) ?? text(item.description) ?? "",
            version: text(item.version) ?? text(item.latest_version) ?? "",
            registry_name: registry.name,
            url: text(item.downloadUrl) ?? text(item.download_url) ?? text(item.url),
            installed: installedNames.has(normalised),
            installed_name: installedNames.has(normalised) ? normalised : undefined,
        };
    }
    async search(query, limit = 20, offset = 0) {
        const registries = this.options.registries();
        const safeLimit = Math.min(Math.max(1, Math.floor(limit) || 20), 50);
        const safeOffset = Math.max(0, Math.floor(offset) || 0);
        const warnings = [];
        if (!registries.length)
            return {
                results: [],
                limit: safeLimit,
                offset: safeOffset,
                has_more: false,
                registries_configured: 0,
                warnings: [
                    "No skill registry is configured. Set MIKI_SKILL_REGISTRIES or install from a URL.",
                ],
            };
        const installed = new Set((await this.options.store.list()).map((skill) => skill.name));
        const settled = await Promise.allSettled(registries.map(async (registry) => {
            this.assertAllowedUrl(registry.url, `Registry "${registry.name}"`);
            const params = new URLSearchParams({
                q: query,
                limit: String(safeLimit),
                offset: String(safeOffset),
            });
            const body = await downloadJson(`${registry.url}/search?${params.toString()}`, {
                headers: { Accept: "application/json" },
                allowHttp: this.insecure(),
                timeout: 15_000,
            });
            const root = record(body);
            const items = Array.isArray(body)
                ? body
                : (root?.results ?? root?.skills ?? root?.packages ?? root?.data);
            const list = Array.isArray(items) ? items : [];
            return {
                registry,
                count: list.length,
                results: list
                    .map((item) => record(item))
                    .filter((item) => Boolean(item))
                    .map((item) => this.mapResult(item, registry, installed))
                    .filter((item) => Boolean(item)),
            };
        }));
        const results = [];
        let hasMore = false;
        settled.forEach((outcome, index) => {
            if (outcome.status === "fulfilled") {
                results.push(...outcome.value.results);
                if (outcome.value.count >= safeLimit)
                    hasMore = true;
            }
            else
                warnings.push(`${registries[index].name}: ${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}`);
        });
        if (settled.every((outcome) => outcome.status === "rejected"))
            throw new SkillStoreError(502, `Skill registry search failed. ${warnings.join(" ")}`, "registry_unreachable");
        results.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
        return {
            results,
            limit: safeLimit,
            offset: safeOffset,
            ...(hasMore ? { next_offset: safeOffset + safeLimit } : {}),
            has_more: hasMore,
            registries_configured: registries.length,
            warnings,
        };
    }
    /** Work out which archive to download for an install request. */
    async resolveSource(request) {
        const slug = request.slug?.trim() ?? "";
        const registryName = request.registry?.trim() || "";
        if (request.url) {
            const github = resolveGithubSource(request.url, this.options.githubCodeloadUrl);
            const target = github?.url ?? request.url;
            this.assertAllowedUrl(target, "Skill URL");
            return {
                url: target,
                registry: registryName || (github ? "github" : "url"),
                version: request.version ?? "",
                subpath: github?.subpath,
                slug: slug || path.basename(new URL(request.url).pathname) || "skill",
            };
        }
        if (!slug || !SLUG.test(slug) || slug.includes(".."))
            throw new SkillStoreError(400, "A valid skill slug or url is required.", "bad_request");
        if (registryName === "github") {
            if (!GITHUB_SLUG.test(slug))
                throw new SkillStoreError(400, 'GitHub skills use the form "owner/repo" or "owner/repo/path".', "bad_request");
            const [owner, repo, ...rest] = slug.split("/");
            const source = resolveGithubSource(`https://github.com/${owner}/${repo}${rest.length ? `/tree/${request.version || "main"}/${rest.join("/")}` : ""}`, this.options.githubCodeloadUrl);
            if (!source)
                throw new SkillStoreError(400, "Invalid GitHub source.", "bad_request");
            return {
                url: source.url,
                registry: "github",
                version: request.version ?? "",
                subpath: source.subpath,
                slug,
            };
        }
        const registries = this.options.registries();
        const registry = registries.find((item) => item.name === registryName) ??
            (!registryName && registries.length === 1 ? registries[0] : undefined);
        if (!registry)
            throw new SkillStoreError(400, registryName
                ? `Unknown skill registry "${registryName}".`
                : "Specify a registry, or provide a url.", "unknown_registry");
        this.assertAllowedUrl(registry.url, `Registry "${registry.name}"`);
        const query = request.version
            ? `?version=${encodeURIComponent(request.version)}`
            : "";
        const info = record(await downloadJson(`${registry.url}/skills/${slug.split("/").map(encodeURIComponent).join("/")}${query}`, {
            headers: { Accept: "application/json" },
            allowHttp: this.insecure(),
            timeout: 15_000,
        }));
        const download = text(info?.downloadUrl) ?? text(info?.download_url) ?? text(info?.url);
        if (!download)
            throw new SkillStoreError(502, `Registry "${registry.name}" returned no download URL for "${slug}".`, "registry_invalid");
        this.assertAllowedUrl(download, "Registry download URL");
        return {
            url: download,
            registry: registry.name,
            registryUrl: registry.url,
            version: text(info?.version) ?? request.version ?? "",
            summary: text(info?.summary) ?? text(info?.description),
            slug,
        };
    }
    async install(request) {
        const source = await this.resolveSource(request);
        const work = fs.mkdtempSync(path.join(os.tmpdir(), `miki-skill-${randomUUID()}-`));
        try {
            const archive = path.join(work, "download");
            try {
                await downloadFile(source.url, archive, {
                    allowHttp: this.insecure(),
                    maxBytes: this.options.maxArchiveBytes ?? 50 * 1024 * 1024,
                    headers: { Accept: "application/octet-stream" },
                    timeout: 60_000,
                }, 2);
            }
            catch (error) {
                throw new SkillStoreError(502, `Download failed: ${error instanceof Error ? error.message : String(error)}`, "download_failed");
            }
            const data = fs.readFileSync(archive);
            const filename = path.basename(new URL(source.url).pathname) || source.slug;
            const meta = {
                origin: "third_party",
                registry_name: source.registry,
                registry_url: source.registryUrl,
                installed_version: source.version || undefined,
                source: source.url,
            };
            const outcome = source.subpath
                ? await this.installSubpath(data, filename, source.subpath, meta, request.force)
                : await this.options.store.importBuffer(data, filename, meta, {
                    force: request.force,
                });
            const first = outcome.skills[0];
            return {
                status: outcome.replaced.length ? "updated" : "installed",
                slug: source.slug,
                registry: source.registry,
                version: source.version || first?.version || "",
                summary: source.summary ?? first?.description,
                is_suspicious: outcome.is_suspicious,
                outcome,
            };
        }
        finally {
            fs.rmSync(work, { recursive: true, force: true });
        }
    }
    /** GitHub tarballs wrap everything in "<repo>-<ref>/"; keep only the requested sub-folder. */
    async installSubpath(data, filename, subpath, meta, force) {
        const store = this.options.store;
        const wanted = subpath.replace(/^\/+|\/+$/g, "");
        const staged = await store.extractForSelection(data);
        const scoped = staged.flatMap((file) => {
            const parts = file.path.split("/");
            const inner = parts.slice(1).join("/");
            return inner === wanted || inner.startsWith(`${wanted}/`)
                ? [
                    {
                        path: file.path
                            .slice(parts[0].length + 1 + wanted.length)
                            .replace(/^\//, "") || "SKILL.md",
                        data: file.data,
                    },
                ]
                : [];
        });
        if (!scoped.length)
            throw new SkillStoreError(404, `Folder "${wanted}" was not found in ${filename}.`, "subpath_not_found");
        return store.installFiles(scoped, meta, {
            force,
            nameHint: wanted.split("/").pop(),
        });
    }
}
