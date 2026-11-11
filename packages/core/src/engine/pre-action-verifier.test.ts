import { verifyPreActionOnce, verifyPreActionTwice } from "./pre-action-verifier.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";

const input = (llm: ReturnType<typeof scriptedLLM>["client"]) => ({
  llm,
  latestUserMessage: "Please finish the README update, but do not send me status messages.",
  recentContext: "user: Please finish the README update.\nassistant: I will inspect the file first.",
  rootGoal: "Update the README",
  actionGoal: "Write the README changes",
  toolName: "file_write",
  arguments: JSON.stringify({ path: "README.md", content: "updated" }),
});

describe("pre-action intent verification", () => {
  it("allows an action after one positive check in the default mode", async () => {
    const llm = scriptedLLM([
      { text: JSON.stringify({ decision: "proceed", reason: "This step clearly advances the owner's latest request." }) },
    ]);

    const result = await verifyPreActionOnce(input(llm.client));

    expect(result.status).toBe("passed");
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ pass: 1, status: "proceed" });
    expect(llm.requests).toHaveLength(1);
  });

  it("blocks the action when its single default check finds stale or irrelevant intent", async () => {
    const llm = scriptedLLM([
      { text: JSON.stringify({ decision: "block", reason: "The user has since cancelled this step." }) },
    ]);

    const result = await verifyPreActionOnce(input(llm.client));

    expect(result.status).toBe("blocked");
    expect(result.checks).toHaveLength(1);
    expect(llm.requests).toHaveLength(1);
  });

  it("fails closed when the single default check is unavailable", async () => {
    const llm = scriptedLLM([{ text: "not JSON" }]);
    const result = await verifyPreActionOnce(input(llm.client));
    expect(result.status).toBe("unavailable");
    expect(result.checks).toHaveLength(1);
  });

  it("requires two independent positive decisions when double-check is enabled", async () => {
    const llm = scriptedLLM([
      { text: JSON.stringify({ decision: "proceed", reason: "The edit directly advances the latest request." }) },
      { text: JSON.stringify({ decision: "proceed", reason: "The proposed write remains relevant and timely." }) },
    ]);

    const result = await verifyPreActionTwice(input(llm.client));

    expect(result.status).toBe("passed");
    expect(result.checks).toHaveLength(2);
    expect(result.checks.every((check) => check.status === "proceed")).toBe(true);
    expect(llm.requests).toHaveLength(2);
    expect(String(llm.requests[0].messages[0].content)).toContain("CHECK 1");
    expect(String(llm.requests[1].messages[0].content)).toContain("CHECK 2");
    expect(String(llm.requests[0].messages[1].content)).toContain("Latest user message");
  });

  it("blocks when either independent check finds the step is not aligned", async () => {
    const llm = scriptedLLM([
      { text: JSON.stringify({ decision: "proceed", reason: "The file edit is relevant." }) },
      { text: JSON.stringify({ decision: "block", reason: "The proposed status message is explicitly unwanted." }) },
    ]);

    const result = await verifyPreActionTwice(input(llm.client));

    expect(result.status).toBe("blocked");
    expect(result.checks[1]).toMatchObject({ status: "block", pass: 2 });
    expect(llm.requests).toHaveLength(2);
  });

  it("fails closed when one or both checks cannot produce a valid decision", async () => {
    const llm = scriptedLLM([
      { text: "not JSON" },
      { text: JSON.stringify({ decision: "proceed", reason: "The step matches the request." }) },
    ]);

    const result = await verifyPreActionTwice(input(llm.client));

    expect(result.status).toBe("unavailable");
    expect(result.checks[0].status).toBe("unavailable");
    expect(result.checks[1].status).toBe("proceed");
  });

  it("fails closed when no verifier model is available", async () => {
    const result = await verifyPreActionTwice({
      latestUserMessage: "Please review the file.",
      recentContext: "user: Please review the file.",
      rootGoal: "Review the file",
      actionGoal: "Read the file",
      toolName: "file_read",
      arguments: "{}",
    });
    expect(result.status).toBe("unavailable");
    expect(result.checks.map((check) => check.status)).toEqual(["unavailable", "unavailable"]);
  });
});
