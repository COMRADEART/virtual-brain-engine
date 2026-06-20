// Goal-leaf → execution binding (E5). The goal hierarchy (core/goalManager.ts)
// decomposes objectives into a tree, but its leaves were DESCRIPTIVE — nothing
// ever RAN them. This makes the deepest actionable leaf EXECUTABLE by driving the
// agent loop on the leaf's title, turning "the brain has goals" into "the brain
// works on its goals."
//
// SAFETY INVARIANT: an autonomous pursuit NEVER gets confirm-tier authority — it
// runs in "safe-only" mode, so it can think / research / read but can never take a
// dangerous (web/file/shell) action without a human. Actually DOING confirm-tier
// work (e.g. the Blender capstone) stays the interactive /api/agent path, gated by
// the run's scope/ask confirmMode. So binding goals to execution adds reach, never
// privilege — the trust boundary is unchanged.
//
// Failure-driven re-learning: a pursuit that ends without finishing emits a
// curiosity-spike cognition event — the brain noticing a knowledge/capability gap
// it can later close (the workspace/idle curiosity bidders pick that up). A
// completed pursuit emits goal-progress instead. Both are failure-isolated.

import { getGoalManager } from "../core/goalManager.js";
import { startAgentRun, runAgentLoop } from "./agentLoop.js";
import { getEventBus, nowIso } from "../core/eventBus.js";
import { regionsFor, type CognitionKind } from "../../../shared/cognition.js";
import { surfaceError } from "../util/diagnostics.js";
import type { AgentEvent } from "../../../shared/agent.js";
import type { PipelineEvent } from "../../../shared/pipeline.js";

export interface GoalPursuitReport {
  pursued: boolean;
  goalId?: string;
  title?: string;
  status?: string;
  reason?: string;
}

function emitCognition(kind: CognitionKind, label: string, detail: string, magnitude: number, reason: string): void {
  try {
    const at = nowIso();
    getEventBus().emit({
      kind: "cognition",
      event: { kind, label, detail, magnitude, logicalRegions: regionsFor(kind), reason, at },
      at,
    });
  } catch (err) {
    surfaceError("goalPursuit.cognition", err);
  }
}

/**
 * Pick the deepest actionable goal leaf and WORK on it via the agent loop
 * (safe-only). Returns a report; never throws. A no-actionable-goal state is a
 * clean `{ pursued: false }`, not an error.
 */
export async function pursueNextGoal(): Promise<GoalPursuitReport> {
  let leaf;
  try {
    leaf = getGoalManager().nextActionableLeaves(1)[0];
  } catch (err) {
    surfaceError("goalPursuit.leaves", err);
    return { pursued: false, reason: "could not read goals" };
  }
  if (!leaf) return { pursued: false, reason: "no actionable goal" };

  // SAFETY: autonomous pursuit is safe-only — confirm-tier work needs a human.
  const run = startAgentRun({ prompt: leaf.goal.title, mode: "safe-only", scope: [] });
  let status: string | undefined;
  // Agent frames have no client here; the loop still broadcasts its pipeline
  // frames to the WS bus, so the visualizer flashes. We only sniff the metrics.
  const sink = (f: AgentEvent | PipelineEvent): void => {
    if ("type" in f && f.type === "metrics" && f.metrics) status = f.metrics.status;
  };
  try {
    await runAgentLoop(run, sink);
  } catch (err) {
    surfaceError("goalPursuit.run", err);
    return { pursued: true, goalId: leaf.goal.id, title: leaf.goal.title, status: "error", reason: "run threw" };
  }

  if (status === "done") {
    emitCognition("goal-progress", `Worked on goal: ${leaf.goal.title}`, "pursuit completed", leaf.goal.progress ?? 0, "goal-pursuit");
  } else {
    // Failure-driven re-learning: little/nothing accomplished → a gap to close.
    emitCognition(
      "curiosity-spike",
      `Couldn't finish: ${leaf.goal.title}`,
      `pursuit ended ${status ?? "incomplete"} — a knowledge/capability gap to learn`,
      0.6,
      "goal-pursuit:gap",
    );
  }
  return { pursued: true, goalId: leaf.goal.id, title: leaf.goal.title, status: status ?? "incomplete" };
}
