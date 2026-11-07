import { verifyToolAction } from "./action-verifier.js";
import { scriptedLLM } from "./__tests__/scripted-llm.js";

describe("verifyToolAction", () => {
  it("accepts a concrete verification verdict with evidence", async () => {
    const { client } = scriptedLLM([{ text: JSON.stringify({ status: "verified", reason: "The file is present.", evidence: ["Directory listing includes report.txt"] }) }]);
    const result = await verifyToolAction({
      llm: client,
      rootGoal: "Create a report",
      actionGoal: "Create report.txt",
      toolName: "write_file",
      arguments: '{"path":"report.txt"}',
      result: '{"ok":true}',
    });
    expect(result).toEqual({ status: "verified", reason: "The file is present.", evidence: ["Directory listing includes report.txt"] });
  });

  it("does not trust a tool's explicit negative effect confirmation", async () => {
    const { client, requests } = scriptedLLM([{ text: "should not be called" }]);
    const result = await verifyToolAction({
      llm: client,
      rootGoal: "Send a message",
      actionGoal: "Send the message",
      toolName: "send_message",
      arguments: "{}",
      result: '{"ok":false}',
      effectConfirmed: false,
    });
    expect(result?.status).toBe("failed");
    expect(requests).toHaveLength(0);
  });

  it("rejects a verified verdict without concrete evidence", async () => {
    const { client } = scriptedLLM([{ text: JSON.stringify({ status: "verified", reason: "Looks done.", evidence: [] }) }]);
    const result = await verifyToolAction({
      llm: client,
      rootGoal: "Run a job",
      actionGoal: "Finish the job",
      toolName: "start_job",
      arguments: "{}",
      result: "accepted",
    });
    expect(result).toBeNull();
  });
});
