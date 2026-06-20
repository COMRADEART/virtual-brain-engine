// Active inference (C3) — the keystone loop-closure.
//
// predictiveProcessing.ts MEASURES surprise after the fact and pulses
// norepinephrine. This module turns that into a CONTROL loop: before retrieval,
// estimate the EXPECTED FREE ENERGY of answering now (how surprised/uncertain do
// we expect to be?), and if it's high, take an EPISTEMIC ACTION to reduce it —
// broaden recall and/or augment the web — choosing among the levers the pipeline
// already has. After the cycle, fold the REALISED surprise back into a small
// learned linear model so the policy gets better at knowing WHEN foraging pays.
//
// Two invariants make this safe to enable on the hot path:
//   1. NO-REGRESSION FLOOR — below WARM_AT learning updates the policy returns
//      `defer` (broaden=false, augment=false), so a cold brain behaves EXACTLY
//      like today's heuristics. The bandit/adaptiveDepth warm-start pattern.
//   2. EGRESS-SAFE — `augment` is only a VOTE; the pipeline still gates real web
//      egress on hybridEnabled() (LOCAL_ONLY). This module never touches the
//      network; it's pure math + one brain_metadata KV row.
//
// All math is pure-exported for the selfcheck; persistence is one brain_metadata
// JSON row (no migration), failure-isolated like predictiveProcessing/adaptive.

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import type {
  ActiveInferenceContext,
  ActiveInferencePolicy,
  ActiveInferenceDecision,
} from "../../../shared/activeInference.js";
import type { RetrievalPrediction } from "./predictiveProcessing.js";

// Feature vector for the learned surprise model: [bias, retrievalGap,
// uncertainty, arousal, cholinergic, energyDeficit]. All terms in 0..1.
export const FEATURE_DIM = 6;
export const WARM_AT = 20; // learning updates before the policy may act
export const BROADEN_THRESHOLD = 0.55;
export const AUGMENT_THRESHOLD = 0.7; // costlier (egress) → needs higher EFE
const LR = 0.05;
const WEIGHT_CLAMP = 4;
const BASELINE_NE = 0.2; // matches neuromodulators BASELINE
const BASELINE_ACH = 0.2;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function emptyActiveInferencePolicy(): ActiveInferencePolicy {
  return { weights: new Array<number>(FEATURE_DIM).fill(0), observations: 0 };
}

// Build the context from the retrieval prediction + the cycle's affective state.
// `arousal`/`cholinergic` are passed as RAW levels and folded to above-baseline
// here so the caller doesn't need the baselines.
export function buildActiveInferenceContext(input: {
  prediction: RetrievalPrediction | null;
  uncertainty: number;
  norepinephrine: number;
  acetylcholine: number;
  energyDeficit?: number;
}): ActiveInferenceContext {
  const p = input.prediction;
  return {
    expectedTopScore: p && p.basis !== "none" ? clamp01(p.expectedTopScore) : 0,
    expectedConfidence: p && p.basis !== "none" ? clamp01(p.expectedConfidence) : 0,
    uncertainty: clamp01(input.uncertainty),
    arousal: clamp01(input.norepinephrine - BASELINE_NE),
    cholinergic: clamp01(input.acetylcholine - BASELINE_ACH),
    energyDeficit: clamp01(input.energyDeficit ?? 0),
  };
}

export function features(ctx: ActiveInferenceContext): number[] {
  return [
    1, // bias
    1 - ctx.expectedTopScore, // retrieval gap — weak expected recall → forage
    ctx.uncertainty,
    ctx.arousal,
    ctx.cholinergic,
    ctx.energyDeficit,
  ];
}

// The INSTINCT term: a hand-shaped expected-free-energy estimate from the context
// alone (used even before the policy is warm, blended with the learned term once
// it is). Low energy dampens willingness to forage (holding is cheaper).
export function expectedFreeEnergy(ctx: ActiveInferenceContext): number {
  const raw =
    0.45 * (1 - ctx.expectedTopScore) +
    0.25 * ctx.uncertainty +
    0.2 * ctx.arousal +
    0.1 * ctx.cholinergic;
  return clamp01(raw * (1 - 0.3 * ctx.energyDeficit));
}

// The LEARNED term: predicted surprise from context, sigmoid(w·x) in 0..1.
export function predictSurprise(ctx: ActiveInferenceContext, policy: ActiveInferencePolicy): number {
  const x = features(ctx);
  let z = 0;
  for (let i = 0; i < FEATURE_DIM; i += 1) z += (policy.weights[i] ?? 0) * x[i];
  return sigmoid(z);
}

export function decideActiveInference(
  ctx: ActiveInferenceContext,
  policy: ActiveInferencePolicy,
): ActiveInferenceDecision {
  const efe = expectedFreeEnergy(ctx);
  // NO-REGRESSION FLOOR: until warm, defer entirely to the heuristics.
  if (policy.observations < WARM_AT) {
    return { broaden: false, augment: false, acted: false, action: "defer", efe };
  }
  // Blend instinct + the learned surprise model.
  const score = 0.5 * efe + 0.5 * predictSurprise(ctx, policy);
  const broaden = score >= BROADEN_THRESHOLD;
  const augment = score >= AUGMENT_THRESHOLD;
  return {
    broaden,
    augment,
    acted: broaden || augment,
    action: augment ? "forage+web" : broaden ? "broaden" : "hold",
    efe,
  };
}

// LMS update of the surprise model toward the REALISED surprise. Pure → new policy.
export function learnActiveInference(
  policy: ActiveInferencePolicy,
  ctx: ActiveInferenceContext,
  realizedSurprise: number,
): ActiveInferencePolicy {
  const x = features(ctx);
  const p = predictSurprise(ctx, policy);
  const err = clamp01(realizedSurprise) - p;
  const weights = policy.weights.slice(0, FEATURE_DIM);
  while (weights.length < FEATURE_DIM) weights.push(0);
  for (let i = 0; i < FEATURE_DIM; i += 1) {
    const w = (weights[i] ?? 0) + LR * err * x[i];
    weights[i] = Math.max(-WEIGHT_CLAMP, Math.min(WEIGHT_CLAMP, w));
  }
  return { weights, observations: policy.observations + 1 };
}

// -----------------------------------------------------------------------------
// Persistence (brain_metadata KV) — failure-isolated.
// -----------------------------------------------------------------------------

const META_KEY = "active-inference-v1";

export function loadActiveInferenceState(): ActiveInferencePolicy {
  try {
    const row = openDb()
      .prepare("SELECT value FROM brain_metadata WHERE key = ?")
      .get(META_KEY) as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<ActiveInferencePolicy>;
      if (Array.isArray(parsed.weights) && typeof parsed.observations === "number") {
        const weights = parsed.weights.slice(0, FEATURE_DIM).map((w) => (Number.isFinite(w) ? w : 0));
        while (weights.length < FEATURE_DIM) weights.push(0);
        return { weights, observations: Math.max(0, parsed.observations) };
      }
    }
  } catch (err) {
    surfaceError("activeInference.load", err);
  }
  return emptyActiveInferencePolicy();
}

export function saveActiveInferenceState(policy: ActiveInferencePolicy): void {
  try {
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(META_KEY, JSON.stringify(policy));
  } catch (err) {
    surfaceError("activeInference.save", err);
  }
}
