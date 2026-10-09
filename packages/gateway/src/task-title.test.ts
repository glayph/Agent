import { DEFAULT_CHAT_TITLE, titleFromMessage } from "./task-title.js";

describe("titleFromMessage", () => {
  it("uses the first line of the request", () => {
    expect(titleFromMessage("Install Miki in VirtualBox\nthen configure Telegram")).toBe("Install Miki in VirtualBox");
  });

  it("strips markdown and collapses whitespace", () => {
    expect(titleFromMessage("##   Fix   the  `memory`   bug")).toBe("Fix the memory bug");
  });

  it("truncates long requests at a word boundary", () => {
    const title = titleFromMessage("Please research graph based memory systems for agentic AI and compare them in depth", 40);
    expect(title.length).toBeLessThanOrEqual(40);
    expect(title.endsWith("…")).toBe(true);
    expect(title).not.toMatch(/\s…$/);
  });

  it("keeps Bengali text intact", () => {
    expect(titleFromMessage("মেমোরি সিস্টেম আপগ্রেড করো")).toBe("মেমোরি সিস্টেম আপগ্রেড করো");
  });

  it("returns an empty string when there is no text", () => {
    expect(titleFromMessage("")).toBe("");
    expect(titleFromMessage("  \n \n")).toBe("");
    expect(titleFromMessage("###")).toBe("");
    expect(DEFAULT_CHAT_TITLE).toBe("Miki chat");
  });
});
