import { readMikiEnv } from "./env-compat.js";

describe("readMikiEnv", () => {
  it("prefers the canonical MIKI_ (all-caps) name when set", () => {
    const env = {
      MIKI_ALLOWED_ORIGINS: "https://new.example.com",
      Miki_ALLOWED_ORIGINS: "https://old.example.com",
    } as NodeJS.ProcessEnv;

    expect(readMikiEnv("MIKI_ALLOWED_ORIGINS", env)).toBe(
      "https://new.example.com",
    );
  });

  it("falls back to the legacy mixed-case Miki_ name when the canonical name is unset", () => {
    const env = {
      Miki_ALLOWED_ORIGINS: "https://old.example.com",
    } as NodeJS.ProcessEnv;

    expect(readMikiEnv("MIKI_ALLOWED_ORIGINS", env)).toBe(
      "https://old.example.com",
    );
  });

  it("returns undefined when neither name is set", () => {
    expect(
      readMikiEnv("MIKI_ALLOWED_ORIGINS", {} as NodeJS.ProcessEnv),
    ).toBeUndefined();
  });

  it("defaults to process.env when no env object is passed", () => {
    const original = process.env["MIKI_TEST_ONLY_ENV_COMPAT_VAR"];
    process.env["MIKI_TEST_ONLY_ENV_COMPAT_VAR"] = "value-from-process-env";
    try {
      expect(readMikiEnv("MIKI_TEST_ONLY_ENV_COMPAT_VAR")).toBe(
        "value-from-process-env",
      );
    } finally {
      if (original === undefined) {
        delete process.env["MIKI_TEST_ONLY_ENV_COMPAT_VAR"];
      } else {
        process.env["MIKI_TEST_ONLY_ENV_COMPAT_VAR"] = original;
      }
    }
  });
});
