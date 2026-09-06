import {
  DEFAULT_GEMINI_MODEL,
  DEFAULT_GEMINI_PROVIDER,
  settings,
} from "./index.js";

describe("centralized Gemini default model", () => {
  const originalModel = process.env.MIKI_MODEL;
  const originalProvider = process.env.MIKI_PROVIDER;
  const originalSettingsModel = settings.defaultModel;
  const originalSettingsProvider = settings.provider;

  afterEach(() => {
    if (originalModel === undefined) delete process.env.MIKI_MODEL;
    else process.env.MIKI_MODEL = originalModel;
    if (originalProvider === undefined) delete process.env.MIKI_PROVIDER;
    else process.env.MIKI_PROVIDER = originalProvider;
    settings.setModel(originalSettingsModel);
    settings.provider = originalSettingsProvider;
  });

  it("exposes Gemini as the canonical default", () => {
    expect(DEFAULT_GEMINI_MODEL).toBe("gemini/gemini-3.5-flash-lite");
    expect(DEFAULT_GEMINI_PROVIDER).toBe("gemini");
    expect(settings.getSupportedModels()[0]).toBe(DEFAULT_GEMINI_MODEL);
  });

  it("keeps an explicit model selection as an override", () => {
    settings.setModel("openai/gpt-4o");
    settings.provider = "openai";

    expect(settings.defaultModel).toBe("openai/gpt-4o");
    expect(settings.model).toBe("openai/gpt-4o");
    expect(settings.provider).toBe("openai");
  });
});
