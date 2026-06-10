// Multi-query RAG: the "ask the question more than one way" retrieval upgrade.
// Two independent pieces:
//
//   expandQuery()           — turn one query into a few alternative phrasings /
//                             sub-questions via the connector. FAILURE-ISOLATED:
//                             any LLM/parse error returns just [query], so this
//                             can only ADD recall, never break retrieval.
//   reciprocalRankFusion()  — PURE. Fuse the per-variant ranked hit lists into
//                             one candidate set by Reciprocal Rank Fusion (RRF),
//                             the standard rank-only fusion that needs no score
//                             calibration across lists. This is the selfcheck
//                             target.
//
// Why RRF governs only the SURVIVING SET, not the emitted score: each fused hit
// is emitted with its MAX vector score across the variant searches, so the
// downstream learned ranker's `vecScore` feature stays a real cosine. RRF buys
// recall (a memory found by several phrasings rises); the ranker still does the
// final ordering on calibrated features.

import type { VectorSearchHit } from "../db/repositories/memory.js";

// Inject the generation call so the module is hermetically testable with a stub
// (no connector, no network). The pipeline passes a thin wrapper over
// connector.send(system, user, { model }).
export type GenerateFn = (system: string, user: string) => Promise<string>;

const EXPAND_SYSTEM =
  "You rewrite a user's question into alternative search queries for retrieving " +
  "relevant notes from a personal memory database. Produce SHORT, keyword-rich " +
  "paraphrases or sub-questions that surface different but relevant memories. " +
  "Reply with ONLY a JSON array of strings, no prose. Example: " +
  '["query one", "query two"].';

const MAX_VARIANT_LEN = 200;

// Pull a JSON string array out of a model reply, tolerant of code fences / prose
// around it. Returns [] on any failure (caller falls back to the original query).
function parseVariants(raw: string): string[] {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === "string")
      .map((v) => v.trim())
      .filter((v) => v.length > 0 && v.length <= MAX_VARIANT_LEN);
  } catch {
    return [];
  }
}

// Returns the original query FIRST followed by up to `variants` distinct
// alternatives (deduped case-insensitively). Always includes the original, and
// always returns at least [query] — so a caller can unconditionally iterate the
// result. `variants` is clamped to [1,3] (an extra LLM round-trip per variant).
export async function expandQuery(
  query: string,
  generate: GenerateFn,
  opts: { variants?: number } = {},
): Promise<string[]> {
  const q = query.trim();
  const want = Math.max(1, Math.min(3, opts.variants ?? 2));
  const out = [q];
  const seen = new Set([q.toLowerCase()]);
  try {
    const raw = await generate(EXPAND_SYSTEM, `Question: ${q}\nReturn ${want} alternative search queries as a JSON array.`);
    for (const v of parseVariants(raw)) {
      const key = v.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        out.push(v);
        if (out.length >= want + 1) break;
      }
    }
  } catch {
    // Failure-isolated: the original query alone is a perfectly good fallback.
  }
  return out;
}

// PURE. Fuse N ranked hit lists by Reciprocal Rank Fusion: a memory's fused score
// is Σ 1/(k + rank) over the lists it appears in (rank is 0-based). A memory
// surfaced by multiple phrasings outranks one seen by a single phrasing even if
// that single hit had a slightly higher cosine. The surviving top-`limit` set is
// emitted with each hit's MAX vector score (see file header).
export function reciprocalRankFusion(
  lists: VectorSearchHit[][],
  opts: { k?: number; limit?: number } = {},
): VectorSearchHit[] {
  const k = opts.k ?? 60;
  const limit = Math.max(1, opts.limit ?? 8);
  const byId = new Map<string, { hit: VectorSearchHit; rrf: number; maxVec: number }>();
  for (const list of lists) {
    list.forEach((hit, idx) => {
      const id = hit.memory.id;
      const contribution = 1 / (k + idx + 1);
      const existing = byId.get(id);
      if (existing) {
        existing.rrf += contribution;
        if (hit.score > existing.maxVec) existing.maxVec = hit.score;
      } else {
        byId.set(id, { hit, rrf: contribution, maxVec: hit.score });
      }
    });
  }
  return [...byId.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, limit)
    .map((f) => ({ ...f.hit, score: f.maxVec }));
}
