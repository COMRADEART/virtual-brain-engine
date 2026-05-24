// cognitionTypes — shared contracts for the higher-cognition layer
// ================================================================
//
// Pure types + small constants for the System 2 / arbitration / reinforcement /
// meta-learning stack. No runtime behaviour lives here, so every cognition module
// can import these without creating dependency cycles.

import type { BrainRegionId } from "../types";
import type { CognitiveGenome } from "../../../shared/brainSnapshot";

/** Re-export the persisted genome under the engine-local name the spec uses. */
export type Genome = CognitiveGenome;

/** Which thinking system is currently in control. */
export type CognitiveMode = "system1" | "system2" | "hybrid";

/** Affective state: a 2-D valence/arousal model (the circumplex). */
export interface Affect {
  /** −1 (negative) … +1 (positive). Shaped by reward prediction error. */
  valence: number;
  /** 0 (calm) … 1 (aroused). Shaped by surprise / free energy. */
  arousal: number;
}

/** The arbiter's per-frame decision about whether to deliberate. */
export interface ArbitrationDecision {
  mode: CognitiveMode;
  engageSystem2: boolean;
  /** Time budget (ms) granted to System 2 this frame. */
  budgetMs: number;
  /** The scalar uncertainty signal that drove the decision (for the HUD). */
  uncertainty: number;
}

/** A single operator's contribution within one deliberation pass. */
export interface ReasoningStep {
  kind: "analogy" | "counterfactual" | "theory-of-mind";
  /** Human-readable line for the introspection/explanation trace. */
  explain: string;
  /** Regions this step recommends biasing (top-down attention). */
  biasRegions: BrainRegionId[];
  /** Strength of the recommended bias [0,1]. */
  biasStrength: number;
  /** This step's confidence in its own conclusion [0,1]. */
  confidence: number;
}

/** The product of one bounded, time-sliced deliberation. */
export interface ReasoningResult {
  /** How many operators completed within budget (the "reasoning depth"). */
  depth: number;
  /** Aggregate confidence [0,1]. */
  confidence: number;
  /** Concatenated introspection trace — the "why" the brain can report. */
  explanation: string;
  /** Regions to bias in System 1 as a consequence of deliberating. */
  biasRegions: BrainRegionId[];
  biasStrength: number;
}

/** An extrinsic reward event reported by the app / pipeline. */
export interface RewardSignal {
  value: number;
  reason: string;
}

/** A composite-IQ report, with the sub-scores exposed for scrutiny. */
export interface IQReport {
  /** Composite "effective IQ", scaled to ~mean 100 / sd 15 for legibility. */
  value: number;
  /** Each named sub-score, normalised to ~[0,1], that fed the composite. */
  components: Record<string, number>;
  /**
   * Held-out PROBE score — reported but deliberately EXCLUDED from the
   * meta-optimiser's fitness, as an anti-Goodhart canary. If composite IQ rises
   * while probe stalls/falls, the meta-learner is gaming the metric.
   */
  probe: number;
  /** Number of evaluation episodes that have contributed so far. */
  samples: number;
}

/** Inclusive bounds the meta-learner clamps each genome gene to. */
export const GENOME_BOUNDS: Record<keyof Genome, readonly [number, number]> = {
  explorationTemp: [0.05, 1.0],
  curiosityWeight: [0.0, 1.5],
  arbitrationThreshold: [0.2, 0.9],
  system2BudgetMs: [0.5, 2.0],
  plasticityScale: [0.5, 2.0],
  dopamineBaseline: [0.1, 0.6],
  acetylcholineBaseline: [0.2, 0.6],
};

/** A sane, conservative starting genome (matches the engine's stable defaults). */
export function defaultGenome(): Genome {
  return {
    explorationTemp: 0.3,
    curiosityWeight: 0.6,
    arbitrationThreshold: 0.5,
    system2BudgetMs: 1.2,
    plasticityScale: 1.0,
    dopamineBaseline: 0.3,
    acetylcholineBaseline: 0.4,
  };
}

/** Clamp a candidate genome back inside GENOME_BOUNDS (mutates a copy). */
export function clampGenome(g: Genome): Genome {
  const out = { ...g };
  for (const key of Object.keys(GENOME_BOUNDS) as Array<keyof Genome>) {
    const [lo, hi] = GENOME_BOUNDS[key];
    const v = out[key];
    out[key] = v < lo ? lo : v > hi ? hi : v;
  }
  return out;
}
