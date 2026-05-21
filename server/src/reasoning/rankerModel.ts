// Pure logistic-regression learning-to-rank core. NO db / io imports so it can
// be unit-checked in isolation (server/scripts/ranker-selfcheck.ts).
//
// Label signal: at the pipeline learning step we know which retrieved memories
// the model actually cited ([m:<id>] markers validated against the shown set).
// That is implicit relevance feedback; this is a pointwise LTR model over it.
//
// Bump FEATURE_VERSION whenever the feature layout changes — loadRankerState()
// drops stale weights instead of feeding them through a new feature vector.

export const FEATURE_VERSION = 1;
export const FEATURE_DIM = 8; // index 0 is the bias term

export interface RankFeatureInput {
  vecScore: number; // 0..1 vector similarity (1/(1+distance))
  ageDays: number; // >= 0, days since updatedAt
  importance: number; // 0..1
  sourceType: string; // 'conversation' | 'chunk' | 'manual'
  hasProject: boolean;
  contentLength: number; // chars
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function recencyOf(ageDays: number): number {
  return 1 / (1 + Math.max(0, ageDays) / 14); // ~14-day half-life
}

export function toFeatureVector(input: RankFeatureInput): number[] {
  return [
    1, // bias
    clamp01(input.vecScore),
    clamp01(recencyOf(input.ageDays)),
    clamp01(input.importance),
    input.sourceType === "conversation" ? 1 : 0,
    input.sourceType === "chunk" ? 1 : 0,
    input.hasProject ? 1 : 0,
    clamp01(input.contentLength / 2000),
  ];
}

export function zeroWeights(): number[] {
  return new Array(FEATURE_DIM).fill(0);
}

export function sigmoid(z: number): number {
  // Numerically stable both directions.
  if (z >= 0) {
    return 1 / (1 + Math.exp(-z));
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

export function predictProb(weights: number[], x: number[]): number {
  let z = 0;
  for (let i = 0; i < x.length; i += 1) {
    z += weights[i] * x[i];
  }
  return sigmoid(z);
}

// Heuristic fallback — byte-identical to the original applyBoosts() formula so
// a cold ranker (alpha = 0) reproduces prior behaviour exactly.
export function heuristicScore(input: RankFeatureInput): number {
  return (
    clamp01(input.vecScore) * 0.7 +
    recencyOf(input.ageDays) * 0.15 +
    clamp01(input.importance) * 0.15
  );
}

const WEIGHT_CLIP = 8;

// One L2-regularised logistic-regression SGD step. Returns a NEW weight array
// (callers treat weights as immutable). Bias (index 0) is not regularised.
// Any non-finite update aborts the step (divergence guard) — weights unchanged.
export function sgdStep(
  weights: number[],
  x: number[],
  y: number,
  lr: number,
  l2: number,
): number[] {
  const p = predictProb(weights, x);
  const err = y - p;
  const next = weights.slice();
  for (let i = 0; i < next.length; i += 1) {
    const reg = i === 0 ? 0 : l2 * weights[i];
    let w = weights[i] + lr * (err * x[i] - reg);
    if (!Number.isFinite(w)) {
      return weights.slice(); // divergence guard
    }
    if (w > WEIGHT_CLIP) w = WEIGHT_CLIP;
    if (w < -WEIGHT_CLIP) w = -WEIGHT_CLIP;
    next[i] = w;
  }
  return next;
}

// Mean log-loss over a labelled set — used by the self-check to assert the
// model actually learns (loss must fall on synthetic ground truth).
export function logLoss(
  weights: number[],
  samples: Array<{ x: number[]; y: number }>,
): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const { x, y } of samples) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, predictProb(weights, x)));
    sum += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  return sum / samples.length;
}
