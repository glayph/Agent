import { describe, expect, it } from "vitest"

import type { AgentRun } from "@/api/agent-runs"

import {
  buildReplayRunPayload,
  filterAgentRuns,
  normalizeAgentRunsSearch,
  parseRunStepLines,
  resolveSelectedStep,
  summarizeRun,
  validateRunDraft,
} from "./runs-page-model"

function run(overrides: Partial<AgentRun>): AgentRun {
  return {
    id: overrides.id ?? "run-1",
    objective: overrides.objective ?? "ship feature",
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? "2026-06-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-06-01T00:00:00.000Z",
    steps: overrides.steps ?? [
      {
        id: "step-1",
        title: "Plan",
        dependsOn: [],
        status: "completed",
        attempts: 1,
        evidence: [{ kind: "manual", summary: "planned", ok: true }],
      },
    ],
  }
}

describe("agent runs page model", () => {
  it("normalizes URL search params safely", () => {
    expect(
      normalizeAgentRunsSearch({
        q: " replay ",
        status: "running",
        run: " run-1 ",
        step: " step-1 ",
        page: "3",
      }),
    ).toEqual({
      q: "replay",
      status: "running",
      run: "run-1",
      step: "step-1",
      page: 3,
    })

    expect(
      normalizeAgentRunsSearch({
        q: null,
        status: "unknown",
        run: 42,
        step: false,
        page: 0,
      }),
    ).toEqual({
      q: "",
      status: "all",
      run: "",
      step: "",
      page: 1,
    })
  })

  it("summarizes step state and evidence counts", () => {
    const summary = summarizeRun(
      run({
        steps: [
          {
            id: "step-1",
            title: "Plan",
            dependsOn: [],
            status: "completed",
            attempts: 1,
            evidence: [{ kind: "manual", summary: "done", ok: true }],
          },
          {
            id: "step-2",
            title: "Verify",
            dependsOn: ["step-1"],
            status: "failed",
            attempts: 2,
            evidence: [{ kind: "command", summary: "failed", ok: false }],
          },
        ],
      }),
    )

    expect(summary).toMatchObject({
      totalSteps: 2,
      completedSteps: 1,
      failedSteps: 1,
      evidenceCount: 2,
    })
  })

  it("filters by status, objective, id, step title, evidence, and errors", () => {
    const runs = [
      run({ id: "alpha", objective: "ship replay", status: "completed" }),
      run({
        id: "beta",
        objective: "debug queue",
        status: "running",
        steps: [
          {
            id: "step-1",
            title: "Inspect websocket",
            dependsOn: [],
            status: "running",
            attempts: 1,
            evidence: [{ kind: "command", summary: "websocket passed", ok: true }],
          },
        ],
      }),
      run({
        id: "gamma",
        objective: "debug verifier",
        status: "failed",
        steps: [
          {
            id: "step-1",
            title: "Collect logs",
            dependsOn: [],
            status: "failed",
            attempts: 1,
            evidence: [],
            error: {
              code: "E_TEST",
              category: "runtime",
              message: "snapshot mismatch",
              retryable: false,
            },
          },
        ],
      }),
    ]

    expect(
      filterAgentRuns(runs, "replay", "all").map((item) => item.id),
    ).toEqual(["alpha"])
    expect(
      filterAgentRuns(runs, "websocket", "running").map((item) => item.id),
    ).toEqual(["beta"])
    expect(
      filterAgentRuns(runs, "snapshot", "failed").map((item) => item.id),
    ).toEqual(["gamma"])
  })

  it("keeps current step when possible and otherwise prefers active failures", () => {
    const selected = resolveSelectedStep(
      run({
        steps: [
          {
            id: "step-1",
            title: "Plan",
            dependsOn: [],
            status: "completed",
            attempts: 1,
            evidence: [],
          },
          {
            id: "step-2",
            title: "Verify",
            dependsOn: ["step-1"],
            status: "failed",
            attempts: 1,
            evidence: [],
          },
        ],
      }),
      "missing",
    )

    expect(selected?.id).toBe("step-2")
  })

  it("parses run step lines without blanks", () => {
    expect(parseRunStepLines(" Plan \n\nVerify evidence\n  Ship  ")).toEqual([
      "Plan",
      "Verify evidence",
      "Ship",
    ])
  })

  it("validates manual run drafts before creation", () => {
    expect(validateRunDraft("  ", "Plan").errors).toMatchObject({
      objective: "Objective is required.",
    })
    expect(validateRunDraft("Investigate queue", "\n \n").errors).toMatchObject({
      steps: "At least one step is required.",
    })
    expect(validateRunDraft(" Investigate queue ", " Plan \nVerify ")).toEqual({
      objective: "Investigate queue",
      steps: ["Plan", "Verify"],
      errors: {},
    })
  })

  it("builds replay payloads from an existing run", () => {
    expect(
      buildReplayRunPayload(
        run({
          objective: "Verify release",
          steps: [
            {
              id: "step-1",
              title: " Inspect ",
              dependsOn: [],
              status: "completed",
              attempts: 1,
              evidence: [],
            },
            {
              id: "step-2",
              title: "Ship",
              dependsOn: ["step-1"],
              status: "failed",
              attempts: 1,
              evidence: [],
            },
          ],
        }),
      ),
    ).toEqual({
      objective: "Replay: Verify release",
      steps: ["Inspect", "Ship"],
    })
  })
})
