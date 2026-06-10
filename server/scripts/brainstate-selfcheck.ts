// Central cognitive loop / BrainState selfcheck — hermetic (throwaway DB via
// BRAIN_DB_PATH, no LLM, no network). Mirrors attention-selfcheck.ts.
//
// Run: npm --prefix server run brainstate:selfcheck
//
// Asserts:
//   (A) PURE helpers: capWorking caps + evicts lowest; decayWorking decreases
//       activation monotonically and evicts below the floor; shouldReReason
//       fires once below the floor and never above; extractWorkingItems makes a
//       query head + salient facts.
//   (B) The loop methods over a real (temp) DB: perceive pushes items; attend
//       records a score-sorted attention map in [0,1]; recordReasoning persists
//       confidence + cycle count; priorUncertainty = 1 - confidence (the
//       feed-forward); a low-confidence cycle pushes an "open-question" item.
//   (C) Persistence: state rehydrates across a reset singleton (KV upsert).
//   (D) tickDecay ages the workspace; the bus emits a `brain-state` event.
//   (E) Failure isolation: with organism_state dropped, no public method throws.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// Throwaway DB BEFORE importing anything that opens it.
const tmp = mkdtempSync(join(tmpdir(), "brain-bstate-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  capWorking,
  decayWorking,
  shouldReReason,
  extractWorkingItems,
  createBrainState,
  getBrainState,
  shouldBroadenRetrieval,
  __resetBrainStateForTests,
  __createBrainStateForTests,
} = await import("../src/core/brainState.js");
const { getEventBus } = await import("../src/core/eventBus.js");
const { openDb } = await import("../src/db/sqlite.js");
const {
  WORKING_CAPACITY,
  WORKING_FLOOR,
  RE_REASON_CONFIDENCE_FLOOR,
} = await import("../../shared/brainState.js");
import type { WorkingItem } from "../../shared/brainState.js";

openDb(); // applies schema → organism_state, ranker_*, goal_history, etc.

// -----------------------------------------------------------------------------
// (A) PURE helpers.
// -----------------------------------------------------------------------------

function item(id: string, activation: number): WorkingItem {
  return { id, label: id, kind: "fact", activation, at: "2026-01-01T00:00:00.000Z" };
}

// capWorking: > capacity keeps exactly capacity, evicting the LOWEST activation.
{
  const many: WorkingItem[] = Array.from({ length: WORKING_CAPACITY + 3 }, (_, i) =>
    item(`m${i}`, (i + 1) / (WORKING_CAPACITY + 3)),
  );
  const capped = capWorking(many);
  check("capWorking keeps exactly WORKING_CAPACITY", capped.length === WORKING_CAPACITY, `len=${capped.length}`);
  const minActivation = Math.min(...capped.map((c) => c.activation));
  const evictedMax = Math.max(...many.filter((m) => !capped.includes(m)).map((m) => m.activation));
  check("capWorking evicts the lowest-activation items", minActivation >= evictedMax);
  check("capWorking no-ops under capacity", capWorking([item("a", 0.5)]).length === 1);
}

// decayWorking: activation strictly decreases with dt; below-floor items evicted.
{
  const items = [item("hot", 1), item("warm", 0.3)];
  const after1m = decayWorking(items, 60_000);
  check("decayWorking reduces activation", (after1m.find((i) => i.id === "hot")?.activation ?? 1) < 1);
  check(
    "decayWorking is monotonic with dt",
    (decayWorking(items, 120_000).find((i) => i.id === "hot")?.activation ?? 1) <
      (after1m.find((i) => i.id === "hot")?.activation ?? 1),
  );
  // After enough decay a low item drops below the floor and is evicted.
  const longGone = decayWorking([item("faint", WORKING_FLOOR + 0.01)], 600_000);
  check("decayWorking evicts items below the floor", longGone.length === 0, `len=${longGone.length}`);
  check("decayWorking dt<=0 is a safe no-decay", (decayWorking(items, 0).find((i) => i.id === "hot")?.activation ?? 0) === 1);
}

// shouldReReason: fires once below the floor, never above, never when flagged.
check("shouldReReason: below floor + unflagged → true", shouldReReason(RE_REASON_CONFIDENCE_FLOOR - 0.1, false) === true);
check("shouldReReason: below floor but already flagged → false", shouldReReason(0.1, true) === false);
check("shouldReReason: above floor → false", shouldReReason(0.9, false) === false);

// shouldBroadenRetrieval: the BEHAVIORAL feed-forward gate (high prior
// uncertainty broadens retrieval; cold brain at 0 must NOT broaden).
check("shouldBroadenRetrieval: high prior uncertainty → true", shouldBroadenRetrieval(0.7) === true);
check("shouldBroadenRetrieval: low prior uncertainty → false", shouldBroadenRetrieval(0.2) === false);
check("shouldBroadenRetrieval: cold brain (0) → false (first query unperturbed)", shouldBroadenRetrieval(0) === false);

// extractWorkingItems: a query head + salient fact tokens.
{
  const items = extractWorkingItems("How do I recover the brain engine after a crash?");
  check("extractWorkingItems yields a query head", items[0]?.kind === "query");
  check("extractWorkingItems yields >=1 item, <=3", items.length >= 1 && items.length <= 3, `len=${items.length}`);
  check("extractWorkingItems facts are tokens", items.slice(1).every((i) => i.kind === "fact"));
  check("extractWorkingItems handles empty prompt", extractWorkingItems("   ").length >= 1);
  // Activation values matter (capWorking/decayWorking order by them) — assert them.
  check(
    "extractWorkingItems sets head activation=1, fact activation=0.8",
    items[0]?.activation === 1 && items.slice(1).every((i) => i.activation === 0.8),
  );
  // Repeated tokens must be deduplicated (the `seen` Set in extractWorkingItems).
  const dedup = extractWorkingItems("recover recover crash crash crash");
  const factLabels = dedup.slice(1).map((i) => i.label);
  check(
    "extractWorkingItems deduplicates repeated tokens",
    new Set(factLabels).size === factLabels.length,
    `facts=${JSON.stringify(factLabels)}`,
  );
}

// -----------------------------------------------------------------------------
// (B) Loop methods over the temp DB.
// -----------------------------------------------------------------------------

const bus = getEventBus();
const loop = createBrainState(bus);

loop.perceive("How do I recover the brain engine after a crash?");
let snap = loop.snapshot();
check("perceive pushes working memory", snap.workingMemory.length >= 1, `wm=${snap.workingMemory.length}`);
check("perceive sets a query head", snap.workingMemory.some((w) => w.kind === "query"));

loop.attend([
  { id: "a", label: "low", score: 0.2, breakdown: { novelty: 0.2, goalRelevance: 0, emotion: 0.3, survival: 0, uncertainty: 0 } },
  { id: "b", label: "high", score: 0.8, breakdown: { novelty: 0.5, goalRelevance: 0.9, emotion: 0.4, survival: 0, uncertainty: 0.1 } },
]);
snap = loop.snapshot();
check("attend records the attention map", snap.attention.length === 2);
check("attend sorts attention by score desc", snap.attention[0]?.id === "b", `top=${snap.attention[0]?.id}`);
check("attention scores in [0,1]", snap.attention.every((f) => f.score >= 0 && f.score <= 1));

// A confident cycle: confidence persisted, priorUncertainty = 1 - confidence.
loop.recordReasoning({ prompt: "well-grounded query", confidence: 0.8, citedCount: 3 });
snap = loop.snapshot();
check("recordReasoning persists confidence", Math.abs(snap.confidence - 0.8) < 1e-9, `c=${snap.confidence}`);
check("priorUncertainty = 1 - confidence (feed-forward)", Math.abs(snap.priorUncertainty - 0.2) < 1e-9, `pu=${snap.priorUncertainty}`);
check("recordReasoning increments cycle count", snap.cycles === 1, `cycles=${snap.cycles}`);
check("lastCycle is recorded", snap.lastCycle?.citedCount === 3 && snap.lastCycle?.lowConfidence === false);

// A low-confidence cycle flags an open-question working item (deferred metacognition).
const r = loop.recordReasoning({ prompt: "an obscure unanswerable question", confidence: 0.1, citedCount: 0 });
check("recordReasoning flags low confidence", r.lowConfidence === true);
snap = loop.snapshot();
check("low-confidence cycle pushes an open-question item", snap.workingMemory.some((w) => w.kind === "open-question"));
check("low-confidence raises priorUncertainty", snap.priorUncertainty > 0.8, `pu=${snap.priorUncertainty}`);
check("cycle count advances again", snap.cycles === 2, `cycles=${snap.cycles}`);

// -----------------------------------------------------------------------------
// (C) Persistence — state rehydrates across a fresh singleton.
// -----------------------------------------------------------------------------

__resetBrainStateForTests();
const reborn = getBrainState();
const rsnap = reborn.snapshot();
check("state persists across a reset singleton (cycles)", rsnap.cycles === 2, `cycles=${rsnap.cycles}`);
check("state persists across a reset singleton (confidence)", Math.abs(rsnap.confidence - 0.1) < 1e-9, `c=${rsnap.confidence}`);
check("state persists across a reset singleton (working memory)", rsnap.workingMemory.length >= 1);

// -----------------------------------------------------------------------------
// (D) tickDecay ages the workspace; the bus emits a brain-state event.
// -----------------------------------------------------------------------------

const beforeTick = reborn.snapshot().workingMemory.map((w) => w.activation);
let gotEvent = false;
const off = bus.on("brain-state", () => {
  gotEvent = true;
});
// Big dt so at least one item should drop below the floor / all shrink.
reborn.tickDecay(600_000);
off();
const afterTick = reborn.snapshot().workingMemory.map((w) => w.activation);
check(
  "tickDecay reduces or evicts working memory",
  afterTick.length < beforeTick.length || afterTick.every((a, i) => beforeTick[i] === undefined || a <= beforeTick[i]),
);
check("tickDecay emits a brain-state bus event", gotEvent === true);

// snapshot is JSON-serializable (it crosses the bus + the API).
let serializable = true;
try {
  JSON.parse(JSON.stringify(reborn.snapshot()));
} catch {
  serializable = false;
}
check("snapshot is JSON-serializable", serializable);

// -----------------------------------------------------------------------------
// (D.6) Throttle + per-method emit + caps + within-cycle flag. Uses clock-
//       injected NON-singleton instances on clean slates (delete the KV row),
//       so the throttle is deterministic and prior sections don't bleed in.
// -----------------------------------------------------------------------------

const zeroBreak = { novelty: 0, goalRelevance: 0, emotion: 0, survival: 0, uncertainty: 0 };

// Throttle: attend() emits; a rapid second emit is suppressed; once the window
// elapses recordReasoning() emits too (proving BOTH methods emit, not just one).
{
  openDb().prepare("DELETE FROM organism_state").run();
  let clk = 1_000_000;
  const tl = __createBrainStateForTests(bus, () => clk);
  let emitCount = 0;
  const offT = bus.on("brain-state", () => {
    emitCount += 1;
  });
  tl.attend([{ id: "x", label: "x", score: 0.5, breakdown: zeroBreak }]);
  check("attend emits a brain-state event", emitCount === 1, `count=${emitCount}`);
  tl.recordReasoning({ prompt: "p", confidence: 0.8, citedCount: 1 });
  check("emitSnapshot throttles a rapid second emit", emitCount === 1, `count=${emitCount}`);
  clk += 2_000; // advance past SNAPSHOT_THROTTLE_MS (1500ms)
  tl.recordReasoning({ prompt: "p2", confidence: 0.7, citedCount: 1 });
  check("recordReasoning emits after the throttle window elapses", emitCount === 2, `count=${emitCount}`);
  offT();
}

// MAX_ATTENTION cap: attend(>8) keeps exactly the top 8 by score.
{
  openDb().prepare("DELETE FROM organism_state").run();
  const tl = __createBrainStateForTests(bus, () => 2_000_000);
  tl.attend(
    Array.from({ length: 12 }, (_, i) => ({
      id: `a${i}`,
      label: `a${i}`,
      score: 1 - i / 12,
      breakdown: zeroBreak,
    })),
  );
  const att = tl.snapshot().attention;
  check("attend caps the attention map at 8", att.length === 8, `len=${att.length}`);
  check(
    "attend keeps the highest-score foci, sorted desc",
    att[0]?.id === "a0" && att[0].score >= (att.at(-1)?.score ?? 0),
  );
}

// perceive merges with EXISTING working memory and caps at WORKING_CAPACITY.
{
  openDb().prepare("DELETE FROM organism_state").run();
  const pl = __createBrainStateForTests(bus, () => 3_000_000);
  pl.perceive("alpha beta gamma delta epsilon zeta");
  pl.perceive("eta theta iota kappa lambda");
  pl.perceive("nu xi omicron pi rho sigma");
  const wm = pl.snapshot().workingMemory;
  check("perceive caps merged working memory at WORKING_CAPACITY", wm.length === WORKING_CAPACITY, `len=${wm.length}`);
  check("perceive retains query heads (highest activation) after capping", wm.some((w) => w.kind === "query"));
}

// recordReasoning within-cycle guard: two low-confidence calls (no perceive
// between) push only ONE open-question item (proves flaggedLowConf threads).
{
  openDb().prepare("DELETE FROM organism_state").run();
  const fl = __createBrainStateForTests(bus, () => 4_000_000);
  fl.recordReasoning({ prompt: "q1", confidence: 0.1, citedCount: 0 });
  fl.recordReasoning({ prompt: "q2", confidence: 0.1, citedCount: 0 });
  const oq = fl.snapshot().workingMemory.filter((w) => w.kind === "open-question").length;
  check("recordReasoning flags low-confidence at most once per cycle", oq === 1, `open-questions=${oq}`);
}

// -----------------------------------------------------------------------------
// (D.7) Per-conversation isolation — BrainState is keyed by conversation, so
//       concurrent asks can no longer corrupt each other's working memory or
//       feed-forward signal (the old singleton was last-writer-wins).
// -----------------------------------------------------------------------------

{
  openDb().prepare("DELETE FROM organism_state").run();
  const cl = __createBrainStateForTests(bus, () => 5_000_000);

  cl.perceive("question about apples", "convA");
  cl.recordReasoning({ prompt: "question about apples", confidence: 0.1, citedCount: 0 }, "convA");
  cl.perceive("question about rockets", "convB");
  cl.recordReasoning({ prompt: "question about rockets", confidence: 0.9, citedCount: 4 }, "convB");

  check(
    "feed-forward uncertainty is per-conversation (A uncertain)",
    Math.abs(cl.priorUncertainty("convA") - 0.9) < 1e-9,
    `puA=${cl.priorUncertainty("convA")}`,
  );
  check(
    "feed-forward uncertainty is per-conversation (B confident)",
    Math.abs(cl.priorUncertainty("convB") - 0.1) < 1e-9,
    `puB=${cl.priorUncertainty("convB")}`,
  );
  check("global state is untouched by keyed cycles", cl.priorUncertainty() === 0);

  const snapA = cl.snapshot("convA");
  const snapB = cl.snapshot("convB");
  check("working memory does not leak across conversations",
    snapA.workingMemory.some((w) => w.label.includes("apples")) &&
    !snapA.workingMemory.some((w) => w.label.includes("rockets")) &&
    snapB.workingMemory.some((w) => w.label.includes("rockets")));
  check("cycle counts are per-conversation", snapA.cycles === 1 && snapB.cycles === 1,
    `A=${snapA.cycles} B=${snapB.cycles}`);
  check("A's low-confidence open-question stays in A",
    snapA.workingMemory.some((w) => w.kind === "open-question") &&
    !snapB.workingMemory.some((w) => w.kind === "open-question"));

  // No-arg snapshot = the most recently active conversation (B wrote last).
  const latest = cl.snapshot();
  check("no-arg snapshot returns the most recently active state",
    Math.abs(latest.confidence - 0.9) < 1e-9, `c=${latest.confidence}`);

  // The within-cycle low-confidence flag is per-conversation too.
  cl.recordReasoning({ prompt: "still unsure", confidence: 0.1, citedCount: 0 }, "convB");
  check("low-confidence flag in A does not consume B's",
    cl.snapshot("convB").workingMemory.some((w) => w.kind === "open-question"));
}

// tickDecay prunes conversation states idle past the TTL; the global state
// survives.
{
  openDb().prepare("DELETE FROM organism_state").run();
  const { CONVERSATION_STATE_TTL_MS } = await import("../src/core/brainState.js");
  let clk = Date.now();
  const pl = __createBrainStateForTests(bus, () => clk);
  pl.perceive("global thought");
  pl.perceive("conversation thought", "convStale");
  check("stale-prune setup: both states exist",
    pl.snapshot("convStale").workingMemory.length > 0 && pl.priorUncertainty() === 0);
  clk += CONVERSATION_STATE_TTL_MS + 60_000;
  pl.tickDecay(60_000);
  check("tickDecay prunes a conversation state past the TTL",
    pl.snapshot("convStale").workingMemory.length === 0);
  // The global key is never pruned (its working memory may have decayed, but
  // the row survives — cycles/confidence are intact).
  const globalRow = openDb()
    .prepare(`SELECT COUNT(*) AS n FROM organism_state WHERE key = 'brain-state-v1'`)
    .get() as { n: number };
  check("tickDecay never prunes the global state", globalRow.n === 1);
}

// -----------------------------------------------------------------------------
// (E) Failure isolation — drop organism_state; no public method may throw.
// -----------------------------------------------------------------------------

openDb().exec("DROP TABLE IF EXISTS organism_state");
__resetBrainStateForTests();
const broken = getBrainState();
let threw = false;
try {
  broken.perceive("x");
  broken.attend([{ id: "z", label: "z", score: 0.5, breakdown: { novelty: 0, goalRelevance: 0, emotion: 0, survival: 0, uncertainty: 0 } }]);
  broken.recordReasoning({ prompt: "y", confidence: 0.5, citedCount: 1 });
  broken.tickDecay(60_000);
  broken.priorUncertainty();
  broken.snapshot();
} catch {
  threw = true;
}
check("no public method throws when the BrainState table is gone", threw === false);
check("priorUncertainty degrades to 0 with no state", broken.priorUncertainty() === 0);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
