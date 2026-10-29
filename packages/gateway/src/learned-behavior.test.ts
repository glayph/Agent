import { createLearnedBehavior, evolutionConfigFrom } from "./learned-behavior.js";

type Row = { taskClass: string; actionKey: string };

function fakeStore(options: { rows?: Row[]; applied?: Array<Record<string, unknown>>; actionStats?: Record<string, Record<string, number>> } = {}) {
  const decisions: Array<Record<string, unknown>> = [];
  const store = {
    normalizeScope: (scope: unknown) => ({ ...(scope as object), scopeKey: "k" }),
    recordExperience: () => ({ stored: true, duplicate: false, row: {} }),
    listExperiences: () => options.rows ?? [],
    getExperienceStats: () => ({}),
    readPolicyState: () => ({ policyVersion: 1, mode: "apply", actionStats: options.actionStats ?? {}, totalDecisions: 1000 }),
    upsertPolicyState: () => ({}),
    listCycles: () => [],
    recordCycle: () => ({}),
    finishCycle: () => ({}),
    countCyclesSince: () => 0,
    lastCycle: () => null,
    createProposal: () => null,
    listProposals: () => options.applied ?? [],
    recordDecision: (input: Record<string, unknown>) => { decisions.push(input); return { id: `d${decisions.length}` }; },
  };
  return { store, decisions };
}

const scope = () => ({ agentId: "miki", ownerId: "o", workspaceId: "w" });
const config = (mode: string, extra: Record<string, unknown> = {}) => ({
  self_improvement: { enabled: true },
  evolution: { enabled: true, mode, behavior_learning: { exploration_rate: 0, exploration_floor: 0, min_samples: 3, ...extra } },
});

describe("evolutionConfigFrom", () => {
  it("defaults to observe mode and lets the evolution block win", () => {
    expect(evolutionConfigFrom({}).behavior_learning?.mode).toBe("observe");
    expect(evolutionConfigFrom({ self_improvement: { enabled: true, behavior_learning: { mode: "draft" } }, evolution: { mode: "apply" } }).behavior_learning?.mode).toBe("apply");
  });
});

describe("learned guidance note", () => {
  it("turns applied reflection findings into one advisory system note", () => {
    const { store } = fakeStore({ applied: [{ kind: "reflection", payload: { finding: JSON.stringify({ finding: "Answers run long", recommendation: "Lead with the result" }) } }] });
    const learned = createLearnedBehavior({ getLearningStore: () => store as never, getAppConfig: () => config("apply"), resolveModel: (m) => ({ model: m ?? "base" }), scope });
    const note = learned.guidanceNote();
    expect(note).toContain("advisory");
    expect(note).toContain("- Answers run long Suggested: Lead with the result");
  });

  it("returns nothing when nothing was applied or there is no store", () => {
    const empty = fakeStore();
    expect(createLearnedBehavior({ getLearningStore: () => empty.store as never, getAppConfig: () => config("apply"), resolveModel: () => ({ model: "base" }), scope }).guidanceNote()).toBeUndefined();
    expect(createLearnedBehavior({ getLearningStore: () => null, getAppConfig: () => config("apply"), resolveModel: () => ({ model: "base" }), scope }).guidanceNote()).toBeUndefined();
  });
});

describe("learned model choice", () => {
  const rows: Row[] = [
    { taskClass: "interactive_chat", actionKey: "model:good" },
    { taskClass: "user_feedback", actionKey: "model:gone" },
    { taskClass: "interactive_chat", actionKey: "model:baseline" },
  ];
  const stats = {
    "model:base": { count: 10, averageReward: 0.2, emaReward: 0.2, variance: 0.0001 },
    "model:good": { count: 10, averageReward: 0.9, emaReward: 0.9, variance: 0.0001 },
  };
  const known = new Set(["base", "good"]);
  const resolveModel = (m?: string) => (m === undefined ? { model: "base" } : known.has(m) ? { model: m } : undefined);

  it("picks the better-rewarded model that is still configured", () => {
    const { store, decisions } = fakeStore({ rows, actionStats: stats });
    const learned = createLearnedBehavior({ getLearningStore: () => store as never, getAppConfig: () => config("apply"), resolveModel, scope, random: () => 0.5 });
    expect(learned.chooseModel("Summarise the report")).toBe("good");
    expect(decisions).toHaveLength(1);
  });

  it("keeps the default unless behaviour learning is in apply mode", () => {
    const { store, decisions } = fakeStore({ rows, actionStats: stats });
    const learned = createLearnedBehavior({ getLearningStore: () => store as never, getAppConfig: () => config("observe"), resolveModel, scope, random: () => 0.5 });
    expect(learned.chooseModel("Summarise the report")).toBeUndefined();
    expect(decisions).toHaveLength(0);
  });

  it("keeps the default with too few samples or only one usable model", () => {
    const sparse = fakeStore({ rows, actionStats: { "model:good": { count: 1, averageReward: 0.9, emaReward: 0.9, variance: 0.0001 } } });
    expect(createLearnedBehavior({ getLearningStore: () => sparse.store as never, getAppConfig: () => config("apply"), resolveModel, scope, random: () => 0.5 }).chooseModel("q")).toBeUndefined();
    const single = fakeStore({ rows: [], actionStats: stats });
    expect(createLearnedBehavior({ getLearningStore: () => single.store as never, getAppConfig: () => config("apply"), resolveModel, scope, random: () => 0.5 }).chooseModel("q")).toBeUndefined();
  });
});
