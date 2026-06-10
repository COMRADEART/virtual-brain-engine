// Lexical, query-aware reranker (ML). The learned LTR ranker (rankerModel.ts)
// scores each hit from DOC-SIDE features (vecScore, age, importance, sourceType,
// hasProject, length) — its ONLY query-interaction signal is the vector cosine.
// This reranker adds the missing axis: cheap LEXICAL query↔document interaction
// (term coverage/jaccard, title match, exact-phrase) that a cosine can miss
// (synonyms inflate cosine; exact keyword hits the user typed are lexical). It
// reorders the top-K AFTER the LTR pass.
//
// PURE (no DB, no network) — the selfcheck target. Persistence + glue live in
// db/repositories/adaptive.ts and the pipeline. Trains ONLINE on the dense
// citation signal (cited=1 / shown-but-not-cited=0), and is a strict NO-OP until
// it has trained `WARM_AT` queries — so enabling it can never regress retrieval
// before it has learned anything.

import type { VectorSearchHit } from "../db/repositories/memory.js";

export interface RerankerState {
  version: number;
  weights: number[]; // length === FEATURE_DIM
  trainedCount: number; // queries-with-citations trained on
}

export const RERANKER_VERSION = 1;
// [bias, termCoverage, termJaccard, titleCoverage, phraseMatch]
export const FEATURE_DIM = 5;
// Queries-with-citations before the reranker is allowed to reorder anything.
export const WARM_AT = 15;
// Blend weight of the lexical prob on top of the LTR score (kept small, like the
// ranker's saliency blend, so a strong learned signal still dominates).
const W_RERANK = 0.25;
const LR = 0.05;
const L2 = 1e-4;

export function zeroWeights(): number[] {
  return new Array<number>(FEATURE_DIM).fill(0);
}

const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "is", "are", "and", "or", "for", "on",
  "with", "what", "how", "why", "when", "who", "where", "it", "this", "that",
]);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    const t = m[0];
    if (t.length >= 2 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

// Lexical query↔document feature vector. Deterministic + pure.
export function rerankFeatures(query: string, doc: { content: string; title?: string | null }): number[] {
  const q = tokenize(query);
  const d = tokenize(doc.content);
  const qSize = q.size || 1;
  const inter = intersectionSize(q, d);
  const union = q.size + d.size - inter || 1;
  const termCoverage = inter / qSize;
  const termJaccard = inter / union;
  const titleTokens = doc.title ? tokenize(doc.title) : new Set<string>();
  const titleCoverage = intersectionSize(q, titleTokens) / qSize;
  const phraseMatch = doc.content.toLowerCase().includes(query.trim().toLowerCase()) ? 1 : 0;
  return [1, termCoverage, termJaccard, titleCoverage, phraseMatch];
}

function dot(w: number[], x: number[]): number {
  let s = 0;
  for (let i = 0; i < w.length && i < x.length; i += 1) s += w[i] * x[i];
  return s;
}

function sigmoid(z: number): number {
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

export function rerankProb(weights: number[], x: number[]): number {
  return sigmoid(dot(weights, x));
}

function sgdStep(weights: number[], x: number[], y: number, lr = LR, l2 = L2): number[] {
  const p = sigmoid(dot(weights, x));
  const err = p - y;
  return weights.map((w, i) => w - lr * (err * (x[i] ?? 0) + l2 * w));
}

// Reorder the top-K by a blend of the LTR score and the lexical citation-prob.
// NO-OP until warm (returns the input order unchanged) and never touches the tail
// beyond topK, so it can only refine the head the user actually reads.
export function applyReranker(
  query: string,
  ranked: VectorSearchHit[],
  state: RerankerState | null,
  opts: { topK?: number } = {},
): VectorSearchHit[] {
  if (!state || state.trainedCount < WARM_AT || ranked.length < 2) {
    return ranked;
  }
  const topK = Math.max(2, opts.topK ?? 12);
  const head = ranked.slice(0, topK);
  const tail = ranked.slice(topK);
  const rescored = head
    .map((hit) => {
      const p = rerankProb(state.weights, rerankFeatures(query, hit.memory));
      const score = (hit.score + W_RERANK * p) / (1 + W_RERANK);
      return { ...hit, score };
    })
    .sort((a, b) => b.score - a.score);
  return [...rescored, ...tail];
}

// Online update from one query's citations. Trains over the candidate set
// (cited=1, retrieved-but-not-cited=0). Advances trainedCount ONLY when there's a
// positive (a query with no citations carries no signal — mirrors the LTR
// ranker's trainFromCitations). Returns the new state (caller persists it).
export function trainReranker(
  query: string,
  candidates: VectorSearchHit[],
  citedIds: Set<string>,
  state: RerankerState | null,
): RerankerState {
  const base: RerankerState = state ?? { version: RERANKER_VERSION, weights: zeroWeights(), trainedCount: 0 };
  if (citedIds.size === 0 || candidates.length === 0) {
    return base;
  }
  let weights = base.weights.length === FEATURE_DIM ? base.weights : zeroWeights();
  for (const hit of candidates) {
    const x = rerankFeatures(query, hit.memory);
    const y = citedIds.has(hit.memory.id) ? 1 : 0;
    weights = sgdStep(weights, x, y);
  }
  return { version: RERANKER_VERSION, weights, trainedCount: base.trainedCount + 1 };
}
