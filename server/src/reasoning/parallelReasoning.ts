// Pure, failure-isolated parallel reasoning — Universal-Self-Consistency done locally.
//
// Samples N reasoning drafts concurrently and picks the most "central" one by
// mean pairwise Jaccard token-overlap. No LLM judge, no log-probs required.
//
// Design rules (matching the pure modules in this codebase):
//   - ZERO DB/config/network deps. Caller supplies the runner function.
//   - Deterministic scoring (same texts → same winner).
//   - NEVER throws — `bestOfParallel` catches all errors, counts them,
//     and returns best=null when every runner failed (caller falls back to
//     a single draft).
//   - Reuses the established tokeniser from attention/saliency.ts so the
//     token normalisation is consistent with the ranker and saliency scorer.

import { tokens } from "../attention/saliency.js";

export const DEFAULT_DRAFTS = 2;
export const MAX_DRAFTS = 3;

// ---------------------------------------------------------------------------
// Jaccard over token sets (set-based, handles empty inputs without NaN).
// ---------------------------------------------------------------------------

function jaccardTokens(a: string[], b: string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;
  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter++;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

// ---------------------------------------------------------------------------
// scoreDrafts
// ---------------------------------------------------------------------------

/**
 * Pure: pick the consensus draft by mean pairwise Jaccard token-overlap.
 *
 * @returns bestIndex — index of the most central draft (lowest index on tie).
 *          agreement — mean pairwise Jaccard of the winner in [0,1].
 *
 * Special cases:
 *   empty array  → { bestIndex: -1, agreement: 0 }
 *   single draft → { bestIndex:  0, agreement: 1 }
 */
export function scoreDrafts(
  drafts: ReadonlyArray<{ text: string }>,
): { bestIndex: number; agreement: number } {
  if (drafts.length === 0) return { bestIndex: -1, agreement: 0 };
  if (drafts.length === 1) return { bestIndex: 0, agreement: 1 };

  // Pre-tokenise once per draft.
  const tokenSets: string[][] = drafts.map((d) => tokens(d.text));

  let bestIndex = 0;
  let bestMean = -1;

  for (let i = 0; i < tokenSets.length; i++) {
    let sum = 0;
    for (let j = 0; j < tokenSets.length; j++) {
      if (i === j) continue;
      sum += jaccardTokens(tokenSets[i], tokenSets[j]);
    }
    const mean = sum / (tokenSets.length - 1);
    // Tie-break: strict > so the LOWEST index wins on a tie.
    if (mean > bestMean) {
      bestMean = mean;
      bestIndex = i;
    }
  }

  return { bestIndex, agreement: Math.max(0, bestMean) };
}

// ---------------------------------------------------------------------------
// bestOfParallel
// ---------------------------------------------------------------------------

/**
 * Generic, failure-isolated orchestrator.
 *
 * Runs `n` drafts in parallel (clamped to [1, MAX_DRAFTS]), collects
 * fulfilled results, picks the consensus winner via scoreDrafts.
 *
 * @param n       Number of parallel drafts to generate.
 * @param runOne  Async factory — called with the draft index (0…n-1).
 * @param toText  Converts a fulfilled result to text for scoring.
 *
 * @returns
 *   best      — the winning result, or null when every runner failed.
 *   index     — original index of the winner (-1 when best is null).
 *   agreement — mean pairwise Jaccard of the winner in [0,1].
 *   ran       — total runners launched.
 *   errored   — count of rejected promises.
 *
 * NEVER throws.
 */
export async function bestOfParallel<T>(
  n: number,
  runOne: (i: number) => Promise<T>,
  toText: (d: T) => string,
): Promise<{ best: T | null; index: number; agreement: number; ran: number; errored: number }> {
  const clamped = Math.max(1, Math.min(MAX_DRAFTS, Math.round(n)));

  const settled = await Promise.allSettled(
    Array.from({ length: clamped }, (_, i) => runOne(i)),
  );

  const fulfilled: Array<{ result: T; originalIndex: number }> = [];
  let errored = 0;

  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    if (s.status === "fulfilled") {
      fulfilled.push({ result: s.value, originalIndex: i });
    } else {
      errored++;
    }
  }

  if (fulfilled.length === 0) {
    return { best: null, index: -1, agreement: 0, ran: clamped, errored };
  }

  if (fulfilled.length === 1) {
    return {
      best: fulfilled[0].result,
      index: fulfilled[0].originalIndex,
      agreement: 1,
      ran: clamped,
      errored,
    };
  }

  // Score all fulfilled drafts.
  const drafts = fulfilled.map((f) => ({ text: toText(f.result) }));
  const { bestIndex, agreement } = scoreDrafts(drafts);

  return {
    best: fulfilled[bestIndex].result,
    index: fulfilled[bestIndex].originalIndex,
    agreement,
    ran: clamped,
    errored,
  };
}
