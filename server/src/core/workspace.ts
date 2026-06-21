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
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { pendingIdeasForWorkspace, markSurfaced } from "./creativity.js";
import { gatherEmotions, dominantEmotion } from "./emotions.js";
import { getNeuromodulators, underStress } from "./neuromodulators.js";
import { CONFIG } from "../config.js";
import { currentEnergyBudget } from "./energyBudget.js";
import { isFeatureActive } from "./maturation.js";

export type WorkspaceBidKind =
  | "open-question"
  | "curiosity"
  | "goal"
  | "belief"
  | "creative"
  | "memory"
  | "emotion"
  | "safety";

// Global Workspace Theory framed as named competing CORTICES. The existing four
// bidders ARE faculties; this names them and adds the missing four so the single
// conscious slot is contested across the brain's facets, not just its questions.
export type CortexName =
  | "Reasoning" // open questions + curiosity frontier
  | "Reflection" // re-examining shaken beliefs
  | "Planning" // the next actionable goal step
  | "Creativity" // a fresh distant-concept recombination
  | "Memory" // a low-coherence cluster that wants consolidating
  | "Emotion" // a strong felt state that wants processing
  | "Safety"; // a stress / contradiction signal that should pre-empt idle thought

export interface WorkspaceBid {
  id: string;
  kind: WorkspaceBidKind;
  label: string;
  /** [0,1] — what the bid is worth this round. */
  salience: number;
  /** Which named cortex raised this bid (optional; for display + per-cortex thought). */
  cortex?: CortexName;
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
// New-cortex scales. Safety can PRE-EMPT idle cognition (a stress/contradiction
// signal deserves the slot); Emotion follows; Creativity bids modestly; Memory
// (background consolidation) only wins an otherwise-quiet round.
export const SAFETY_SCALE = 0.95;
export const EMOTION_SCALE = 0.75;
export const CREATIVITY_BID_SCALE = 0.6;
export const MEMORY_BID_SCALE = 0.4;
// Floors so the new cortices are a STRICT no-op on a cold/calm brain.
export const EMOTION_BID_FLOOR = 0.6; // dominant-emotion intensity to bother
export const CLUSTER_COHERENCE_FLOOR = 0.45; // only a genuinely incoherent cluster bids

const MICRO_THOUGHT_SYSTEM = `You are the idle reflection process of a personal knowledge brain. You get ONE item the brain decided deserves a moment of thought. Think exactly one step: produce either (a) a 2-3 sentence insight that makes progress on it, or (b) ONE sharper, more answerable reformulation of the question. Output plain text only — no preamble, no JSON.`;

// Per-cortex flavor appended to the micro-thought system prompt so the winning
// faculty thinks in its own register. Optional — a bid with no cortex uses base.
const CORTEX_SUFFIX: Record<CortexName, string> = {
  Reasoning: " Reason it through one careful step.",
  Reflection: " Weigh the evidence for and against, honestly.",
  Planning: " Name the single next concrete step.",
  Creativity: " Push the unexpected connection one step further.",
  Memory: " Consolidate: state the one durable thing worth keeping.",
  Emotion: " Acknowledge the feeling, then say what it's telling you.",
  Safety: " Be cautious: name the risk and how to avoid harm.",
};

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
          cortex: "Reasoning",
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
        cortex: "Reasoning",
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
        cortex: "Reflection",
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
          cortex: "Planning",
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
          cortex: "Planning",
        });
      }
    }
  } catch (err) {
    surfaceError("workspace.bids.goals", err);
  }

  // CREATIVITY cortex — a fresh distant-concept recombination wants developing.
  // Only fires when creativity has produced pending ideas (so a strict no-op
  // unless CREATIVITY is enabled and has run).
  try {
    for (const idea of pendingIdeasForWorkspace(2)) {
      bids.push({
        id: `creative-${idea.id}`,
        kind: "creative",
        label: `Develop this creative connection further: ${idea.idea}`,
        salience: clamp01(CREATIVITY_BID_SCALE * (0.5 + 0.5 * idea.novelty)),
        cortex: "Creativity",
      });
    }
  } catch (err) {
    surfaceError("workspace.bids.creativity", err);
  }

  // MEMORY cortex — a low-coherence cluster that would benefit from
  // consolidation. Only an otherwise-quiet round; no row / no incoherent
  // cluster → no bid (cold no-op).
  try {
    const row = openDb()
      .prepare(
        `SELECT topic, coherence FROM memory_clusters WHERE coherence < ? ORDER BY coherence ASC LIMIT 1`,
      )
      .get(CLUSTER_COHERENCE_FLOOR) as { topic: string; coherence: number } | undefined;
    if (row && row.topic) {
      bids.push({
        id: `memory-${row.topic.slice(0, 24)}`,
        kind: "memory",
        label: `My memories about "${row.topic}" are fragmented (coherence ${row.coherence.toFixed(2)}). What is the unifying thread?`,
        salience: clamp01(MEMORY_BID_SCALE * (1 - row.coherence)),
        cortex: "Memory",
      });
    }
  } catch (err) {
    surfaceError("workspace.bids.memory", err);
  }

  // EMOTION cortex — a strong felt state wants processing. Strict no-op on a
  // calm brain (dominant emotion below the floor).
  try {
    const dom = dominantEmotion(gatherEmotions());
    if (dom.value >= EMOTION_BID_FLOOR) {
      bids.push({
        id: `emotion-${dom.name}`,
        kind: "emotion",
        label: `I notice I feel ${dom.name} right now (${dom.value.toFixed(2)}). What is driving it, and does it change what I should attend to?`,
        salience: clamp01(EMOTION_SCALE * dom.value),
        cortex: "Emotion",
      });
    }
  } catch (err) {
    surfaceError("workspace.bids.emotion", err);
  }

  // SAFETY cortex — under stress (cortisol high: repeated contradictions / low
  // confidence), pre-empt idle cognition to ask what to be careful about. Strict
  // no-op at the low baseline. (This is the cortisol consumer.)
  try {
    if (underStress(getNeuromodulators().levels())) {
      bids.push({
        id: "safety-stress",
        kind: "safety",
        label: `I am under stress — recent answers have been contradicted or low-confidence. What pattern is causing this, and what should I be careful about before answering more?`,
        salience: SAFETY_SCALE,
        cortex: "Safety",
      });
    }
  } catch (err) {
    surfaceError("workspace.bids.safety", err);
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
    // The winning cortex thinks in its own register (suffix optional).
    const system = winner.cortex ? MICRO_THOUGHT_SYSTEM + CORTEX_SUFFIX[winner.cortex] : MICRO_THOUGHT_SYSTEM;
    const thought = (await connector.send(winner.label, {
      system,
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
      metadata: { kind: "workspace-thought", bidKind: winner.kind, cortex: winner.cortex, source: "global-workspace" },
    });
    // A creative idea that reached consciousness is marked surfaced so it stops
    // re-bidding every round.
    if (winner.cortex === "Creativity" && winner.id.startsWith("creative-")) {
      markSurfaced(winner.id.slice("creative-".length));
    }
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

// -----------------------------------------------------------------------------
// Event-driven activation (H4) — phasic cognition, not just the tonic timer.
// -----------------------------------------------------------------------------
// GWT predicts rapid, salience-driven conscious switching: a high-salience event
// (a new open question, a contested belief, an immune/safety signal, a big
// prediction surprise) should be able to GRAB the conscious slot off-cadence
// instead of waiting up to 10 minutes for the next tick. requestWorkspaceCycle is
// that path, bounded so it can't thrash — a REFRACTORY period between event
// cycles, an energy gate (a depleted brain rests), and the connector requirement
// runWorkspaceCycle already enforces. The tonic timer in brainCore is unchanged;
// this ADDS phasic activation. OFF by default (CONFIG.workspaceEventDriven).

export const WORKSPACE_REFRACTORY_MS = 45_000;
let lastEventCycleAt = 0;

export async function requestWorkspaceCycle(
  reason: string,
  opts: WorkspaceOptions = {},
  nowMs: number = Date.now(),
): Promise<WorkspaceReport | null> {
  // Loop-closer routed through maturation (H2): a matured brain (stage ≥ 7)
  // earns reactive consciousness even with the static flag off. The tonic timer
  // is unchanged; this only ADDS phasic activation, bounded below.
  if (!isFeatureActive("event-workspace")) return null;
  // Refractory — anti-thrash: at most one event-triggered cycle per window.
  if (nowMs - lastEventCycleAt < WORKSPACE_REFRACTORY_MS) return null;
  // Energy (H1) — a depleted brain rests its discretionary cognition.
  if (CONFIG.energyBudget && !currentEnergyBudget().mayRunOptional) return null;
  lastEventCycleAt = nowMs;
  try {
    return await runWorkspaceCycle(opts);
  } catch (err) {
    surfaceError("workspace.requestCycle", err);
    return null;
  }
}

/** Selfcheck hook — reset the refractory clock. */
export function _resetWorkspaceEventForTest(): void {
  lastEventCycleAt = 0;
}
