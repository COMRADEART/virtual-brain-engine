// Hebbian co-citation wiring — "memories that fire together wire together".
//
// The relation graph already exists (memory_relations) and the ranker already
// knows how to spread activation over it (personalisedPageRank, fused behind a
// density gate) — but until now the graph only gained static one-shot edges
// ("cites" at answer time) and the pipeline never even passed a GraphContext.
// This module supplies the real Hebbian mechanism:
//
//   strengthen — every time two memories are CO-CITED in one answer, the
//                "associates" edge between them moves toward 1 by a fixed
//                fraction of the remaining headroom (bounded, monotone).
//   decay      — every sleep cycle multiplies all association weights down;
//                edges that fall below the floor are pruned. Use it or lose it.
//   recall     — (a) the pipeline passes the candidate set's relations into
//                rankHits' existing GraphContext so PPR can reorder, and
//                (b) strong associations (weight ≥ PULL_IN_MIN_WEIGHT) PULL
//                their neighbour into the candidate pool even when the
//                embedding missed it — genuine associative recall.
//
// Pure math is exported for the selfcheck; DB access mirrors core/causalMap.ts.

import { ulid } from "ulid";
import { openDb } from "../db/sqlite.js";
import { surfaceError } from "../util/diagnostics.js";
import { getMemoryPoint, type VectorSearchHit } from "../db/repositories/memory.js";

// Headroom learning: w' = w + RATE × (1 − w). Monotone, asymptotes at 1.
export const HEBBIAN_RATE = 0.25;
// Weight assigned to a brand-new association on first co-citation.
export const INITIAL_WEIGHT = 0.3;
// Per-sleep-cycle multiplicative decay; edges below the floor are pruned.
export const DECAY_FACTOR = 0.98;
export const PRUNE_FLOOR = 0.05;
// Associative recall: only well-worn edges may pull a neighbour into the
// candidate pool, and at most this many per query (recall is a refinement,
// never a flood).
export const PULL_IN_MIN_WEIGHT = 0.5;
export const PULL_IN_LIMIT = 3;
// Cap on pairs strengthened per answer (an answer citing 10 memories would
// otherwise write 45 edges).
export const MAX_PAIRS_PER_CYCLE = 30;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

// -----------------------------------------------------------------------------
// PURE helpers.
// -----------------------------------------------------------------------------

/** One Hebbian reinforcement step. Monotone increasing, bounded by 1. */
export function strengthenWeight(weight: number, rate = HEBBIAN_RATE): number {
  const w = clamp01(weight);
  return clamp01(w + clamp01(rate) * (1 - w));
}

/**
 * Canonical unordered pairs from a co-cited id set, capped. Deterministic:
 * ids are sorted so (a,b) and (b,a) are the same edge.
 */
export function coCitationPairs(citedIds: ReadonlyArray<string>, maxPairs = MAX_PAIRS_PER_CYCLE): Array<[string, string]> {
  const ids = Array.from(new Set(citedIds)).sort();
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < ids.length && pairs.length < maxPairs; i += 1) {
    for (let j = i + 1; j < ids.length && pairs.length < maxPairs; j += 1) {
      pairs.push([ids[i], ids[j]]);
    }
  }
  return pairs;
}

// -----------------------------------------------------------------------------
// DB layer.
// -----------------------------------------------------------------------------

/**
 * Strengthen the "associates" edge for every co-cited pair (creating missing
 * edges at INITIAL_WEIGHT). Best-effort and bounded; returns the number of
 * edges touched. Never throws into the caller.
 */
export function recordCoCitations(citedIds: ReadonlyArray<string>): number {
  if (citedIds.length < 2) return 0;
  let touched = 0;
  try {
    const db = openDb();
    const find = db.prepare<[string, string], { id: string; weight: number }>(
      `SELECT id, weight FROM memory_relations
       WHERE kind = 'associates' AND from_id = ? AND to_id = ? LIMIT 1`,
    );
    const update = db.prepare(`UPDATE memory_relations SET weight = ? WHERE id = ?`);
    const insert = db.prepare(
      `INSERT INTO memory_relations (id, from_id, to_id, kind, weight, created_at)
       VALUES (?, ?, ?, 'associates', ?, ?)`,
    );
    const now = new Date().toISOString();
    for (const [a, b] of coCitationPairs(citedIds)) {
      const existing = find.get(a, b);
      if (existing) {
        update.run(strengthenWeight(existing.weight), existing.id);
      } else {
        insert.run(ulid(), a, b, INITIAL_WEIGHT, now);
      }
      touched += 1;
    }
  } catch (err) {
    surfaceError("hebbian.recordCoCitations", err);
  }
  return touched;
}

/**
 * Use-it-or-lose-it: multiply every association weight down and prune the
 * edges that fell below the floor. Called once per sleep cycle. Returns
 * { decayed, pruned }. Never throws.
 */
export function decayAssociations(factor = DECAY_FACTOR, floor = PRUNE_FLOOR): { decayed: number; pruned: number } {
  try {
    const db = openDb();
    const decayed = db
      .prepare(`UPDATE memory_relations SET weight = weight * ? WHERE kind = 'associates'`)
      .run(factor).changes;
    const pruned = db
      .prepare(`DELETE FROM memory_relations WHERE kind = 'associates' AND weight < ?`)
      .run(floor).changes;
    return { decayed, pruned };
  } catch (err) {
    surfaceError("hebbian.decayAssociations", err);
    return { decayed: 0, pruned: 0 };
  }
}

/**
 * Associative recall — strong neighbours of the current hit set that the
 * embedding search MISSED, returned as low-score candidate hits so the ranker
 * decides their final position. Bounded: only edges ≥ minWeight, at most
 * `limit` neighbours, score anchored below the weakest existing hit.
 */
export function associativeNeighbors(
  hits: ReadonlyArray<VectorSearchHit>,
  limit = PULL_IN_LIMIT,
  minWeight = PULL_IN_MIN_WEIGHT,
): VectorSearchHit[] {
  if (hits.length === 0) return [];
  try {
    const db = openDb();
    const hitIds = new Set(hits.map((h) => h.memory.id));
    const ids = Array.from(hitIds);
    const placeholders = ids.map(() => "?").join(", ");
    const rows = db
      .prepare<unknown[], { from_id: string; to_id: string; weight: number }>(
        `SELECT from_id, to_id, weight FROM memory_relations
         WHERE kind = 'associates' AND weight >= ?
           AND (from_id IN (${placeholders}) OR to_id IN (${placeholders}))
         ORDER BY weight DESC LIMIT 64`,
      )
      .all(minWeight, ...ids, ...ids);
    const minHitScore = Math.min(...hits.map((h) => h.score));
    const out: VectorSearchHit[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (out.length >= limit) break;
      const neighborId = hitIds.has(row.from_id) ? row.to_id : row.from_id;
      if (hitIds.has(neighborId) || seen.has(neighborId)) continue;
      seen.add(neighborId);
      const memory = getMemoryPoint(neighborId);
      if (!memory) continue;
      // Anchored below the weakest real hit, scaled by the edge weight — an
      // associated memory enters the pool but never outranks an embedding hit
      // on raw score alone (the ranker/PPR may still promote it).
      out.push({ memory, score: Math.max(0, minHitScore * 0.9 * clamp01(row.weight)) });
    }
    return out;
  } catch (err) {
    surfaceError("hebbian.associativeNeighbors", err);
    return [];
  }
}

/** Count of association edges — for the status surface + selfcheck. */
export function associationCount(): number {
  try {
    const row = openDb()
      .prepare(`SELECT COUNT(*) AS c FROM memory_relations WHERE kind = 'associates'`)
      .get() as { c: number };
    return row.c;
  } catch {
    return 0;
  }
}
