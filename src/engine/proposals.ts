// Phase 1 (blueprint §18.4 / §18.11 / §18.13) — scored-proposal protocol.
//
// The blueprint flags this as the single highest-leverage cognitive addition:
// one mechanism closes THREE module gaps at once — Competing Thought Systems
// (§18.4), Cognitive Ecology (§18.11), and the negotiation half of Attention
// (§18.2). Each faculty (Memory / Emotion / Prediction / Reflection / Planning /
// Attention / Curiosity / Identity) becomes a publisher emitting scored bids;
// the arbiter resolves by a temperature-controlled softmax over
// (confidence × emotionalWeight × survivalRelevance) with `score` as the bid
// magnitude.
//
// Design rules (matching the rest of the pure modules in this codebase):
//   - ZERO runtime deps. Pure functions over plain data shapes; no bus, no
//     timers. The arbiter lives in `proposalArbiter.ts` and wraps this with
//     timing + bus glue. Keeping the resolver pure lets the test suite drive
//     it deterministically.
//   - Determinism. Same input → same output. Ties are broken by faculty
//     ordering (a fixed array, declared below) so test assertions are stable.
//   - Backward compatible. The arbiter is new behaviour; existing cognition
//     paths keep working until the faculties opt in to bidding.
//
// Why softmax rather than max:
//   The brief says faculties "compete, negotiate" — pure max would erase the
//   runner-up and lose information the consumer might want (e.g. "the winner
//   barely edged it out, so spend less energy on it"). Softmax produces a
//   probability distribution; the winner is the argmax, but the full set is
//   carried in `weights` so callers can act on confidence in the win.

/** The 8 named faculties from §18.11. Order matters — used as a stable tiebreak. */
export const FACULTY_IDS = [
  "memory",
  "emotion",
  "prediction",
  "reflection",
  "planning",
  "attention",
  "curiosity",
  "identity",
] as const;

export type FacultyId = (typeof FACULTY_IDS)[number];

/** A faculty's scored bid in the arbitration round. */
export interface Proposal<T = unknown> {
  faculty: FacultyId;
  /** Bid magnitude in [0,1] — "how much should this faculty's intent fire?". */
  score: number;
  /** Self-reported confidence in the bid [0,1]. */
  confidence: number;
  /** Emotional weight backing the bid [0,1]. */
  emotionalWeight: number;
  /** Survival relevance [0,1]. Pulls weight when the organism is unwell. */
  survivalRelevance: number;
  /** Opaque to the arbiter; the consumer that listens for `proposal:winner` reads it. */
  payload?: T;
  /** Monotonic timestamp (ms) when the bid was emitted. */
  at: number;
}

export interface ResolveOptions {
  /**
   * Softmax temperature. Lower = more decisive (winner-take-most), higher =
   * more uniform. Defaults to 0.5 — emphatically decisive when bids differ,
   * still gives a runner-up non-trivial mass.
   */
  temperature?: number;
}

export interface ResolveResult {
  /** Argmax — null only if the proposal set was empty. */
  winner: Proposal | null;
  /** Sorted high→low by resolved weight. */
  ranked: Proposal[];
  /** Per-faculty softmax probability. Sums to 1.0 when at least one proposal. */
  weights: Map<FacultyId, number>;
}

// Weighting recipe for the inner score (before softmax):
//   weight = score * (W_CONF * confidence + W_EMO * emotion + W_SURV * survival)
//
// These three sum to 1.0 so the inner multiplier stays in [0,1] and pure
// `score`-dominated proposals are not penalised. Tuned by §18.13 commentary:
// confidence is the strongest signal (a faculty that's sure should be heard),
// emotion is the affect-prior, survival is the small organism-health gate.
const W_CONF = 0.5;
const W_EMO = 0.3;
const W_SURV = 0.2;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function innerWeight(p: Proposal): number {
  const s = clamp01(p.score);
  const c = clamp01(p.confidence);
  const e = clamp01(p.emotionalWeight);
  const v = clamp01(p.survivalRelevance);
  return s * (W_CONF * c + W_EMO * e + W_SURV * v);
}

/**
 * Resolve a set of competing proposals.
 *
 * Empty input ⇒ `{ winner: null, ranked: [], weights: <empty> }`. Otherwise
 * the result carries a winner (highest softmax weight), the full ranked list,
 * and the per-faculty weight distribution.
 *
 * Pure. Deterministic. Stable tiebreak by FACULTY_IDS order.
 */
export function resolve(
  proposals: ReadonlyArray<Proposal>,
  opts?: ResolveOptions,
): ResolveResult {
  if (proposals.length === 0) {
    return { winner: null, ranked: [], weights: new Map() };
  }

  const temperature = Math.max(1e-6, opts?.temperature ?? 0.5);
  const raw = proposals.map((p) => innerWeight(p));

  // Numerically-stable softmax: subtract max before exp.
  let maxRaw = -Infinity;
  for (const w of raw) if (w > maxRaw) maxRaw = w;
  const exps = raw.map((w) => Math.exp((w - maxRaw) / temperature));
  let sumExp = 0;
  for (const e of exps) sumExp += e;
  // sumExp can't be 0: at least one term is exp(0)=1.

  const weights = new Map<FacultyId, number>();
  const ranked: Proposal[] = [];
  const resolved: Array<{ p: Proposal; w: number }> = [];
  for (let i = 0; i < proposals.length; i += 1) {
    const p = proposals[i];
    const w = exps[i] / sumExp;
    weights.set(p.faculty, w);
    resolved.push({ p, w });
  }

  // Sort high→low; on tie, prefer the faculty earlier in FACULTY_IDS for stability.
  const facultyOrder = new Map<FacultyId, number>(FACULTY_IDS.map((id, idx) => [id, idx]));
  resolved.sort((a, b) => {
    if (b.w !== a.w) return b.w - a.w;
    const ao = facultyOrder.get(a.p.faculty) ?? Number.MAX_SAFE_INTEGER;
    const bo = facultyOrder.get(b.p.faculty) ?? Number.MAX_SAFE_INTEGER;
    return ao - bo;
  });
  for (const r of resolved) ranked.push(r.p);

  return { winner: ranked[0], ranked, weights };
}

/** Selfcheck/test helper — sum of weights, so the test can assert closure. */
export const PROPOSAL_INNER_WEIGHT_SUM = W_CONF + W_EMO + W_SURV;
