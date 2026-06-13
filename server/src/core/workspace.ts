// Global workspace — directed cognition between queries (GWT).
//
// Real brains don't idle: subsystems compete for a broadcast slot and the
// winner gets a moment of "conscious" processing. The bidders all already
// exist in this codebase — open questions held in BrainState working memory,
// the curiosity frontier over the causal world model, and the organism's
// active goals. What was missing is the competition and the thought:
//
//   collectBids()      — assemble bids from each subsystem (failure-isolated
//                        per source; a broken organism never silences the
//                        open-question bidder).
//   selectWinner()     — pure arbitration: highest salience, deterministic
//                        tie-break.
//   runWorkspaceCycle()— give the winner ONE cheap LLM micro-thought ("think
//                        one step about this") and write the result back as a
//                        memory, so the brain literally resolves its own open
//                        questions over time. The thought is broadcast on the
//                        existing `idle-thought` bus event (reason carries the
//                        bid kind) so the frontend ticker shows it live.
//
// The schedule lives in agents/brainCore.ts behind CONFIG.workspaceEnabled
// (one micro-thought per interval, connector required, skipped quietly when
// none). The selfcheck injects a scripted connector — hermetic, no LLM.

import { createHash } from "node:crypto";
import { getEventBus, nowIso } from "./eventBus.js";
import { getBrainState } from "./brainState.js";
import { gatherCuriosity } from "./curiosity.js";
import { getPersistentOrganism } from "./organism.js";
import { getBeliefEngine } from "./beliefs.js";
import { getGoalManager } from "./goalManager.js";
import { stageAllows } from "./stages.js";
import { getDefaultConnectorInstance } from "../connectors/registry.js";
import type { Connector } from "../connectors/Connector.js";
import { upsertMemoryPoint } from "../db/repositories/memory.js";
import { surfaceError } from "../util/diagnostics.js";

export type WorkspaceBidKind = "open-question" | "curiosity" | "goal" | "belief";

export interface WorkspaceBid {
  id: string;
  kind: WorkspaceBidKind;
  label: string;
  /** [0,1] — what the bid is worth this round. */
  salience: number;
}

export interface WorkspaceReport {
  bids: number;
  winner: WorkspaceBid | null;
  memoryId: string | null;
  thought: string | null;
  reason?: string;
}

// Salience scales per bidder. Open questions dominate (they are the brain's
// own flagged failures); curiosity follows; contested beliefs bid in between
// (a shaken conviction deserves a moment); standing goals only win an
// otherwise-empty round.
export const OPEN_QUESTION_SCALE = 0.9;
export const CURIOSITY_SCALE = 0.8;
export const BELIEF_SCALE = 0.7;
export const GOAL_SALIENCE = 0.35;
export const THOUGHT_IMPORTANCE = 0.55;

const MICRO_THOUGHT_SYSTEM = `You are the idle reflection process of a personal knowledge brain. You get ONE item the brain decided deserves a moment of thought. Think exactly one step: produce either (a) a 2-3 sentence insight that makes progress on it, or (b) ONE sharper, more answerable reformulation of the question. Output plain text only — no preamble, no JSON.`;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// -----------------------------------------------------------------------------
// PURE arbitration.
// -----------------------------------------------------------------------------

/** Highest salience wins; ties break on id (stable, deterministic). */
export function selectWinner(bids: ReadonlyArray<WorkspaceBid>): WorkspaceBid | null {
  let winner: WorkspaceBid | null = null;
  for (const bid of bids) {
    if (
      !winner ||
      bid.salience > winner.salience ||
      (bid.salience === winner.salience && bid.id < winner.id)
    ) {
      winner = bid;
    }
  }
  return winner;
}

// -----------------------------------------------------------------------------
// Bid assembly — each source failure-isolated.
// -----------------------------------------------------------------------------

export function collectBids(): WorkspaceBid[] {
  const bids: WorkspaceBid[] = [];

  // Open questions held in working memory (the brain's own flagged gaps).
  try {
    const snap = getBrainState().snapshot();
    for (const item of snap.workingMemory) {
      if (item.kind === "open-question") {
        bids.push({
          id: `oq-${item.id}`,
          kind: "open-question",
          label: item.label,
          salience: clamp01(item.activation * OPEN_QUESTION_SCALE),
        });
      }
    }
  } catch (err) {
    surfaceError("workspace.bids.openQuestions", err);
  }

  // Curiosity frontier (expected information gain over the causal map).
  // Developmental gate: curiosity-driven cognition unlocks at stage 5
  // (fail-open — a broken tracker never silences the bidder).
  try {
    const c = stageAllows("curiosity-bids") ? gatherCuriosity() : null;
    if (c && c.topTarget && c.curiosity > 0) {
      bids.push({
        id: `cur-${c.topTarget}`,
        kind: "curiosity",
        label: `What actually happens after "${c.topTarget}"? The causal model is least certain here.`,
        salience: clamp01(c.curiosity * CURIOSITY_SCALE),
      });
    }
  } catch (err) {
    surfaceError("workspace.bids.curiosity", err);
  }

  // Contested / weakening beliefs — the brain re-examines its own shaken
  // convictions. Salience rises as confidence falls; the winning micro-thought
  // becomes a memory whose contradiction/reinforcement re-enters the belief
  // engine through the storage-time novelty seam. Unlocks at stage 2.
  try {
    const beliefCandidates = stageAllows("belief-bids")
      ? getBeliefEngine().reExaminationCandidates(2)
      : [];
    for (const belief of beliefCandidates) {
      bids.push({
        id: `belief-${belief.id}`,
        kind: "belief",
        label: `Re-examine the belief "${belief.statement}" — it has ${belief.contradictingIds.length} contradicting observation(s) and confidence ${belief.confidence.toFixed(2)}. Is it still true?`,
        salience: clamp01(BELIEF_SCALE * (1 - belief.confidence)),
      });
    }
  } catch (err) {
    surfaceError("workspace.bids.beliefs", err);
  }

  // Standing goals — low salience; they win only an otherwise-quiet round.
  // Hierarchy-aware: the goal manager's deepest actionable LEAVES bid (a leaf
  // is the next thing actually doable; depth adds a small bonus). Falls back
  // to the organism's flat title list if the manager has no tree to offer.
  try {
    const leaves = getGoalManager().nextActionableLeaves(3);
    if (leaves.length > 0) {
      for (const [i, leaf] of leaves.entries()) {
        bids.push({
          id: `goal-${leaf.goal.id}`,
          kind: "goal",
          label: `One concrete next step toward the goal: ${leaf.goal.title}`,
          salience: clamp01(GOAL_SALIENCE + Math.min(0.15, leaf.depth * 0.05) - i * 0.05),
        });
      }
    } else {
      const goals = getPersistentOrganism().getActiveGoalTitles(3);
      for (const [i, title] of goals.entries()) {
        bids.push({
          id: `goal-${i}-${title.slice(0, 24)}`,
          kind: "goal",
          label: `One concrete next step toward the goal: ${title}`,
          salience: clamp01(GOAL_SALIENCE - i * 0.05),
        });
      }
    }
  } catch (err) {
    surfaceError("workspace.bids.goals", err);
  }

  return bids;
}

// -----------------------------------------------------------------------------
// The cycle.
// -----------------------------------------------------------------------------

export interface WorkspaceOptions {
  /** Injectable for the hermetic selfcheck. Defaults to the registry default. */
  connector?: Connector | null;
}

export async function runWorkspaceCycle(opts: WorkspaceOptions = {}): Promise<WorkspaceReport> {
  const bids = collectBids();
  if (bids.length === 0) {
    return { bids: 0, winner: null, memoryId: null, thought: null, reason: "no bids" };
  }
  const winner = selectWinner(bids);
  if (!winner) {
    return { bids: bids.length, winner: null, memoryId: null, thought: null, reason: "no winner" };
  }
  const connector = opts.connector !== undefined ? opts.connector : getDefaultConnectorInstance();
  if (!connector) {
    return { bids: bids.length, winner, memoryId: null, thought: null, reason: "no connector" };
  }

  try {
    const thought = (await connector.send(winner.label, {
      system: MICRO_THOUGHT_SYSTEM,
      temperature: 0.4,
      maxTokens: 220,
    })).trim();
    if (thought.length === 0) {
      return { bids: bids.length, winner, memoryId: null, thought: null, reason: "empty thought" };
    }
    const content = `Workspace thought (${winner.kind}): ${winner.label}\n→ ${thought}`;
    const memory = upsertMemoryPoint({
      sourceType: "manual",
      title: thought.slice(0, 80),
      content,
      contentHash: createHash("sha1").update(content).digest("hex"),
      importance: THOUGHT_IMPORTANCE,
      metadata: { kind: "workspace-thought", bidKind: winner.kind, source: "global-workspace" },
    });
    // Broadcast on the existing idle-thought event so the frontend ticker
    // shows directed cognition the same way it shows idle sampling.
    try {
      getEventBus().emit({
        kind: "idle-thought",
        memoryId: memory.id,
        preview: thought.slice(0, 160),
        importance: THOUGHT_IMPORTANCE,
        reason: `workspace:${winner.kind}`,
        at: nowIso(),
      });
    } catch (err) {
      surfaceError("workspace.emit", err);
    }
    return { bids: bids.length, winner, memoryId: memory.id, thought };
  } catch (err) {
    surfaceError("workspace.microThought", err);
    return { bids: bids.length, winner, memoryId: null, thought: null, reason: "micro-thought failed" };
  }
}
