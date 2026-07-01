import { describe, expect, it } from "vitest";
import { beliefTone, flattenGoalTree, modulatorRows, stanceLabel } from "./mindFormat";
import type { GoalNodeView, ModulatorStatusView } from "../../engine/apiClient";

function node(id: string, children: GoalNodeView[] = [], progress = 0.5): GoalNodeView {
  return {
    goal: { id, title: `Goal ${id}`, status: "active", progress, priority: 50 },
    depth: 0,
    level: "long-term",
    children,
  };
}

describe("flattenGoalTree", () => {
  it("returns an empty list for an empty forest", () => {
    expect(flattenGoalTree([])).toEqual([]);
  });

  it("keeps children directly under their parent with incremented depth", () => {
    const forest = [node("a", [node("a1", [node("a1x")]), node("a2")]), node("b")];
    const flat = flattenGoalTree(forest);
    expect(flat.map((f) => f.id)).toEqual(["a", "a1", "a1x", "a2", "b"]);
    expect(flat.map((f) => f.depth)).toEqual([0, 1, 2, 1, 0]);
  });

  it("clamps progress into [0,1]", () => {
    const flat = flattenGoalTree([node("x", [], 1.7)]);
    expect(flat[0].progress).toBe(1);
  });
});

describe("beliefTone / stanceLabel", () => {
  it("buckets confidence at the BrainState cutoffs", () => {
    expect(beliefTone(0.9)).toBe("hi");
    expect(beliefTone(0.6)).toBe("hi");
    expect(beliefTone(0.5)).toBe("mid");
    expect(beliefTone(0.1)).toBe("lo");
  });

  it("labels every belief status", () => {
    expect(stanceLabel("active")).toBe("held");
    expect(stanceLabel("contested")).toBe("contested");
    expect(stanceLabel("something-new")).toBe("something-new");
  });
});

describe("modulatorRows", () => {
  it("pairs levels with baselines, sorted by name, dropping bad values", () => {
    const status = {
      levels: { dopamine: 0.7, acetylcholine: 0.4, broken: Number.NaN },
      baseline: { dopamine: 0.5 },
      learningRateScale: 1,
      underStress: false,
      pulses: 0,
    } as unknown as ModulatorStatusView;
    expect(modulatorRows(status)).toEqual([
      ["acetylcholine", 0.4, 0.5],
      ["dopamine", 0.7, 0.5],
    ]);
  });
});
