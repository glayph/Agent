import { resolveMemoryFilesConfig, DEFAULT_MEMORY_FILES_CONFIG } from "./config.js";

describe("resolveMemoryFilesConfig", () => {
  it("returns defaults when given nothing", () => {
    expect(resolveMemoryFilesConfig(undefined)).toEqual(DEFAULT_MEMORY_FILES_CONFIG);
  });

  it("reads agent.memory.files.* and clamps out-of-range values", () => {
    const cfg = resolveMemoryFilesConfig({
      files: {
        enabled: true,
        bootstrap_max_chars: 999999999,
        summarizer: "llm",
        compaction: { trigger_percent: 10, keep_recent: 1 },
      },
    });
    expect(cfg.bootstrapMaxChars).toBeLessThanOrEqual(50_000);
    expect(cfg.summarizer).toBe("llm");
    expect(cfg.compaction.triggerPercent).toBeGreaterThanOrEqual(30);
    expect(cfg.compaction.keepRecent).toBeGreaterThanOrEqual(2);
  });

  it("falls back to defaults for garbage values instead of throwing", () => {
    expect(() =>
      resolveMemoryFilesConfig({
        files: { enabled: "yes" as unknown, summarizer: "nonsense" as unknown },
      }),
    ).not.toThrow();
    const cfg = resolveMemoryFilesConfig({
      files: { enabled: "yes" as unknown, summarizer: "nonsense" as unknown },
    });
    expect(cfg.enabled).toBe(true); // default
    expect(cfg.summarizer).toBe("auto"); // default
  });

  it("seeds compaction from legacy resource config only when not explicitly set", () => {
    const cfg = resolveMemoryFilesConfig(undefined, {
      summarizeTokenPercent: 60,
      summarizeMessageThreshold: 12,
    });
    expect(cfg.compaction.triggerPercent).toBe(60);

    const explicit = resolveMemoryFilesConfig(
      { files: { compaction: { trigger_percent: 80 } } },
      { summarizeTokenPercent: 60 },
    );
    expect(explicit.compaction.triggerPercent).toBe(80);
  });
});
