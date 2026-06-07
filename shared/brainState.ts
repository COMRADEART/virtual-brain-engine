// Central cognitive loop / unified Brain State contract (zero runtime deps —
// pure types + plain constants, like shared/organism.ts).
//
// STAR already implemented attention (attention/saliency.ts), goals (organism),
// confidence (the pipeline's error step) and learning (the ranker) — but as
// ISOLATED subsystems with no shared state and no closed loop. This is the
// unified, persistent state the central cognitive loop reads and writes so that
// reasoning OUTPUT feeds forward across queries:
//
//   perceive → attend → reason → record → [low? flag open-question] → next cycle
//
// Surfaced by GET /api/brain/state and broadcast on the bus as
// { type: "brain-state" } so the 3D scene + the BrainStatePanel update live.

export type WorkingItemKind = "query" | "goal" | "fact" | "observation" | "open-question";

export interface WorkingItem {
  id: string;
  /** Short human-readable label (query head, salient token, or open question). */
  label: string;
  kind: WorkingItemKind;
  /** Decays toward 0 each idle tick; evicted below WORKING_FLOOR. [0,1]. */
  activation: number;
  at: string;
}

export interface AttentionFocus {
  /** Memory id the attention landed on. */
  id: string;
  /** Truncated preview of the memory content. */
  label: string;
  /** The blended saliency score [0,1] (attention/saliency.ts). */
  score: number;
  /** Per-signal saliency contributions; each clamped to [0,1] by computeSaliency. */
  breakdown: {
    novelty: number; // [0,1]
    goalRelevance: number; // [0,1]
    emotion: number; // [0,1]
    survival: number; // [0,1]
    uncertainty: number; // [0,1]
  };
}

export interface GoalNode {
  title: string;
  status: string;
  /** 0..100; higher = more attention budget. */
  priority: number;
}

export interface BrainLearningMetrics {
  rankerWarm: boolean;
  rankerAlpha: number;
  trainedCount: number;
  /** Most-recent ranker training loss, null before the first update. */
  lossLast: number | null;
  feedbackUp: number;
  feedbackDown: number;
}

export interface BrainCycle {
  prompt: string;
  citedCount: number;
  confidence: number;
  /** Did this cycle trip the low-confidence metacognition flag? */
  lowConfidence: boolean;
  at: string;
}

export interface BrainStateSnapshot {
  /** Top-K attention foci from the last retrieval, score-desc. */
  attention: AttentionFocus[];
  /** Bounded, decaying working-memory workspace. */
  workingMemory: WorkingItem[];
  /** Active goals (from the organism) the loop is steering toward. */
  goals: GoalNode[];
  /** Last cycle's error-step confidence [0,1]. */
  confidence: number;
  /** 1 - confidence: fed FORWARD into the next retrieval's saliency uncertainty. */
  priorUncertainty: number;
  learning: BrainLearningMetrics;
  lastCycle: BrainCycle | null;
  /** Total cognitive cycles closed (persisted). */
  cycles: number;
  updatedAt: string;
}

// Working-memory bounds. Miller's 7±2 on the server; the renderer's own working
// memory (src/engine/MemorySystem.ts) uses Cowan's 4 — deliberately separate.
export const WORKING_CAPACITY = 7;
/** Evict a working item once its activation decays below this. */
export const WORKING_FLOOR = 0.08;
/** Fraction of activation lost per minute of idle (compounding). */
export const WORKING_DECAY_PER_MIN = 0.5;

// Below this last-cycle confidence the loop flags an open question (DEFERRED
// metacognition: surfaces as raised priorUncertainty on the NEXT cycle rather
// than re-running steps inside the live SSE stream).
export const RE_REASON_CONFIDENCE_FLOOR = 0.35;
