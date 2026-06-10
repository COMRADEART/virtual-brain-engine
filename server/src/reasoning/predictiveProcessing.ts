// Predictive processing — the brain predicts its OWN retrieval, and the
// prediction ERROR (surprise) becomes a unified, self-supervised learning
// signal. This is the predictive-coding view of cortex applied to the one
// thing this server does constantly: answer from memory.
//
// Before the memory step runs, predict how well retrieval will go (expected
// top vec-score + expected confidence) from running EMAs — one global, one per
// coarse query bucket. After the cycle closes, compare prediction to reality:
//
//   surprise   — |actual − expected|, blended over both axes. Consumers:
//                norepinephrine pulse (arousal), and a boost to the novelty
//                channel that storage-time novelty alone can't see.
//   knowledge  — "expected to KNOW this and didn't" (predicted strong
//   gap         retrieval, got weak) is the precise curiosity trigger: the
//                pipeline pushes an open-question working item so the gap is
//                held in working memory instead of silently dropped.
//
// Dense and self-supervised — every /api/ask trains it, no thumbs needed
// (the same lesson the RL controller's citation reward encodes).
//
// Pure math exported for the selfcheck; persistence is one brain_metadata JSON
// row (the adaptive-layer pattern, no migration); every consumer degrades to
// "no prediction → zero surprise → no perturbation" on a cold or broken store.

import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { tokens } from "../attention/saliency.js";

export interface EmaStat {
  topScore: number;
  confidence: number;
  count: number;
}

export interface PredictiveState {
  global: EmaStat;
  /** Coarse query-topic buckets (stable token hash mod BUCKETS). */
  buckets: Record<string, EmaStat>;
  observations: number;
}

export interface RetrievalPrediction {
  expectedTopScore: number;
  expectedConfidence: number;
  basis: "bucket" | "global" | "none";
}

export interface SurpriseReport {
  /** Blended prediction error in [0,1]. 0 when there was no prediction. */
  surprise: number;
  /** Predicted strong retrieval, observed weak — the curiosity trigger. */
  knowledgeGap: boolean;
}

export const EMA_ALPHA = 0.2;
export const BUCKETS = 16;
// Minimum observations before a stat is trusted as a prediction.
export const MIN_BUCKET_OBS = 3;
export const MIN_GLOBAL_OBS = 5;
// Knowledge-gap thresholds: expected ≥ KNOW_FLOOR but actual ≤ GAP_CEIL.
export const KNOW_FLOOR = 0.5;
export const GAP_CEIL = 0.3;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function emptyPredictiveState(): PredictiveState {
  return { global: { topScore: 0, confidence: 0, count: 0 }, buckets: {}, observations: 0 };
}

// -----------------------------------------------------------------------------
// PURE helpers.
// -----------------------------------------------------------------------------

/** Stable FNV-1a token-set hash → bucket key. Deterministic across processes. */
export function bucketFor(query: string): string {
  const ts = Array.from(new Set(tokens(query))).sort();
  let h = 2166136261;
  for (const t of ts) {
    for (let i = 0; i < t.length; i += 1) {
      h ^= t.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x9e3779b9;
  }
  return `b${(h >>> 0) % BUCKETS}`;
}

/** Predict retrieval quality. Bucket wins when warm, else global, else none. */
export function predictRetrieval(state: PredictiveState, query: string): RetrievalPrediction {
  const bucket = state.buckets[bucketFor(query)];
  if (bucket && bucket.count >= MIN_BUCKET_OBS) {
    return { expectedTopScore: clamp01(bucket.topScore), expectedConfidence: clamp01(bucket.confidence), basis: "bucket" };
  }
  if (state.global.count >= MIN_GLOBAL_OBS) {
    return { expectedTopScore: clamp01(state.global.topScore), expectedConfidence: clamp01(state.global.confidence), basis: "global" };
  }
  return { expectedTopScore: 0, expectedConfidence: 0, basis: "none" };
}

/** Prediction error → surprise + knowledge-gap flag. Pure. */
export function computeSurprise(
  prediction: RetrievalPrediction,
  actual: { topScore: number; confidence: number },
): SurpriseReport {
  if (prediction.basis === "none") {
    return { surprise: 0, knowledgeGap: false };
  }
  const topErr = Math.abs(clamp01(actual.topScore) - prediction.expectedTopScore);
  const confErr = Math.abs(clamp01(actual.confidence) - prediction.expectedConfidence);
  const surprise = clamp01(0.6 * topErr + 0.4 * confErr);
  const knowledgeGap =
    prediction.expectedTopScore >= KNOW_FLOOR && clamp01(actual.topScore) <= GAP_CEIL;
  return { surprise, knowledgeGap };
}

function emaUpdate(stat: EmaStat, topScore: number, confidence: number): EmaStat {
  if (stat.count === 0) {
    return { topScore: clamp01(topScore), confidence: clamp01(confidence), count: 1 };
  }
  return {
    topScore: clamp01(stat.topScore + EMA_ALPHA * (clamp01(topScore) - stat.topScore)),
    confidence: clamp01(stat.confidence + EMA_ALPHA * (clamp01(confidence) - stat.confidence)),
    count: stat.count + 1,
  };
}

/** Fold one observed cycle into the model. Pure — returns a new state. */
export function observeRetrieval(
  state: PredictiveState,
  query: string,
  actual: { topScore: number; confidence: number },
): PredictiveState {
  const key = bucketFor(query);
  return {
    global: emaUpdate(state.global, actual.topScore, actual.confidence),
    buckets: { ...state.buckets, [key]: emaUpdate(state.buckets[key] ?? { topScore: 0, confidence: 0, count: 0 }, actual.topScore, actual.confidence) },
    observations: state.observations + 1,
  };
}

// -----------------------------------------------------------------------------
// Persistence (brain_metadata KV) — failure-isolated.
// -----------------------------------------------------------------------------

const META_KEY = "predictive-model-v1";

export function loadPredictiveState(): PredictiveState {
  try {
    const row = openDb()
      .prepare("SELECT value FROM brain_metadata WHERE key = ?")
      .get(META_KEY) as { value: string } | undefined;
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<PredictiveState>;
      if (parsed.global && parsed.buckets && typeof parsed.observations === "number") {
        return parsed as PredictiveState;
      }
    }
  } catch (err) {
    surfaceError("predictive.load", err);
  }
  return emptyPredictiveState();
}

export function savePredictiveState(state: PredictiveState): void {
  try {
    openDb()
      .prepare(
        "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      )
      .run(META_KEY, JSON.stringify(state));
  } catch (err) {
    surfaceError("predictive.save", err);
  }
}
