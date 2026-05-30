// GENUINE, MEASURED evolution of the learned ranker weights.
//
// This module REPLACES the fabricated fitness of `improveMetrics()` in
// `core/evolution.ts`. That stub "evolves" by adding FIXED POSITIVE PATCHES
// (e.g. { planningEfficiency: 0.05, reliability: 0.03 }) to fabricated metrics —
// nothing is measured, every "mutation" is hardcoded to improve, so it can
// never regress and never actually learns. Fake evolution.
//
// Here, fitness is REAL cross-entropy loss (logLoss) on the brain's OWN labelled
// data: the `rank_training_log` rows, where each retrieved memory's 8-dim
// feature vector is labelled cited=1 / not-cited=0 (implicit relevance feedback
// from which memories the answer actually cited). A seeded (1+λ) evolution
// strategy searches the 8-dim weight space; a challenger is PROMOTED to
// production ONLY when it STRICTLY beats the champion on a HELD-OUT split the
// optimizer never trained on — and only after a finite/bounded check AND the
// safety gate allows it. Champion/challenger means a bad mutation can never
// regress the running ranker. "Did it improve?" is therefore a real, held-out
// measurement, not a hardcoded patch.
//
// `evolveWeights` / `rankerFitness` are PURE (rankerModel only, no DB) so they
// are independently deterministic and unit-checkable. The orchestration layer
// (`optimizeRankerFromLog`) is the only DB-touching part and never throws into
// a route.

import { FEATURE_DIM, FEATURE_VERSION, logLoss, zeroWeights } from "../reasoning/rankerModel.js";
import { listRankTrainingLogs } from "../db/repositories/feedback.js";
import { loadRankerState, saveRankerState } from "../db/repositories/ranker.js";
import { __resetRankerCache } from "../reasoning/ranker.js";
import { createSafetyGate, type SafetyGate } from "./safety.js";
import { openDb } from "../db/sqlite.js";
import { ulid } from "ulid";

export type Sample = { x: number[]; y: number };

// Matches rankerModel.WEIGHT_CLIP — the search must stay inside the same box the
// online SGD learner does, or a promoted challenger could live outside the
// region the persisted-weights validator (loadRankerState) tolerates.
const WEIGHT_CLIP = 8;

// Seeded PRNG — byte-identical to scripts/ranker-selfcheck.ts so the search is
// reproducible: same seed + same samples => identical output.
function mulberry32(seed: number): () => number {
  return () => {
    let v = (seed += 0x6d2b79f5);
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard-normal sample via Box-Muller off a seeded uniform rng. Guards the
// log(0) singularity so an unlucky exact-zero uniform can't produce Inf/NaN.
function gaussian(rng: () => number): number {
  let u = rng();
  if (u <= 0) u = 1e-12; // ln(0) guard — keeps the draw finite
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clipWeight(w: number): number {
  if (w > WEIGHT_CLIP) return WEIGHT_CLIP;
  if (w < -WEIGHT_CLIP) return -WEIGHT_CLIP;
  return w;
}

// Fitness: HIGHER is better. Negative mean cross-entropy (so lower loss => higher
// fitness) minus a tiny L2 on the NON-bias weights, which keeps the search
// bounded on linearly-separable data (where unregularised logistic weights would
// run off to the clip box). Bias (index 0) is never penalised.
export function rankerFitness(weights: number[], samples: Sample[], l2 = 1e-3): number {
  const loss = logLoss(weights, samples);
  let penalty = 0;
  for (let i = 1; i < weights.length; i += 1) {
    penalty += weights[i] * weights[i];
  }
  return -loss - l2 * penalty;
}

export interface EvolveResult {
  weights: number[];
  fitness: number;
  generations: number;
}

// Pure, seeded (1+λ) evolution strategy / hill-climb. Each generation perturbs
// the incumbent λ times with Gaussian noise scaled by σ, clips every weight to
// ±8, and keeps the best-by-fitness candidate ONLY if it beats the incumbent.
// Non-finite candidate weights are rejected (divergence guard) so the returned
// weights are always finite and ±8-bounded, even on adversarial input.
export function evolveWeights(
  samples: Sample[],
  opts: {
    seed?: number;
    generations?: number;
    lambda?: number;
    sigma?: number;
    l2?: number;
    init?: number[];
  } = {},
): EvolveResult {
  const seed = opts.seed ?? 1;
  const generations = Math.max(0, Math.floor(opts.generations ?? 120));
  const lambda = Math.max(1, Math.floor(opts.lambda ?? 12));
  const sigma = opts.sigma ?? 0.4;
  const l2 = opts.l2 ?? 1e-3;

  const rng = mulberry32(seed);

  // Start from a clipped, finite copy of `init` (defaults to zeros).
  const start = opts.init && opts.init.length === FEATURE_DIM ? opts.init.slice() : zeroWeights();
  let incumbent = start.map((w) => (Number.isFinite(w) ? clipWeight(w) : 0));
  let incumbentFitness = rankerFitness(incumbent, samples, l2);

  for (let gen = 0; gen < generations; gen += 1) {
    let bestChild: number[] | null = null;
    let bestChildFitness = -Infinity;

    for (let k = 0; k < lambda; k += 1) {
      const child = incumbent.slice();
      let finite = true;
      for (let i = 0; i < child.length; i += 1) {
        const w = child[i] + sigma * gaussian(rng);
        if (!Number.isFinite(w)) {
          finite = false;
          break;
        }
        child[i] = clipWeight(w);
      }
      if (!finite) {
        continue; // reject divergent candidate, keep searching
      }
      const f = rankerFitness(child, samples, l2);
      if (f > bestChildFitness) {
        bestChildFitness = f;
        bestChild = child;
      }
    }

    // (1+λ) elitism: only adopt the best child if it STRICTLY beats the parent.
    if (bestChild && bestChildFitness > incumbentFitness) {
      incumbent = bestChild;
      incumbentFitness = bestChildFitness;
    }
  }

  return { weights: incumbent, fitness: incumbentFitness, generations };
}

export interface OptimizeResult {
  applied: boolean;
  reason: "applied" | "no-improvement" | "insufficient-data" | "safety-veto" | "non-finite" | "error";
  championFitness: number | null; // held-out fitness of starting weights
  challengerFitness: number | null; // held-out fitness of evolved weights
  heldoutDelta: number | null; // challenger - champion (on held-out)
  trainSamples: number;
  heldoutSamples: number;
}

// Deterministic Fisher-Yates shuffle of indices [0..n) using a seeded rng. Used
// to split train/heldout WITHOUT index-parity (parity can correlate with how the
// selfcheck appends rows, biasing the split).
function shuffledIndices(n: number, rng: () => number): number[] {
  const idx = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = idx[i];
    idx[i] = idx[j];
    idx[j] = tmp;
  }
  return idx;
}

// True iff the held-out slice contains at least one of each label (or the data
// is single-class overall, in which case logLoss is still well-defined and we
// accept any split).
function heldoutHasBothLabels(samples: Sample[], heldout: number[]): boolean {
  let pos = false;
  let neg = false;
  let allPos = true;
  let allNeg = true;
  for (const s of samples) {
    if (s.y === 1) allNeg = false;
    else allPos = false;
  }
  if (allPos || allNeg) return true; // single-class corpus: any split is fine
  for (const i of heldout) {
    if (samples[i].y === 1) pos = true;
    else neg = true;
    if (pos && neg) return true;
  }
  return false;
}

const PROMOTE_EPSILON = 1e-9;

// Orchestration. Loads the real labelled corpus, splits it deterministically,
// evolves from the current champion, and applies the challenger to production
// ONLY on a strict held-out win + finite/bounded weights + safety-gate allow.
// The ENTIRE body is wrapped in try/catch and returns reason:"error" on any
// throw — this must NEVER throw into the route handler.
export function optimizeRankerFromLog(
  opts: {
    seed?: number;
    generations?: number;
    lambda?: number;
    sigma?: number;
    minSamples?: number;
    gate?: SafetyGate;
  } = {},
): OptimizeResult {
  const seed = opts.seed ?? 1;
  const minSamples = opts.minSamples ?? 8;
  const gate = opts.gate ?? createSafetyGate();

  const fail = (
    reason: OptimizeResult["reason"],
    extra: Partial<OptimizeResult> = {},
  ): OptimizeResult => ({
    applied: false,
    reason,
    championFitness: null,
    challengerFitness: null,
    heldoutDelta: null,
    trainSamples: 0,
    heldoutSamples: 0,
    ...extra,
  });

  try {
    // 1. Flatten every persisted snapshot into labelled samples.
    const samples: Sample[] = [];
    for (const snap of listRankTrainingLogs()) {
      for (const [id, x] of snap.featuresById) {
        if (Array.isArray(x) && x.length === FEATURE_DIM && x.every((v) => Number.isFinite(v))) {
          samples.push({ x, y: snap.citedIds.has(id) ? 1 : 0 });
        }
      }
    }
    const total = samples.length;

    // 2. Not enough signal to learn anything trustworthy.
    if (total < minSamples) {
      return fail("insufficient-data", { trainSamples: total, heldoutSamples: 0 });
    }

    // 3. Deterministic ~70/30 split via a seeded shuffle (NOT index parity).
    const rng = mulberry32(seed ^ 0x9e3779b9);
    let order = shuffledIndices(total, rng);
    const heldoutCount = Math.max(1, Math.round(total * 0.3));
    const trainCount = total - heldoutCount;

    let trainIdx = order.slice(0, trainCount);
    let heldoutIdx = order.slice(trainCount);

    // Prefer a held-out slice with both labels present (a single-class held-out
    // still has a defined logLoss, but a balanced one is a fairer measurement).
    if (!heldoutHasBothLabels(samples, heldoutIdx)) {
      const alt = mulberry32((seed ^ 0x9e3779b9) + 1);
      order = shuffledIndices(total, alt);
      const altTrain = order.slice(0, trainCount);
      const altHeldout = order.slice(trainCount);
      if (heldoutHasBothLabels(samples, altHeldout)) {
        trainIdx = altTrain;
        heldoutIdx = altHeldout;
      }
      // else: fall through with the original split — logLoss is still defined.
    }

    const trainSamples = trainIdx.map((i) => samples[i]);
    const heldoutSamples = heldoutIdx.map((i) => samples[i]);

    // 4. Champion = currently-persisted weights, else cold zeros.
    const champion = loadRankerState()?.weights ?? zeroWeights();

    // 5. Evolve the challenger on the TRAIN split only.
    const challenger = evolveWeights(trainSamples, {
      seed,
      generations: opts.generations,
      lambda: opts.lambda,
      sigma: opts.sigma,
      init: champion,
    }).weights;

    // 6. Measure both on the HELD-OUT split (never trained on).
    const championFitness = rankerFitness(champion, heldoutSamples);
    const challengerFitness = rankerFitness(challenger, heldoutSamples);
    const heldoutDelta = challengerFitness - championFitness;

    // A non-applied result that still reports the measured fitnesses + delta
    // (gates report WHY they declined without touching production state).
    const declined = (reason: OptimizeResult["reason"]): OptimizeResult => ({
      applied: false,
      reason,
      championFitness,
      challengerFitness,
      heldoutDelta,
      trainSamples: trainSamples.length,
      heldoutSamples: heldoutSamples.length,
    });

    // 7. Gates, in order. Each failure reports both fitnesses + delta but does
    //    NOT touch production state.
    const finiteAndBounded = challenger.every((w) => Number.isFinite(w) && Math.abs(w) <= WEIGHT_CLIP);
    if (!finiteAndBounded) {
      return declined("non-finite");
    }
    if (!(challengerFitness > championFitness + PROMOTE_EPSILON)) {
      return declined("no-improvement");
    }
    const detail = `heldout +${heldoutDelta.toFixed(4)} (champion ${championFitness.toFixed(4)} -> challenger ${challengerFitness.toFixed(4)}) over ${heldoutSamples.length} held-out samples`;
    if (!gate.permitAndAudit("evolution", "promote-ranker-weights", detail)) {
      return declined("safety-veto");
    }

    // 8. All gates passed — PROMOTE. Persist, reload the running ranker's cached
    //    weights, then record the experiment for the audit trail.
    const prevTrained = loadRankerState()?.trainedCount ?? 0;
    saveRankerState({ version: FEATURE_VERSION, weights: challenger, trainedCount: prevTrained });
    __resetRankerCache();

    const result: OptimizeResult = {
      applied: true,
      reason: "applied",
      championFitness,
      challengerFitness,
      heldoutDelta,
      trainSamples: trainSamples.length,
      heldoutSamples: heldoutSamples.length,
    };

    try {
      const db = openDb();
      db.prepare(
        `INSERT INTO evolution_experiments
           (id, name, target_kind, hypothesis, result_summary, result_json, fitness_delta, safe, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ulid(),
        "ranker-weight-evolution",
        "reasoning-strategy",
        "A seeded (1+λ) evolution search over the learned ranker weights, scored by real cross-entropy on labelled citation data, yields weights that beat the champion on a held-out split the search never saw.",
        `Promoted challenger: held-out fitness ${championFitness.toFixed(4)} -> ${challengerFitness.toFixed(4)} (Δ +${heldoutDelta.toFixed(4)}) over ${heldoutSamples.length} held-out / ${trainSamples.length} train samples.`,
        JSON.stringify({ ...result, weights: challenger }),
        heldoutDelta,
        1,
        new Date().toISOString(),
      );
    } catch (err) {
      // Audit write must never undo a valid promotion or throw into the route.
      console.warn("[evolutionOptimizer] experiment audit write failed:", err);
    }

    return result;
  } catch (err) {
    console.warn("[evolutionOptimizer] optimize failed:", err);
    return fail("error");
  }
}
