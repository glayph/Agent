import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isGoalAcceptanceContract, verifyGoalAcceptance } from "./goal-acceptance.js";

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
          { type: "tool_called", name: "file_read", status: "succeeded" },
        ],
      },
      { finalText: "Deployment VERIFIED", workspaceRoot: root, toolCalls: [{ name: "file_read", status: "succeeded" }] },
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
      { type: "file_exists", path: "missing.txt" },
      { type: "final_text_contains", text: "complete" },
    ] }, { finalText: "complete", workspaceRoot: process.cwd() }, 0);
    expect(result.checks.length).toBeGreaterThanOrEqual(1);
    expect(result.checks.some((check) => check.type === "budget_exhausted")).toBe(true);
    expect(result.passed).toBe(false);
  });

  it("rejects text-only acceptance contracts before autonomous execution", () => {
    expect(isGoalAcceptanceContract({ checks: [{ type: "final_text_contains", text: "DONE" }] })).toBe(false);
    expect(isGoalAcceptanceContract({ checks: [{ type: "tool_called", name: "file_write" }] })).toBe(false);
    expect(isGoalAcceptanceContract({ checks: [{ type: "tool_called", name: "file_write", status: "succeeded" }] })).toBe(true);
  });

  it("does not let final-text claims override failed independent evidence in any mode", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "miki-acceptance-any-"));
    const result = await verifyGoalAcceptance({ mode: "any", checks: [
      { type: "final_text_contains", text: "DONE" },
      { type: "file_exists", path: "missing.txt" },
    ] }, { finalText: "DONE", workspaceRoot: root });
    expect(result.passed).toBe(false);
    await fs.rm(root, { recursive: true, force: true });
  });

});
