// Glue between the pure LTR model and the pipeline. Owns the cached weight
// state, the cold-start blend, prompt trimming, and the position-bias guard.
//
// Phase 2 (blueprint §3 / §6 / §17) — Personalized-PageRank over
// memory_relations is now fused as an OPTIONAL additive feature alongside
// saliency. It is gated by a density check (`isGraphDenseEnough`) so on a
// fresh DB with near-empty relations it contributes 0 and the ranker behaves
// as it did before. As the graph fills (cites edges, semantic-cluster edges,
// access-pattern co-edges), PPR begins to shift rankings.

import type { VectorSearchHit } from "../db/repositories/memory.js";
import type { MemoryRelation } from "../../../shared/memory.js";
import {
  loadRankerState,
  saveRankerState,
  type RankerState,
} from "../db/repositories/ranker.js";
import {
  FEATURE_VERSION,
  heuristicScore,
  predictProb,
  sgdStep,
  toFeatureVector,
  zeroWeights,
  type RankFeatureInput,
} from "./rankerModel.js";
import { computeSaliency, type SaliencyContext } from "../attention/saliency.js";
import {
  isGraphDenseEnough,
  personalisedPageRank,
  type GraphTraversalOptions,
} from "../memory/graphTraversal.js";

// Saliency blend weight. Additive on top of the existing (1-alpha)*heur +
// alpha*learned score, then re-normalised. Small enough that the saliency
// signal can move a tied pair but can't override a strong learned signal
// (which has been trained on real citations). Tunable.
const W_SALIENCY = 0.2;

// Graph (PPR) blend weight. Smaller than saliency because PPR is itself a
// noisy signal on a young graph — but non-zero so a strongly-connected hit
// can edge ahead of a vec-close-but-isolated one. Tunable.
const W_GRAPH = 0.15;

// Minimum relation count before PPR is allowed to influence ranking. Below
// this the graph has too few edges for the random walk to mean anything; the
// PPR feature stays 0 and the ranker behaves as it did pre-Phase-2.
const PPR_MIN_RELATIONS = 50;

// Queries-with-citations before the learned model fully takes over from the
// heuristic (alpha ramps 0 -> 1 linearly across this many).
const WARM_AT = 20;
const LR = 0.05;
const L2 = 1e-4;

// Prompt trimming (only once warm): keep hits the model is at least this
// confident were citable, but never fewer than MIN_PROMPT_HITS.
const TRIM_PROB = 0.5;
const MIN_PROMPT_HITS = 3;

// Position-bias guard. The label is "did the LLM cite this?" — but the LLM
// mostly cites whatever we rank highest, so the gradient self-confirms. With
// probability epsilon we shuffle the order the LLM *reads* (features/labels
// still use the true ranking, since labels are keyed by id, not position).
const EXPLORE_EPSILON = 0.12;
const EXPLORE_EPSILON_WARM = 0.05;

let cached: RankerState | null = null;
let loaded = false;

function state(): RankerState {
  if (!loaded) {
    cached = loadRankerState();
    loaded = true;
  }
  if (!cached) {
    cached = { version: FEATURE_VERSION, weights: zeroWeights(), trainedCount: 0 };
  }
  return cached;
}

function featureInput(hit: VectorSearchHit, now: number): RankFeatureInput {
  const ageDays = Math.max(
    0,
    (now - new Date(hit.memory.updatedAt).getTime()) / 86400000,
  );
  return {
    vecScore: hit.score,
    ageDays,
    importance: hit.memory.importance,
    sourceType: hit.memory.sourceType,
    hasProject: Boolean(hit.memory.projectName),
    contentLength: hit.memory.content.length,
  };
}

/**
 * Optional graph-traversal context. When supplied, PPR is computed over the
 * provided relations using the vec scores as the restart distribution; the
 * result is blended into the ranker score (see W_GRAPH).
 *
 * The caller is responsible for fetching `relations` (typically via
 * `listRelationsAmong(hits.map(h=>h.memory.id))`) — this keeps the ranker
 * itself dependency-inverted and unit-testable.
 */
export interface GraphContext {
  relations: ReadonlyArray<MemoryRelation>;
  /** Total relation count in the DB — used for the density gate. */
  totalRelations: number;
  /** Optional PPR tuning forwarded to the resolver. */
  options?: GraphTraversalOptions;
}

export interface RankResult {
  ranked: VectorSearchHit[];
  featuresById: Map<string, number[]>;
  warm: boolean;
  alpha: number;
  /** Per-memory saliency breakdown when a SaliencyContext was provided; else empty. */
  saliencyById: Map<string, number>;
  /** Per-memory PPR score when a GraphContext was provided AND the graph is dense enough. */
  graphScoreById: Map<string, number>;
}

// Re-rank vector hits with the blended score. featuresById is kept so the
// learning step can label/train over the exact feature vectors that produced
// this ranking (the full candidate set, not just the trimmed prompt set).
//
// If saliencyCtx is provided, each hit also receives a per-memory saliency
// signal (novelty + goal-relevance + emotion + survival, see
// attention/saliency.ts) that's blended additively with the existing score.
// The saliency layer is OPTIONAL — calling rankHits(hits) without a context
// keeps the legacy behavior unchanged (no regression risk for the existing
// ranker selfcheck or pipeline).
export function rankHits(
  hits: VectorSearchHit[],
  saliencyCtx?: SaliencyContext,
  graphCtx?: GraphContext,
): RankResult {
  const s = state();
  const now = Date.now();
  const alpha = Math.min(1, s.trainedCount / WARM_AT);
  const warm = s.trainedCount >= WARM_AT;
  const featuresById = new Map<string, number[]>();
  const saliencyById = new Map<string, number>();
  const graphScoreById = new Map<string, number>();

  // PPR is computed once over the candidate set when the graph is dense
  // enough; per-hit lookup is O(1) below. If the gate fails (sparse graph
  // or no context supplied) we leave graphScoreById empty and W_GRAPH * 0 = 0
  // — i.e. the ranker reproduces its pre-PPR behaviour.
  const usePPR =
    graphCtx !== undefined &&
    isGraphDenseEnough(graphCtx.totalRelations, PPR_MIN_RELATIONS) &&
    graphCtx.relations.length > 0;
  if (usePPR) {
    const seedWeights = new Map<string, number>();
    for (const h of hits) seedWeights.set(h.memory.id, h.score);
    const ppr = personalisedPageRank(graphCtx.relations, seedWeights, graphCtx.options);
    if (ppr.hasEdges) {
      // Normalise PPR scores to [0,1] across the hit set so they blend
      // commensurate with vec/heuristic/learned/saliency.
      let maxPpr = 0;
      for (const h of hits) {
        const v = ppr.scoreById.get(h.memory.id) ?? 0;
        if (v > maxPpr) maxPpr = v;
      }
      const denom = maxPpr > 0 ? maxPpr : 1;
      for (const h of hits) {
        graphScoreById.set(h.memory.id, (ppr.scoreById.get(h.memory.id) ?? 0) / denom);
      }
    }
  }

  const scored = hits.map((hit) => {
    const fi = featureInput(hit, now);
    const x = toFeatureVector(fi);
    featuresById.set(hit.memory.id, x);
    const learned = predictProb(s.weights, x);
    const heur = heuristicScore(fi);
    const base = (1 - alpha) * heur + alpha * learned;

    let blendNumer = base;
    let blendDenom = 1;
    if (saliencyCtx) {
      const sal = computeSaliency(
        { id: hit.memory.id, content: hit.memory.content, importance: hit.memory.importance },
        saliencyCtx,
      );
      saliencyById.set(hit.memory.id, sal.score);
      blendNumer += W_SALIENCY * sal.score;
      blendDenom += W_SALIENCY;
    }
    const graphScore = graphScoreById.get(hit.memory.id);
    if (typeof graphScore === "number") {
      blendNumer += W_GRAPH * graphScore;
      blendDenom += W_GRAPH;
    }
    const score = blendNumer / blendDenom;
    return { ...hit, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return { ranked: scored, featuresById, warm, alpha, saliencyById, graphScoreById };
}

// What the LLM actually sees. Cold start: everything (a regressed warm top-k
// is worse than the prior heuristic top-8). Warm: high-confidence subset.
export function selectPromptHits(
  ranked: VectorSearchHit[],
  featuresById: Map<string, number[]>,
  warm: boolean,
): VectorSearchHit[] {
  if (!warm) {
    return ranked;
  }
  const s = state();
  const kept = ranked.filter((h) => {
    const x = featuresById.get(h.memory.id);
    return x ? predictProb(s.weights, x) >= TRIM_PROB : true;
  });
  return kept.length >= MIN_PROMPT_HITS ? kept : ranked.slice(0, MIN_PROMPT_HITS);
}

function hashStr(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    let value = (seed += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

// Position-bias exploration. Seeded by runId so a single run is reproducible
// while still exploring across runs. Returns a (possibly shuffled) copy; the
// input order is untouched so feature/label collection is unaffected.
export function maybeExplore(
  hits: VectorSearchHit[],
  runId: string,
  warm: boolean,
): VectorSearchHit[] {
  if (hits.length < 2) {
    return hits;
  }
  const rng = mulberry32(hashStr(runId));
  const epsilon = warm ? EXPLORE_EPSILON_WARM : EXPLORE_EPSILON;
  if (rng() >= epsilon) {
    return hits;
  }
  const a = hits.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

// Online update from one query's implicit feedback. Trains over every
// candidate (cited = 1, retrieved-but-not-cited = 0). Queries with no
// citations carry no positive signal and are skipped (no warm-up credit).
export function trainFromCitations(
  featuresById: Map<string, number[]>,
  citedIds: Set<string>,
): void {
  if (citedIds.size === 0 || featuresById.size === 0) {
    return;
  }
  const s = state();
  let weights = s.weights;
  for (const [id, x] of featuresById) {
    const y = citedIds.has(id) ? 1 : 0;
    weights = sgdStep(weights, x, y, LR, L2);
  }
  cached = {
    version: FEATURE_VERSION,
    weights,
    trainedCount: s.trainedCount + 1,
  };
  try {
    saveRankerState(cached);
  } catch (err) {
    console.warn("[ranker] persist failed:", err);
  }
}

// Test seam — drop the in-memory cache so a fresh load is forced.
export function __resetRankerCache(): void {
  cached = null;
  loaded = false;
}
