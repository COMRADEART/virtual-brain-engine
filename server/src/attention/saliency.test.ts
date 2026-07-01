import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSaliency,
  tokens,
  SALIENCY_WEIGHT_SUM,
  type SaliencyContext,
  type SaliencyMemory,
} from "./saliency.js";

// ---- helpers --------------------------------------------------------------

const approx = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

const mem = (over: Partial<SaliencyMemory> = {}): SaliencyMemory => ({
  id: "m1",
  content: "some neutral content about widgets",
  importance: 0.5,
  ...over,
});

// A context that zeroes out every term except the one under test:
//   - no goals  → goalRelevance 0
//   - health 1  → survival 0
//   - no uncertainty fields → uncertainty 0
// We pin novelty via storedNoveltyById so the only moving part is explicit.
const baseCtx = (over: Partial<SaliencyContext> = {}): SaliencyContext => ({
  query: "",
  activeGoals: [],
  organismHealth: 1,
  storedNoveltyById: new Map([["m1", 0]]),
  ...over,
});

// ---- tokens ---------------------------------------------------------------

test("tokens: lowercases, strips punctuation, drops tokens of length <= 2", () => {
  // "ai" (2) and "go" (2) are dropped; punctuation is removed before splitting.
  assert.deepEqual(tokens("Hello, World! AI go now"), ["hello", "world", "now"]);
});

test("tokens: keeps digits/alphanumerics but drops 2-char tokens", () => {
  // "99" has length 2 -> dropped; the alphanumeric token survives.
  assert.deepEqual(tokens("a1b2c3 99 ok!"), ["a1b2c3"]);
});

test("tokens: empty / whitespace-only input yields no tokens", () => {
  assert.deepEqual(tokens(""), []);
  assert.deepEqual(tokens("   \t\n  "), []);
});

// ---- weight closure -------------------------------------------------------

test("SALIENCY_WEIGHT_SUM closes to 1 so score stays in [0,1]", () => {
  approx(SALIENCY_WEIGHT_SUM, 1);
});

// ---- emotion term (importance passthrough with 0.3 floor) -----------------

test("emotion: zero-importance memory still admissible at the 0.3 floor", () => {
  const b = computeSaliency(mem({ importance: 0 }), baseCtx());
  approx(b.emotion, 0.3);
});

test("emotion: importance 1 maps to 1.0, and out-of-range importance is clamped", () => {
  approx(computeSaliency(mem({ importance: 1 }), baseCtx()).emotion, 1);
  // importance > 1 clamps to 1 before the curve -> still 1.0
  approx(computeSaliency(mem({ importance: 5 }), baseCtx()).emotion, 1);
  // negative importance clamps to 0 -> floor 0.3
  approx(computeSaliency(mem({ importance: -3 }), baseCtx()).emotion, 0.3);
});

// ---- goalRelevance term ---------------------------------------------------

test("goalRelevance: zero with no active goals (no prior)", () => {
  assert.equal(computeSaliency(mem(), baseCtx({ activeGoals: [] })).goalRelevance, 0);
});

test("goalRelevance: full token overlap with a goal scores 1; max over goals wins", () => {
  const m = mem({ content: "deploy kubernetes cluster" });
  const b = computeSaliency(
    m,
    baseCtx({ activeGoals: ["totally unrelated thing", "deploy kubernetes cluster"] }),
  );
  approx(b.goalRelevance, 1);
});

test("goalRelevance: ranks a goal-matching memory above a non-matching one, all else equal", () => {
  const ctx = baseCtx({
    activeGoals: ["optimize database queries"],
    storedNoveltyById: new Map([
      ["match", 0.5],
      ["nomatch", 0.5],
    ]),
  });
  const matching = computeSaliency(
    { id: "match", content: "optimize database queries today", importance: 0.5 },
    ctx,
  );
  const other = computeSaliency(
    { id: "nomatch", content: "unrelated cooking recipe notes", importance: 0.5 },
    ctx,
  );
  assert.ok(matching.goalRelevance > other.goalRelevance);
  assert.ok(matching.score > other.score);
});

// ---- survival term --------------------------------------------------------

test("survival: zero when health is at/above threshold even with survival terms present", () => {
  const m = mem({ content: "health recovery fix crash repair" });
  assert.equal(computeSaliency(m, baseCtx({ organismHealth: 0.5 })).survival, 0);
  assert.equal(computeSaliency(m, baseCtx({ organismHealth: 0.8 })).survival, 0);
});

test("survival: zero when health is low but content has no survival terms", () => {
  const m = mem({ content: "a calm description of flowers and rivers" });
  assert.equal(computeSaliency(m, baseCtx({ organismHealth: 0 })).survival, 0);
});

test("survival: max urgency (health 0) with >=3 survival terms saturates to 1", () => {
  const m = mem({ content: "health recovery fix" }); // 3 terms -> min(1, 3/3)=1
  approx(computeSaliency(m, baseCtx({ organismHealth: 0 })).survival, 1);
});

test("survival: ramps linearly with health and with term count", () => {
  // health 0.25 -> urgency (0.5-0.25)/0.5 = 0.5 ; one term -> min(1,1/3)=1/3
  const m = mem({ content: "please fix this" });
  approx(computeSaliency(m, baseCtx({ organismHealth: 0.25 })).survival, 0.5 * (1 / 3));
});

// ---- uncertainty term -----------------------------------------------------

test("uncertainty: zero when neither context scalar nor per-memory map is set (legacy path)", () => {
  assert.equal(computeSaliency(mem(), baseCtx()).uncertainty, 0);
});

test("uncertainty: context scalar is used and clamped to [0,1]", () => {
  approx(computeSaliency(mem(), baseCtx({ uncertainty: 0.8 })).uncertainty, 0.8);
  approx(computeSaliency(mem(), baseCtx({ uncertainty: 5 })).uncertainty, 1);
});

test("uncertainty: per-memory override wins over the context scalar", () => {
  const ctx = baseCtx({
    uncertainty: 0.9,
    uncertaintyById: new Map([["m1", 0.2]]),
  });
  approx(computeSaliency(mem(), ctx).uncertainty, 0.2);
});

// ---- novelty term ---------------------------------------------------------

test("novelty: stored value is used and clamped; non-finite stored falls back", () => {
  approx(computeSaliency(mem(), baseCtx({ storedNoveltyById: new Map([["m1", 0.9]]) })).novelty, 0.9);
  approx(computeSaliency(mem(), baseCtx({ storedNoveltyById: new Map([["m1", 2]]) })).novelty, 1);
  // NaN is non-finite -> fallback to query dissimilarity. Empty query -> jaccard 0 -> (1-0)*0.7
  approx(
    computeSaliency(mem(), baseCtx({ query: "", storedNoveltyById: new Map([["m1", NaN]]) })).novelty,
    0.7,
  );
});

test("novelty fallback: identical query and content => low novelty (high overlap)", () => {
  // No stored novelty -> fallback path. query == content -> jaccard 1 -> (1-1)*0.7 = 0
  const ctx: SaliencyContext = { query: "deploy kubernetes cluster", activeGoals: [], organismHealth: 1 };
  approx(computeSaliency(mem({ content: "deploy kubernetes cluster" }), ctx).novelty, 0);
});

// ---- beliefRelevance term ---------------------------------------------------

test("beliefRelevance: zero when activeBeliefs is absent or empty (legacy path)", () => {
  assert.equal(computeSaliency(mem(), baseCtx()).beliefRelevance, 0);
  assert.equal(computeSaliency(mem(), baseCtx({ activeBeliefs: [] })).beliefRelevance, 0);
});

test("beliefRelevance: full overlap + zero confidence saturates to 1", () => {
  const content = "deploy kubernetes cluster";
  const m = mem({ content });
  const ctx = baseCtx({ activeBeliefs: [{ statement: content, confidence: 0 }] });
  approx(computeSaliency(m, ctx).beliefRelevance, 1);
});

test("beliefRelevance: a settled belief (confidence 1) contributes nothing even with full overlap", () => {
  const content = "deploy kubernetes cluster";
  const m = mem({ content });
  const ctx = baseCtx({ activeBeliefs: [{ statement: content, confidence: 1 }] });
  approx(computeSaliency(m, ctx).beliefRelevance, 0);
});

test("beliefRelevance: max over multiple beliefs wins, not sum", () => {
  const m = mem({ content: "deploy kubernetes cluster" });
  const ctx = baseCtx({
    activeBeliefs: [
      { statement: "totally unrelated topic", confidence: 0 },
      { statement: "deploy kubernetes cluster", confidence: 0.5 },
    ],
  });
  // Best match: sim=1 * (1-0.5) = 0.5 — not clamped by the unrelated belief.
  approx(computeSaliency(m, ctx).beliefRelevance, 0.5);
});

// ---- blended score --------------------------------------------------------

test("score: weighted blend matches the documented weights", () => {
  // novelty 1, goal 1, emotion 1, survival 0 (health high), uncertainty 1,
  // belief 0 (no activeBeliefs) => 0.20 + 0.30 + 0.25 + 0 + 0.10 + 0 = 0.85
  const m = mem({ content: "deploy kubernetes cluster", importance: 1 });
  const ctx = baseCtx({
    activeGoals: ["deploy kubernetes cluster"],
    organismHealth: 1,
    uncertainty: 1,
    storedNoveltyById: new Map([["m1", 1]]),
  });
  approx(computeSaliency(m, ctx).score, 0.85);
});

test("score: all six terms maxed (incl. survival + belief) reaches 1.0", () => {
  const content = "health recovery fix deploy kubernetes cluster";
  const m = mem({ content, importance: 1 });
  const ctx = baseCtx({
    activeGoals: [content], // full token overlap -> goalRelevance 1
    organismHealth: 0, // urgency 1, 3+ survival terms -> survival 1
    uncertainty: 1,
    storedNoveltyById: new Map([["m1", 1]]),
    // full token overlap + confidence 0 -> weighted sim*(1-conf) = 1
    activeBeliefs: [{ statement: content, confidence: 0 }],
  });
  approx(computeSaliency(m, ctx).score, 1);
});

test("score: always within [0,1] and the call is deterministic", () => {
  const m = mem({ content: "health crash fix deploy cluster", importance: 0.7 });
  const ctx = baseCtx({
    query: "deploy cluster",
    activeGoals: ["deploy cluster", "fix crash"],
    organismHealth: 0.1,
    uncertainty: 0.6,
    storedNoveltyById: new Map([["m1", 0.4]]),
  });
  const a = computeSaliency(m, ctx);
  const b = computeSaliency(m, ctx);
  assert.ok(a.score >= 0 && a.score <= 1);
  assert.deepEqual(a, b);
});
