import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifyGoalAcceptance } from "./goal-acceptance.js";

describe("Goal Acceptance Contract", () => {
  it("passes deterministic text and file evidence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "miki-acceptance-"));
    await fs.writeFile(path.join(root, "health.txt"), "service: healthy\n", "utf8");
    const result = await verifyGoalAcceptance(
      {
        mode: "all",
        checks: [
          { type: "final_text_contains", text: "VERIFIED" },
          { type: "file_exists", path: "health.txt" },
          { type: "file_contains", path: "health.txt", text: "healthy" },
          { type: "tool_called", name: "file_read" },
        ],
      },
      { finalText: "Deployment VERIFIED", workspaceRoot: root, toolCalls: [{ name: "file_read", status: "completed" }] },
    );
    expect(result.passed).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });

  it("fails closed when no contract is present", async () => {
    const result = await verifyGoalAcceptance(undefined, { finalText: "Everything is complete." });
    expect(result.passed).toBe(false);
    expect(result.reason).toMatch(/No deterministic Goal Acceptance Contract/);
  });
  it("stops acceptance evaluation when the total verification budget is exhausted", async () => {
    const result = await verifyGoalAcceptance({ checks: [
      { type: "final_text_contains", text: "complete" },
      { type: "final_text_contains", text: "verified" },
    ] }, { finalText: "complete" }, 0);
    expect(result.checks.length).toBeGreaterThanOrEqual(1);
    expect(result.checks.some((check) => check.type === "budget_exhausted")).toBe(true);
    expect(result.passed).toBe(false);
  });


});
