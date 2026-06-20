// Active inference (C3) — contracts. Zero runtime deps.
//
// The brain already MEASURES surprise (reasoning/predictiveProcessing.ts). Active
// inference closes that loop: it ACTS to minimise EXPECTED free energy — when it
// predicts retrieval will be weak / uncertain / arousing, it forages for more
// evidence (broaden recall, augment the web) BEFORE answering, and learns from
// the realised surprise which contexts actually warranted foraging.

export interface ActiveInferenceContext {
  /** Predicted top retrieval score (from predictiveProcessing), 0..1. */
  expectedTopScore: number;
  /** Predicted confidence, 0..1. */
  expectedConfidence: number;
  /** Prior-cycle uncertainty (1 − last confidence), 0..1. */
  uncertainty: number;
  /** Norepinephrine arousal ABOVE baseline, 0..1. */
  arousal: number;
  /** Acetylcholine (uncertainty tone) ABOVE baseline, 0..1. */
  cholinergic: number;
  /** Metabolic deficit, 0..1 (0 = full energy, 1 = depleted). Dampens foraging. */
  energyDeficit: number;
}

export interface ActiveInferencePolicy {
  /** Linear weights of the learned surprise model (length = FEATURE_DIM). */
  weights: number[];
  /** Number of learning updates folded in (drives the warm-start floor). */
  observations: number;
}

export interface ActiveInferenceDecision {
  /** Vote to broaden retrieval (multi-query) to gather more evidence. */
  broaden: boolean;
  /** Vote to augment with the web (still gated by LOCAL_ONLY/hybrid downstream). */
  augment: boolean;
  /** True when the policy chose any epistemic action (not the warm-start floor). */
  acted: boolean;
  /** Short label for the memory-step detail line. */
  action: "hold" | "broaden" | "forage+web" | "defer";
  /** The expected-free-energy estimate that drove the decision, 0..1. */
  efe: number;
}
