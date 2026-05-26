// Phase 1 (blueprint §15 / §18.2) — unified saliency scorer.
//
// One of the two "highest-leverage cognitive gaps" the blueprint flagged. The
// retrieval ranker already fuses vec score + heuristic + learned LTR, but it
// has NO term that says "this memory matches what the system actually cares
// about right now." That's saliency: a per-memory [0,1] score that folds
// four signals into one and feeds the retrieval blend.
//
// Design rules (matching the rest of the pure modules in this codebase):
//   - ZERO runtime deps. No openDb(), no imports from core/. The CALLER
//     assembles SaliencyContext (see reasoning/pipeline.ts) and passes it in.
//     This is what lets `attention:selfcheck` exercise every code path
//     without a database, the same way ranker:selfcheck does.
//   - Deterministic. Same input → same score. Lets the selfcheck assert.
//   - Returns BOTH the score AND its breakdown. The breakdown is what the
//     UI / debug overlay surfaces — without it, saliency is opaque.
//
// The four signals:
//
//   novelty       — how DIFFERENT this memory is from the rest of the recall
//                   set. Storage-time novelty (from noveltyDetector) is a
//                   one-shot signal; retrieval-time novelty is diversity
//                   within the candidates and is what the user actually
//                   cares about ("don't dump 10 near-duplicates on me").
//                   We approximate with a position-decayed similarity to the
//                   other hits, computed by the caller (cheap word-overlap).
//
//   goalRelevance — token-overlap between the memory content and the user's
//                   active organism goals. O(L * G) per memory, G usually
//                   small (<=8). When the user has no active goals, this
//                   degenerates to 0 — that's intentional (no prior).
//
//   emotion       — memory.importance is already calibrated by the
//                   importance scorer (valence, urgency, emotional weight)
//                   and persisted on every memory. We pass it through as
//                   the emotion signal rather than reinventing it.
//
//   survival      — organism health gates this. When health is high, the
//                   system has slack and survival adds nothing. When health
//                   is low (<0.5), memories whose content contains
//                   recovery/health/maintenance terms get a boost — the
//                   system literally pays more attention to what could
//                   restore it. This is small by design (max +0.2 on a
//                   [0,1] score) so it doesn't dominate goal-relevance.

export interface SaliencyContext {
  /** The user query. Used for token-overlap against memory content. */
  query: string;
  /** Active goal titles from organism. Empty array = no goal prior. */
  activeGoals: ReadonlyArray<string>;
  /** Organism health [0,1]. Drives the survival term. */
  organismHealth: number;
  /**
   * Optional per-memory novelty hint (from noveltyDetector at storage time).
   * When omitted, the caller can leave it null and we fall back to query
   * dissimilarity as a weak proxy.
   */
  storedNoveltyById?: Map<string, number>;
}

export interface SaliencyBreakdown {
  novelty: number;
  goalRelevance: number;
  emotion: number;
  survival: number;
  /** Weighted blend in [0,1]. */
  score: number;
}

/**
 * Memory shape that saliency needs. We accept the structural minimum so this
 * module isn't coupled to the wider MemoryPoint type (which carries fields
 * we don't read). The caller is free to pass either a VectorSearchHit.memory
 * or any other object with these fields.
 */
export interface SaliencyMemory {
  id: string;
  content: string;
  importance: number;
}

// Blend weights. Sum to 1 so `score` stays in [0,1]. Tuned by the blueprint's
// own §15 commentary: goal-relevance dominates because the system is goal-
// directed; novelty is a tiebreaker; emotion is the calibrated prior; survival
// is a small but real gate that the rest of the modules can't express.
const W_NOVELTY = 0.25;
const W_GOAL = 0.4;
const W_EMOTION = 0.25;
const W_SURVIVAL = 0.1;

// Health threshold below which survival kicks in. Mirrors the
// `lifecycle: "recovering"` cutoff in organism.ts (0.42 / 0.45 area).
const SURVIVAL_THRESHOLD = 0.5;

// Tokens that mark a memory as survival-relevant. Deliberately short — false
// positives are cheap (small boost), false negatives are the real cost.
const SURVIVAL_TERMS = [
  "health",
  "recovery",
  "maintenance",
  "error",
  "crash",
  "failure",
  "fix",
  "repair",
  "diagnostic",
  "rollback",
];

/** Pure tokeniser. Lowercase, strip non-alphanum, drop short tokens. */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/** Jaccard similarity over token sets. [0,1]. */
function jaccard(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const t of setA) if (setB.has(t)) inter += 1;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function noveltyFor(memory: SaliencyMemory, ctx: SaliencyContext): number {
  const stored = ctx.storedNoveltyById?.get(memory.id);
  if (typeof stored === "number" && Number.isFinite(stored)) {
    return clamp01(stored);
  }
  // Fallback: query↔memory token overlap inverted. The LESS the memory
  // duplicates the query wording, the more novel it is — useful tiebreaker
  // when storage-time novelty is unknown (large existing corpus, no fingerprint
  // was recorded). Bounded by [0, 0.7] to avoid claiming high novelty from
  // a single shallow signal.
  const queryTokens = tokens(ctx.query);
  const memTokens = tokens(memory.content);
  const sim = jaccard(queryTokens, memTokens);
  return clamp01((1 - sim) * 0.7);
}

function goalRelevanceFor(memory: SaliencyMemory, ctx: SaliencyContext): number {
  if (ctx.activeGoals.length === 0) return 0;
  const memTokens = tokens(memory.content);
  if (memTokens.length === 0) return 0;
  // Max overlap across goals (not sum — one strongly-matched goal should win
  // over many weak matches). Bounded by [0,1] by jaccard.
  let best = 0;
  for (const goal of ctx.activeGoals) {
    const goalTokens = tokens(goal);
    const sim = jaccard(goalTokens, memTokens);
    if (sim > best) best = sim;
  }
  return clamp01(best);
}

function emotionFor(memory: SaliencyMemory): number {
  // Importance is already in [0,1] (clamped at write-time by the importance
  // scorer). We pass it through but apply a mild sigmoid-ish curve so a 0.5
  // memory doesn't fully dominate a 0.4 one — small differences in
  // importance shouldn't gate retrieval.
  const i = clamp01(memory.importance);
  return clamp01(0.3 + i * 0.7); // floor at 0.3 so a zero-importance memory is still admissible.
}

function survivalFor(memory: SaliencyMemory, ctx: SaliencyContext): number {
  if (ctx.organismHealth >= SURVIVAL_THRESHOLD) return 0;
  // Linear ramp: at health=0 the multiplier is 1; at health=THRESHOLD it's 0.
  const urgency = clamp01((SURVIVAL_THRESHOLD - ctx.organismHealth) / SURVIVAL_THRESHOLD);
  const lower = memory.content.toLowerCase();
  let hits = 0;
  for (const term of SURVIVAL_TERMS) {
    if (lower.includes(term)) hits += 1;
  }
  if (hits === 0) return 0;
  // Cap at 1 because urgency is already in [0,1] and hits are capped via min.
  return clamp01(urgency * Math.min(1, hits / 3));
}

/**
 * The unified saliency score. Pure, deterministic.
 *
 * @param memory  any { id, content, importance } shape
 * @param ctx     query + goals + health, assembled by the caller
 * @returns       breakdown including the final blended score in [0,1]
 */
export function computeSaliency(memory: SaliencyMemory, ctx: SaliencyContext): SaliencyBreakdown {
  const novelty = noveltyFor(memory, ctx);
  const goalRelevance = goalRelevanceFor(memory, ctx);
  const emotion = emotionFor(memory);
  const survival = survivalFor(memory, ctx);
  const score = clamp01(
    W_NOVELTY * novelty + W_GOAL * goalRelevance + W_EMOTION * emotion + W_SURVIVAL * survival,
  );
  return { novelty, goalRelevance, emotion, survival, score };
}

/** Selfcheck helper — sum of weights, so the test can assert closure. */
export const SALIENCY_WEIGHT_SUM = W_NOVELTY + W_GOAL + W_EMOTION + W_SURVIVAL;
