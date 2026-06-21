// Scientific reasoning — the hypothesis lifecycle.
//
// Pure type contract (zero runtime deps). The engine lives in
// server/src/core/hypotheses.ts and rides the existing causal world model +
// belief engine: observe → hypothesize → (cheap, ledger-read) test → evaluate →
// keep (promote to a belief) / retire. It runs on the sleep cadence, so the hot
// /api/ask path is untouched.

export type HypothesisStatus =
  | "open" // formed, not yet tested
  | "testing" // some evidence, not yet conclusive
  | "supported" // evidence backs it → promoted to a belief
  | "refuted" // evidence is against it
  | "retired"; // stale / superseded (never deleted)

export interface Hypothesis {
  id: string;
  statement: string;
  status: HypothesisStatus;
  /** How many cheap tests supported it. */
  supportObs: number;
  /** How many cheap tests refuted it. */
  refuteObs: number;
  /** Laplace-smoothed P(true), [0,1]. */
  confidence: number;
  /** If derived from a belief, its id (provenance). */
  sourceBeliefId: string | null;
  /** If a causal hypothesis, the cause/effect classes it tests. */
  causeClass: string | null;
  effectClass: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface HypothesisStats {
  total: number;
  open: number;
  testing: number;
  supported: number;
  refuted: number;
  retired: number;
  avgConfidence: number;
}
