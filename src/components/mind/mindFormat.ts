// Pure formatting helpers for the Mind panel — kept out of the component so
// they are unit-testable without a DOM (the cognitionStream.ts pattern).

import type { GoalNodeView, ModulatorStatusView } from "../../engine/apiClient";

export interface FlatGoal {
  id: string;
  title: string;
  depth: number;
  level: string;
  progress: number;
  status: string;
  priority: number;
}

/** DFS-flatten the goal forest into indented rows (children under parents). */
export function flattenGoalTree(nodes: ReadonlyArray<GoalNodeView>): FlatGoal[] {
  const out: FlatGoal[] = [];
  const walk = (node: GoalNodeView, depth: number): void => {
    out.push({
      id: node.goal.id,
      title: node.goal.title,
      depth,
      level: node.level,
      progress: Math.max(0, Math.min(1, node.goal.progress ?? 0)),
      status: node.goal.status,
      priority: node.goal.priority,
    });
    for (const child of node.children ?? []) walk(child, depth + 1);
  };
  for (const node of nodes) walk(node, 0);
  return out;
}

/** Confidence tone bucket — mirrors BrainStatePanel's gauge cutoffs. */
export function beliefTone(confidence: number): "hi" | "mid" | "lo" {
  return confidence >= 0.6 ? "hi" : confidence >= 0.35 ? "mid" : "lo";
}

/** Human label for a belief status. */
export function stanceLabel(status: string): string {
  switch (status) {
    case "active":
      return "held";
    case "contested":
      return "contested";
    case "weakening":
      return "weakening";
    case "retired":
      return "retired";
    default:
      return status;
  }
}

/** Modulator levels as sorted [name, level, baseline] rows; bad values dropped. */
export function modulatorRows(status: ModulatorStatusView): Array<[string, number, number]> {
  const rows: Array<[string, number, number]> = [];
  for (const [name, level] of Object.entries(status.levels ?? {})) {
    if (typeof level !== "number" || !Number.isFinite(level)) continue;
    const baseline = status.baseline?.[name];
    rows.push([name, level, typeof baseline === "number" && Number.isFinite(baseline) ? baseline : 0.5]);
  }
  return rows.sort((a, b) => a[0].localeCompare(b[0]));
}
