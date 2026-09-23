import {
  classifyExecutionPipeline,
  formatExecutionPipelineDecision,
} from "./execution-pipeline.js";

 describe("unified execution pipeline", () => {
  it("routes ordinary chat to the simple-message path without tools", () => {
    const decision = classifyExecutionPipeline("Hello Miki, how are you?");

    expect(decision.mode).toBe("simple_message");
    expect(decision.useTools).toBe(false);
    expect(decision.requiresVerification).toBe(false);
    expect(decision.iterative).toBe(false);
  });

  it("routes an actionable request to the task path", () => {
    const decision = classifyExecutionPipeline(
      "Fix the config validation test and run it",
    );

    expect(decision.mode).toBe("task");
    expect(decision.useTools).toBe(true);
    expect(decision.requiresVerification).toBe(true);
    expect(decision.iterative).toBe(false);
  });

  it("routes a tagged autonomous objective to the iterative path", () => {
    const decision = classifyExecutionPipeline(
      "[[miki-autonomy:objective-1]]\nInspect the failing tests and keep working until done",
    );

    expect(decision.mode).toBe("autonomous_task");
    expect(decision.useTools).toBe(true);
    expect(decision.requiresVerification).toBe(true);
    expect(decision.iterative).toBe(true);
  });

  it("does not treat a question about workflows as an executable workflow", () => {
    const decision = classifyExecutionPipeline(
      "What is a workflow pipeline and why is it useful?",
    );

    expect(decision.mode).toBe("simple_message");
  });

  it("formats an observable decision without another model call", () => {
    const output = formatExecutionPipelineDecision(
      classifyExecutionPipeline("Create a file and verify it"),
    );

    expect(output).toContain("mode: task");
    expect(output).toContain("verification: true");
  });
});
