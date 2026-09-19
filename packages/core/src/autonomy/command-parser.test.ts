import { parseAutonomyCommand } from "./command-parser.js";

describe("parseAutonomyCommand", () => {
  it("recognizes turbo mode requests", () => {
    expect(parseAutonomyCommand("Hey miki, use the turbo mode")).toEqual({
      action: "set_mode",
      mode: "turbo",
    });
    expect(parseAutonomyCommand("miki use turbo mode")).toEqual({
      action: "set_mode",
      mode: "turbo",
    });
    expect(parseAutonomyCommand("switch to turbo mode please")).toEqual({
      action: "set_mode",
      mode: "turbo",
    });
  });

  it("recognizes standard/normal mode requests", () => {
    expect(parseAutonomyCommand("miki use the standard mode")).toEqual({
      action: "set_mode",
      mode: "standard",
    });
    expect(parseAutonomyCommand("go back to normal mode")).toEqual({
      action: "set_mode",
      mode: "standard",
    });
  });

  it("recognizes enable/disable/pause/resume", () => {
    expect(parseAutonomyCommand("please disable autonomy")).toEqual({
      action: "disable",
    });
    expect(parseAutonomyCommand("turn on autonomous mode")).toEqual({
      action: "enable",
    });
    expect(parseAutonomyCommand("pause autonomy for now")).toEqual({
      action: "pause",
    });
    expect(parseAutonomyCommand("resume autonomous work")).toEqual({
      action: "resume",
    });
  });

  it("recognizes status queries", () => {
    expect(parseAutonomyCommand("what's your current objective?")).toEqual({
      action: "status",
    });
    expect(parseAutonomyCommand("autonomy status")).toEqual({
      action: "status",
    });
  });

  it("returns null for ordinary conversation", () => {
    expect(parseAutonomyCommand("can you help me fix this bug?")).toBeNull();
    expect(parseAutonomyCommand("what's the weather like today?")).toBeNull();
    expect(parseAutonomyCommand("")).toBeNull();
  });
});
