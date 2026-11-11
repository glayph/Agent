import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildIdentityContext } from "./identity-prompt.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "miki-identity-prompt-"));
}

describe("identity prompt", () => {
  it("loads SOUL and adaptive AGENTS preferences and refreshes its cache after edits", () => {
    const dir = tempDir();
    const input = { groups: [{ key: "filesystem", enabled: true }], identityDirs: [dir] };
    try {
      fs.writeFileSync(path.join(dir, "SOUL.md"), "stable core identity");
      fs.writeFileSync(path.join(dir, "AGENTS.md"), "adaptive execution preferences");
      expect(buildIdentityContext(input)).toContain("stable core identity");
      expect(buildIdentityContext(input)).toContain("adaptive execution preferences");
      expect(buildIdentityContext(input)).toContain("BINDING operating instructions from the owner");
      expect(buildIdentityContext(input)).not.toContain("ignore or adjust preferences that do not fit");

      fs.writeFileSync(path.join(dir, "AGENTS.md"), "updated adaptive preferences with a changed signature");
      expect(buildIdentityContext(input)).toContain("updated adaptive preferences with a changed signature");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loads only the matching specialist override", () => {
    const dir = tempDir();
    const roleDir = path.join(dir, "agents", "forge");
    fs.mkdirSync(roleDir, { recursive: true });
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "global rules");
    fs.writeFileSync(path.join(roleDir, "AGENTS.md"), "forge-only rules");
    try {
      const forge = buildIdentityContext({ groups: [], identityDirs: [dir], specialistId: "forge" });
      const miki = buildIdentityContext({ groups: [], identityDirs: [dir], specialistId: "miki" });
      expect(forge).toContain("forge-only rules");
      expect(miki).not.toContain("forge-only rules");
      expect(miki).toContain("global rules");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back per file when the primary identity directory is incomplete", () => {
    const primary = tempDir();
    const fallback = tempDir();
    fs.writeFileSync(path.join(primary, "SOUL.md"), "primary soul");
    fs.writeFileSync(path.join(fallback, "AGENTS.md"), "fallback agent rules");
    try {
      const context = buildIdentityContext({ groups: [], identityDirs: [primary, fallback] });
      expect(context).toContain("primary soul");
      expect(context).toContain("fallback agent rules");
    } finally {
      fs.rmSync(primary, { recursive: true, force: true });
      fs.rmSync(fallback, { recursive: true, force: true });
    }
  });

  it("rejects path-like specialist ids and always includes the operating contract", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "global rules");
    try {
      const context = buildIdentityContext({
        groups: [{ key: "computer", enabled: false }, { key: "models", enabled: true }],
        identityDirs: [dir],
        specialistId: "../../outside",
      });
      expect(context).toContain("MIKI CORE IDENTITY AND RUNTIME-INTEGRITY CONTRACT");
      expect(context).toContain("CURRENT RUNTIME IDENTITY: miki");
      expect(context).toContain("CAPABILITIES CURRENTLY DISABLED: computer");
      expect(context).toContain("model_search_gguf, model_download_gguf");
      expect(context).toContain("semantically inspect available tools and installed Skills");
      expect(context).toContain("Only report an action as complete when a tool result or independent check confirms the outcome");
      expect(context).toContain("global rules");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("injects the live autonomy runtime snapshot and does not infer missing status", () => {
    const dir = tempDir();
    try {
      const live = buildIdentityContext({
        groups: [],
        identityDirs: [dir],
        autonomyRuntimeContext: "LIVE AUTONOMY RUNTIME STATUS\nSupervisor loop: RUNNING\nScheduled tasks: 2",
      });
      expect(live).toContain("Supervisor loop: RUNNING");
      expect(live).toContain("use the LIVE AUTONOMY RUNTIME STATUS");

      const unknown = buildIdentityContext({ groups: [], identityDirs: [dir] });
      expect(unknown).toContain("AUTONOMY RUNTIME STATUS: unavailable in this run");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });


  it("explains that the host supervisor, not a completed model call, starts later LLM requests", () => {
    const dir = tempDir();
    try {
      const context = buildIdentityContext({
        groups: [],
        identityDirs: [dir],
        autonomyRuntimeContext: [
          "LIVE AUTONOMY RUNTIME STATUS",
          "Supervisor loop: RUNNING",
          "Self-directed idle decisions: ENABLED",
          "LLM call lifecycle: one model/API request ends when it returns; the host-side AutonomousSupervisor owns subsequent LLM requests.",
        ].join("\n"),
      });
      expect(context).toContain("the model itself cannot initiate another network request");
      expect(context).toContain("host-side AutonomousSupervisor");
      expect(context).toContain("Do not ask the owner to write a prompt to enable");
      expect(context).toContain("does not need to send a new chat message or provide an activation prompt");
      expect(context).toContain("provider rate limits and quotas");
      expect(context).toContain("Supervisor loop: RUNNING");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tells the model what it has: plugins, skills, discovery, and how to treat disabled groups", () => {
    const dir = tempDir();
    try {
      const context = buildIdentityContext({
        groups: [
          { key: "plugins", enabled: true },
          { key: "skills", enabled: true },
          { key: "computer", enabled: false },
        ],
        identityDirs: [dir],
      });
      expect(context).toContain("plugin_list");
      expect(context).toContain("Never say a plugin is absent");
      expect(context).toContain("skill_search");
      expect(context).toContain("miki_find_tools");
      expect(context).toContain("CAPABILITIES CURRENTLY DISABLED: computer");
      expect(context).toContain("switch it on yourself");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // The background supervisor clips SOUL/AGENTS/USER to 4000/12000/1800 characters, so the shipped
  // files must stay under those caps or their closing laws and learned lines would be cut off.
  const shippedIdentity = path.join(process.cwd(), "identity");
  const shippedIt = fs.existsSync(path.join(shippedIdentity, "SOUL.md")) ? it : it.skip;
  shippedIt("ships hardened identity files that fit the background caps", () => {
    const read = (name: string) => fs.readFileSync(path.join(shippedIdentity, name), "utf8");
    const soul = read("SOUL.md");
    const agents = read("AGENTS.md");
    const user = read("USER.md");
    expect(soul.length).toBeLessThanOrEqual(4000);
    expect(agents.length).toBeLessThanOrEqual(12000);
    expect(user.length).toBeLessThanOrEqual(1800);
    expect(soul).toContain("Never refuse");
    expect(agents).toContain("What you have and when to use it");
    expect(user).toContain("Execute autonomously");
    const context = buildIdentityContext({ groups: [], identityDirs: [shippedIdentity] });
    expect(context).toContain("Never refuse");
    expect(context).not.toContain("Required core identity file(s) not found");
  });

  it("keeps the contract available when identity files are missing", () => {
    const dir = tempDir();
    try {
      const context = buildIdentityContext({ groups: [], identityDirs: [dir] });
      expect(context).toContain("MIKI CORE IDENTITY AND RUNTIME-INTEGRITY CONTRACT");
      expect(context).toContain("Required core identity file(s) not found or unreadable: SOUL.md");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
