// Phase 2 (blueprint §3 / §6 / §17) — Personalized PageRank over memory_relations.
//
// Today the ranker reads vec-score + heuristic + learned LTR + saliency, but it
// does NOT walk the associative graph. The graph carries real signal once
// `cites` edges accumulate: a memory that's *one citation hop away* from
// several relevant memories is itself relevant, even if its embedding misses.
//
// This module is the pure graph layer. PPR runs in O(iter × edges) over the
// 2-hop neighborhood of the vec-hit seeds; iterations capped at 8 (the standard
// "good enough" for surface-level personalisation), fanout per node capped at
// 32 (the average degree before bursty memories pull the mean up).
//
// Design rules (matching the rest of the pure modules):
//   - ZERO runtime deps. No db, no openDb(); the caller assembles the
//     adjacency map by calling `listRelationsAmong()` (already in
//     db/repositories/memory.ts) over the candidate set.
//   - Deterministic. Same input → same output. Iteration order is keyed by
//     a stable sort so the test can pin scores.
//   - Returns BOTH the per-node score AND a summary (sum, sparsity flag) so
//     the caller can decide whether to use it (the density gate).
//   - Backward compatible: if the graph is sparse (no edges, no seeds), the
//     result map is empty / scores are 0 — the ranker treats this as a no-op.

import type { MemoryRelation } from "../../../shared/memory.js";

export interface GraphTraversalOptions {
  /** Random-walk damping factor. Std PageRank default = 0.85. */
  damping?: number;
  /** Max power-iteration rounds. 8 is empirically enough for ≤500-node windows. */
  iterations?: number;
  /** Per-node out-degree cap. Beyond this, edges are sorted by weight desc and clipped. */
  fanoutCap?: number;
  /**
   * Edge weight floor. Edges with weight ≤ this are dropped. Lets the caller
   * filter weak co-access edges from `accessPatternTracker` without rebuilding
   * the relation set.
   */
  weightFloor?: number;
}

export interface PPRResult {
  /** Per-memory PPR score in [0,1] (sums to ~1 across all nodes touched). */
  scoreById: Map<string, number>;
  /** Whether the graph had any usable edges at all — gate for the ranker. */
  hasEdges: boolean;
  /** Iteration count actually performed (early-stops if converged). */
  iterationsRun: number;
}

const DEFAULT_DAMPING = 0.85;
const DEFAULT_ITER = 8;
const DEFAULT_FANOUT = 32;
const DEFAULT_FLOOR = 0;
const CONV_TOL = 1e-4;

function normaliseSeeds(seedWeights: ReadonlyMap<string, number>): Map<string, number> {
  let sum = 0;
  for (const v of seedWeights.values()) {
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  const out = new Map<string, number>();
  if (sum <= 0 || seedWeights.size === 0) {
    return out;
  }
  for (const [k, v] of seedWeights) {
    if (Number.isFinite(v) && v > 0) out.set(k, v / sum);
  }
  return out;
}

/**
 * Build a directed adjacency map from the relation set. Both endpoints of an
 * edge contribute (the relation graph is conceptually undirected for PPR —
 * a citation in either direction implies relatedness). Caller supplies the
 * raw `MemoryRelation[]` from `listRelationsAmong(candidateIds)`.
 *
 * Sorts each adjacency list by weight desc and clips to `fanoutCap` so a
 * hub node can't dominate the iteration cost. Pure / deterministic.
 */
export function buildAdjacency(
  relations: ReadonlyArray<MemoryRelation>,
  opts?: GraphTraversalOptions,
): Map<string, Array<{ to: string; weight: number }>> {
  const fanoutCap = Math.max(1, opts?.fanoutCap ?? DEFAULT_FANOUT);
  const floor = opts?.weightFloor ?? DEFAULT_FLOOR;
  const adj = new Map<string, Array<{ to: string; weight: number }>>();

  for (const r of relations) {
    const w = Number.isFinite(r.weight) ? Math.max(0, r.weight) : 0;
    if (w <= floor) continue;
    // Forward
    let fwd = adj.get(r.fromId);
    if (!fwd) {
      fwd = [];
      adj.set(r.fromId, fwd);
    }
    fwd.push({ to: r.toId, weight: w });
    // Reverse (relations are conceptually bidirectional for retrieval)
    let rev = adj.get(r.toId);
    if (!rev) {
      rev = [];
      adj.set(r.toId, rev);
    }
    rev.push({ to: r.fromId, weight: w });
  }

  // Clip each node's adjacency to fanoutCap by weight (keep the strongest).
  for (const [node, edges] of adj) {
    if (edges.length > fanoutCap) {
      edges.sort((a, b) => b.weight - a.weight || (a.to < b.to ? -1 : 1));
      adj.set(node, edges.slice(0, fanoutCap));
    }
  }
  return adj;
}

/**
 * Personalized PageRank with the supplied seed restart distribution.
 *
 * `seedWeights` is the personalisation vector — typically the vector-search
 * scores of the top-K hits. Internally it's normalised to a probability mass.
 *
 * Returns a `scoreById` map covering every node in `adj` plus every seed
 * (seeds with no outgoing edges still get the seed mass as their final score).
 *
 * Pure / deterministic. O(iterations × edges).
 */
export function pageRank(
  adj: ReadonlyMap<string, ReadonlyArray<{ to: string; weight: number }>>,
  seedWeights: ReadonlyMap<string, number>,
  opts?: GraphTraversalOptions,
): PPRResult {
  const damping = opts?.damping ?? DEFAULT_DAMPING;
  const maxIter = Math.max(1, opts?.iterations ?? DEFAULT_ITER);
  const personalisation = normaliseSeeds(seedWeights);

  // Universe = adjacency keys ∪ seeds ∪ all neighbours mentioned.
  const universe = new Set<string>(adj.keys());
  for (const k of personalisation.keys()) universe.add(k);
  for (const edges of adj.values()) for (const e of edges) universe.add(e.to);

  if (universe.size === 0) {
    return { scoreById: new Map(), hasEdges: false, iterationsRun: 0 };
  }

  // Pre-compute per-source outgoing weight sums.
  const outSum = new Map<string, number>();
  for (const [node, edges] of adj) {
    let s = 0;
    for (const e of edges) s += e.weight;
    outSum.set(node, s);
  }

  // Initial distribution: equal across universe. (Some implementations seed
  // with the personalisation vector — we deliberately start uniform so the
  // contribution of personalisation is visible across iterations.)
  const initial = 1 / universe.size;
  let pr = new Map<string, number>();
  for (const n of universe) pr.set(n, initial);

  // Personalisation gets a default uniform-over-seeds mass if the caller
  // gave an empty restart distribution; otherwise use as-supplied (already
  // normalised).
  let restart: Map<string, number>;
  if (personalisation.size > 0) {
    restart = personalisation;
  } else {
    // No seeds → uniform-over-universe restart (degenerates to plain PageRank).
    restart = new Map();
    for (const n of universe) restart.set(n, initial);
  }

  let hasEdges = false;
  for (const edges of adj.values()) if (edges.length > 0) { hasEdges = true; break; }

  let iterationsRun = 0;
  for (let iter = 0; iter < maxIter; iter += 1) {
    iterationsRun = iter + 1;
    const next = new Map<string, number>();
    // Seed every node with the restart contribution.
    for (const n of universe) {
      next.set(n, (1 - damping) * (restart.get(n) ?? 0));
    }
    // Push current mass along outgoing edges.
    for (const [src, edges] of adj) {
      const out = outSum.get(src) ?? 0;
      if (out <= 0) continue;
      const mass = pr.get(src) ?? 0;
      const factor = (damping * mass) / out;
      for (const edge of edges) {
        next.set(edge.to, (next.get(edge.to) ?? 0) + factor * edge.weight);
      }
    }
    // Handle dangling nodes (no out-edges): their mass redistributes via the
    // restart vector — already accounted for by the seed loop above, but we
    // also need to push dangling mass back through restart so total mass is
    // conserved. Standard trick: collect dangling mass, redistribute via restart.
    let dangling = 0;
    for (const [n, m] of pr) {
      const out = outSum.get(n) ?? 0;
      if (out <= 0) dangling += m;
    }
    if (dangling > 0) {
      for (const n of universe) {
        next.set(n, (next.get(n) ?? 0) + damping * dangling * (restart.get(n) ?? 0));
      }
    }

    // Convergence check (L1 delta).
    let delta = 0;
    for (const n of universe) {
      delta += Math.abs((next.get(n) ?? 0) - (pr.get(n) ?? 0));
    }
    pr = next;
    if (delta < CONV_TOL) break;
  }

  return { scoreById: pr, hasEdges, iterationsRun };
}

/**
 * One-shot helper: build adjacency + run PPR. The most common caller path.
 * Returns a `graphScoreById` map ready to feed the ranker.
 */
export function personalisedPageRank(
  relations: ReadonlyArray<MemoryRelation>,
  seedWeights: ReadonlyMap<string, number>,
  opts?: GraphTraversalOptions,
): PPRResult {
  const adj = buildAdjacency(relations, opts);
  return pageRank(adj, seedWeights, opts);
}

/** Density threshold helper — exported for the density gate in the ranker. */
export function isGraphDenseEnough(relationCount: number, minEdges = 50): boolean {
  return relationCount >= minEdges;
}
