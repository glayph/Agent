import { handleShellExecute } from "./handlers.js";

describe("shell_execute handler input validation", () => {
  it("does not crash when the command argument is missing", async () => {
    const runShell = jest.fn().mockResolvedValue({
      stdout: "",
      stderr: "",
      exitCode: -1,
      error: "shell_execute command is required.",
    });

    const result = await handleShellExecute.call(
      { executor: { runShell } } as never,
      {},
    );

    expect(runShell).toHaveBeenCalledWith("", undefined, 30);
    expect(result).toBe("Execution Error: shell_execute command is required.");
  });
});
