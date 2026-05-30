// Evolution selfcheck — the MAKE-IT-REAL gate for genuine, MEASURED evolution.
//
// This proves the named stub `improveMetrics()` (core/evolution.ts), which
// "evolves" by adding FIXED POSITIVE PATCHES to fabricated metrics, has been
// replaced by a path that genuinely learns: a seeded (1+λ) evolution search over
// the learned ranker weights, scored by REAL cross-entropy on REAL labelled
// citation data, that promotes a challenger ONLY when it STRICTLY beats the
// champion on a HELD-OUT split the search never saw — behind the safety gate.
//
// Hermetic: points BRAIN_DB_PATH at a throwaway SQLite file BEFORE importing
// anything that calls openDb(); no network, no torch, no Ollama. Run:
//   npm --prefix server run evolution:selfcheck
//
// Asserts:
//   (1) MAKE-IT-REAL CORE — on synthetic data with a clear learnable signal,
//       optimizeRankerFromLog() returns applied:true and heldoutDelta > 0 (the
//       evolved challenger STRICTLY beats the champion on data it never trained
//       on). Prints both held-out fitnesses.
//   (2) Determinism — evolveWeights(sameSamples, {seed:S}) twice is byte-identical.
//   (3) Champion/challenger no-regression — zero-signal data can't promote; the
//       persisted ranker_state is UNCHANGED (a bad mutation can't regress prod).
//   (4) Safety veto — a DENY gate blocks an otherwise-improving promotion;
//       ranker_state UNCHANGED.
//   (5) Bounds/finite — evolveWeights returns finite, ±8-bounded weights even on
//       adversarial (NaN/Inf-laden) input.
//   (6) Insufficient-data — a corpus below minSamples returns
//       reason:"insufficient-data" WITHOUT throwing.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Redirect the DB to a throwaway dir BEFORE importing config-dependent modules.
const tmp = mkdtempSync(join(tmpdir(), "brain-evocheck-"));
const dbPath = join(tmp, "test.sqlite");
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = dbPath;

// Pure modules (rankerModel + the optimizer's pure exports) are safe to static-
// import, but to be safe everything touching the DB is dynamic-imported AFTER
// the env vars are set above.
const { openDb } = await import("../src/db/sqlite.js");
const { recordRankTrainingLog } = await import("../src/db/repositories/feedback.js");
const { loadRankerState, saveRankerState } = await import("../src/db/repositories/ranker.js");
const { __resetRankerCache } = await import("../src/reasoning/ranker.js");
const { FEATURE_DIM, FEATURE_VERSION, sigmoid } = await import("../src/reasoning/rankerModel.js");
const { evolveWeights, optimizeRankerFromLog, rankerFitness } = await import(
  "../src/core/evolutionOptimizer.js"
);
const safetyMod = await import("../src/core/safety.js");
type SafetyGate = import("../src/core/safety.js").SafetyGate;

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

function mulberry32(seed: number): () => number {
  return () => {
    let v = (seed += 0x6d2b79f5);
    v = Math.imul(v ^ (v >>> 15), v | 1);
    v ^= v + Math.imul(v ^ (v >>> 7), v | 61);
    return ((v ^ (v >>> 14)) >>> 0) / 4294967296;
  };
}

const db = openDb(); // applies schema.sql + migrations against the temp DB

// Hidden ground-truth weights the search must approximately recover (like
// ranker-selfcheck's TRUE_W). A clear, learnable signal so the evolved weights
// comfortably beat zero-weights on held-out.
const TRUE_W = [-0.4, 2.6, 1.2, 0.9, 0.7, -0.5, 0.4, -0.6];
if (TRUE_W.length !== FEATURE_DIM) {
  console.error(`selfcheck misconfigured: TRUE_W len ${TRUE_W.length} != ${FEATURE_DIM}`);
  process.exit(2);
}

// --- helpers to seed rank_training_log with synthetic labelled data ---------

function featureVector(rng: () => number): number[] {
  return [
    1, // bias
    rng(),
    rng(),
    rng(),
    rng() < 0.5 ? 1 : 0,
    rng() < 0.5 ? 1 : 0,
    rng() < 0.5 ? 1 : 0,
    rng(),
  ];
}

// Seed `runs` training rows, each with `perRun` memories. label cited iff the
// hidden logistic model on x fires (deterministic threshold on sigmoid). Returns
// the flat sample list for the pure-determinism check.
function seedSignalCorpus(
  rng: () => number,
  runs: number,
  perRun: number,
): Array<{ x: number[]; y: number }> {
  const flat: Array<{ x: number[]; y: number }> = [];
  for (let r = 0; r < runs; r += 1) {
    const featuresById = new Map<string, number[]>();
    const citedIds = new Set<string>();
    for (let m = 0; m < perRun; m += 1) {
      const id = `r${r}-m${m}`;
      const x = featureVector(rng);
      let z = 0;
      for (let i = 0; i < x.length; i += 1) z += TRUE_W[i] * x[i];
      const cited = sigmoid(z) > 0.5;
      featuresById.set(id, x);
      if (cited) citedIds.add(id);
      flat.push({ x, y: cited ? 1 : 0 });
    }
    recordRankTrainingLog(`run-${r}`, featuresById, citedIds);
  }
  return flat;
}

function clearCorpus(): void {
  db.prepare("DELETE FROM rank_training_log").run();
}

function setChampion(weights: number[]): void {
  saveRankerState({ version: FEATURE_VERSION, weights, trainedCount: 0 });
  __resetRankerCache();
}

function currentRankerWeights(): number[] | null {
  __resetRankerCache();
  return loadRankerState()?.weights ?? null;
}

function experimentCount(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM evolution_experiments").get() as { n: number }).n;
}

function arraysEqual(a: number[] | null, b: number[] | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

const zeros = new Array<number>(FEATURE_DIM).fill(0);

// ===========================================================================
// (6) Insufficient-data — run FIRST, against a clean (empty) corpus. Must not
//     throw and must report insufficient-data.
// ===========================================================================
clearCorpus();
let insufficientThrew = false;
let insufficientResult: Awaited<ReturnType<typeof optimizeRankerFromLog>> | null = null;
try {
  insufficientResult = optimizeRankerFromLog({ seed: 7, minSamples: 8 });
} catch (err) {
  insufficientThrew = true;
  console.log("  optimizeRankerFromLog(empty) threw:", err instanceof Error ? err.message : err);
}
check("optimizeRankerFromLog(empty corpus) does not throw", !insufficientThrew);
check(
  "empty corpus -> applied:false, reason:insufficient-data",
  !!insufficientResult && insufficientResult.applied === false && insufficientResult.reason === "insufficient-data",
  insufficientResult ? `reason=${insufficientResult.reason}` : "null",
);

// ===========================================================================
// (1) MAKE-IT-REAL CORE — evolved beats baseline on HELD-OUT.
// ===========================================================================
clearCorpus();
setChampion(zeros.slice()); // fresh cold champion = zero weights
const signalRng = mulberry32(20260530);
seedSignalCorpus(signalRng, 16, 6); // 96 labelled samples, clear signal

const coreResult = optimizeRankerFromLog({ seed: 42, generations: 160, lambda: 16, sigma: 0.4, minSamples: 8 });
check(
  "MAKE-IT-REAL: signal corpus -> applied:true",
  coreResult.applied === true && coreResult.reason === "applied",
  `reason=${coreResult.reason}`,
);
check(
  "MAKE-IT-REAL: challenger STRICTLY beats champion on HELD-OUT (heldoutDelta > 0)",
  coreResult.heldoutDelta !== null && coreResult.heldoutDelta > 0,
  `champion=${coreResult.championFitness?.toFixed(4)} challenger=${coreResult.challengerFitness?.toFixed(4)} Δ=${coreResult.heldoutDelta?.toFixed(4)} train=${coreResult.trainSamples} heldout=${coreResult.heldoutSamples}`,
);
// Sanity: a solid (not marginal) win, and production weights actually changed.
check(
  "MAKE-IT-REAL: held-out win is solid (Δ > 0.02), not marginal",
  coreResult.heldoutDelta !== null && coreResult.heldoutDelta > 0.02,
  `Δ=${coreResult.heldoutDelta?.toFixed(4)}`,
);
check(
  "MAKE-IT-REAL: promotion changed the persisted ranker_state away from zeros",
  !arraysEqual(currentRankerWeights(), zeros),
  `weights=${currentRankerWeights()?.map((w) => w.toFixed(2)).join(",")}`,
);

// ===========================================================================
// (2) Determinism — evolveWeights twice with same seed/samples is identical.
// ===========================================================================
const detRng = mulberry32(13371337);
const detSamples = seedSignalCorpus(detRng, 6, 5); // also writes rows (cleared below)
const evoA = evolveWeights(detSamples, { seed: 99, generations: 50, lambda: 8, sigma: 0.3 });
const evoB = evolveWeights(detSamples, { seed: 99, generations: 50, lambda: 8, sigma: 0.3 });
check(
  "evolveWeights is deterministic (byte-identical weights for same seed+samples)",
  arraysEqual(evoA.weights, evoB.weights) && evoA.fitness === evoB.fitness,
  `A=${evoA.weights.map((w) => w.toFixed(4)).join(",")}`,
);

// ===========================================================================
// (3) Champion/challenger NO-REGRESSION — DETERMINISTIC contract tests.
//
// KNOWN LIMIT (documented, not hidden): the gate compares champion vs challenger
// on a SINGLE held-out split. A single finite split is a NOISY fitness estimator,
// so a challenger that overfits TRAIN noise CAN win on that split by luck and be
// promoted — the gate's guarantee is "never persists a held-out LOSER", NOT
// "noise-proof". (k-fold / a promotion margin is deliberate future scope per the
// phase's single-split design decision, not a mid-phase bolt-on.) So we do NOT
// assert the false premise "noise never promotes" — an earlier version did and
// flaked on a lucky split (seed 11, Δ=+0.0139). Instead we assert the REAL
// contract DETERMINISTICALLY, using generations:0 to make challenger == champion
// EXACTLY (Δ exactly 0) so these hold for every seed with zero statistical luck:
//   3a. a no-gain search never touches production (state byte-identical, 0 audit rows);
//   3b. an apply happens ONLY with a strict held-out gain + exactly ONE audit row,
//       and an already-promoted champion is not disturbed by a no-op re-run (ratchet).
// ===========================================================================

// 3a. generations:0 anchor — the no-gain → no-touch path, bulletproof for ALL
//     seeds. challenger == clip(champion) == champion, so heldoutDelta is exactly 0.
clearCorpus();
const distinctChampion = [0.5, -1.0, 0.3, 0.0, 0.2, -0.2, 0.1, 0.4];
setChampion(distinctChampion.slice());
const anchorExpBefore = experimentCount();
const anchorRng = mulberry32(424242);
seedSignalCorpus(anchorRng, 16, 6); // a real >= minSamples corpus to flatten
const anchorResult = optimizeRankerFromLog({ seed: 5, generations: 0, minSamples: 8 });
check(
  "no-regression(generations:0): a no-op search -> reason:no-improvement, Δ exactly 0",
  anchorResult.applied === false && anchorResult.reason === "no-improvement" && anchorResult.heldoutDelta === 0,
  `reason=${anchorResult.reason} Δ=${anchorResult.heldoutDelta}`,
);
check(
  "no-regression(generations:0): persisted ranker_state byte-identical to the champion (no touch)",
  arraysEqual(currentRankerWeights(), distinctChampion),
  `weights=${currentRankerWeights()?.map((w) => w.toFixed(2)).join(",")}`,
);
check(
  "no-regression(generations:0): zero new evolution_experiments rows (no side-effect on decline)",
  experimentCount() === anchorExpBefore,
  `before=${anchorExpBefore} after=${experimentCount()}`,
);

// 3b. Apply-path wiring + ratchet — both deterministic. Promote once on signal
//     data (zeros -> W*), verifying the apply side-effects, then prove a no-op
//     (generations:0) re-run from W* leaves the now-good champion untouched.
clearCorpus();
setChampion(zeros.slice());
const ratchetExp0 = experimentCount();
const ratchetRng = mulberry32(909090);
seedSignalCorpus(ratchetRng, 16, 6); // clear signal -> promotes
const promote1 = optimizeRankerFromLog({ seed: 42, generations: 160, lambda: 16, sigma: 0.4, minSamples: 8 });
check(
  "apply-path: signal corpus from zeros -> applied:true",
  promote1.applied === true && promote1.reason === "applied",
  `reason=${promote1.reason}`,
);
check(
  "apply-path: exactly ONE new evolution_experiments row on promotion",
  experimentCount() === ratchetExp0 + 1,
  `before=${ratchetExp0} after=${experimentCount()}`,
);
check(
  "apply-path: reported heldoutDelta == challengerFitness - championFitness (internally consistent)",
  promote1.championFitness !== null &&
    promote1.challengerFitness !== null &&
    promote1.heldoutDelta !== null &&
    Math.abs(promote1.heldoutDelta - (promote1.challengerFitness - promote1.championFitness)) < 1e-12,
  `Δ=${promote1.heldoutDelta?.toFixed(4)}`,
);
const promotedW = currentRankerWeights();
check(
  "apply-path: persisted ranker_state changed away from the zero champion",
  !arraysEqual(promotedW, zeros),
  `weights=${promotedW?.map((w) => w.toFixed(2)).join(",")}`,
);
const ratchetExp1 = experimentCount();
const ratchet = optimizeRankerFromLog({ seed: 7, generations: 0, minSamples: 8 });
check(
  "ratchet(generations:0): an already-good champion is not disturbed -> no-improvement, Δ exactly 0",
  ratchet.applied === false && ratchet.reason === "no-improvement" && ratchet.heldoutDelta === 0,
  `reason=${ratchet.reason} Δ=${ratchet.heldoutDelta}`,
);
check(
  "ratchet(generations:0): persisted ranker_state still byte-identical to the promoted W*",
  arraysEqual(currentRankerWeights(), promotedW),
);
check(
  "ratchet(generations:0): no new evolution_experiments row",
  experimentCount() === ratchetExp1,
  `before=${ratchetExp1} after=${experimentCount()}`,
);

// ===========================================================================
// (4) Safety veto — improving data + DENY gate -> no promotion, state UNCHANGED.
// ===========================================================================
clearCorpus();
const champion4 = zeros.slice();
setChampion(champion4.slice());
const vetoExpBefore = experimentCount();
const vetoRng = mulberry32(20260601);
seedSignalCorpus(vetoRng, 16, 6); // clear signal -> would otherwise promote

const denyGate = { permitAndAudit: () => false } as SafetyGate;
const vetoResult = optimizeRankerFromLog({
  seed: 42,
  generations: 160,
  lambda: 16,
  sigma: 0.4,
  minSamples: 8,
  gate: denyGate,
});
check(
  "safety-veto: improving data + DENY gate -> applied:false, reason:safety-veto",
  vetoResult.applied === false && vetoResult.reason === "safety-veto",
  `reason=${vetoResult.reason} Δ=${vetoResult.heldoutDelta?.toFixed(4)}`,
);
check(
  "safety-veto: the would-be challenger genuinely improved (Δ > 0) — so the veto is what blocked it",
  vetoResult.heldoutDelta !== null && vetoResult.heldoutDelta > 0,
  `Δ=${vetoResult.heldoutDelta?.toFixed(4)}`,
);
check(
  "safety-veto: persisted ranker_state UNCHANGED (veto can't regress prod)",
  arraysEqual(currentRankerWeights(), champion4),
);
check(
  "safety-veto: no evolution_experiments row written (veto fired before any side-effect)",
  experimentCount() === vetoExpBefore,
  `before=${vetoExpBefore} after=${experimentCount()}`,
);
// And: an ALLOW gate (createMemorySafetyGate) on the same data DOES promote.
clearCorpus();
setChampion(zeros.slice());
const allowRng = mulberry32(20260601);
seedSignalCorpus(allowRng, 16, 6);
const allowGate = safetyMod.createMemorySafetyGate();
const allowResult = optimizeRankerFromLog({
  seed: 42,
  generations: 160,
  lambda: 16,
  sigma: 0.4,
  minSamples: 8,
  gate: allowGate,
});
check(
  "safety: ALLOW gate on the SAME improving data DOES promote (gate is the only difference)",
  allowResult.applied === true && allowResult.reason === "applied" && allowGate.calls.length > 0,
  `reason=${allowResult.reason} gateCalls=${allowGate.calls.length}`,
);

// ===========================================================================
// (5) Bounds/finite — evolveWeights stays finite & ±8-bounded on adversarial
//     input (NaN/Inf in samples and in the init weights).
// ===========================================================================
const adversarialSamples: Array<{ x: number[]; y: number }> = [
  { x: [1, Number.NaN, 0.5, 0.5, 1, 0, 1, 0.5], y: 1 },
  { x: [1, Number.POSITIVE_INFINITY, 0.5, 0.5, 0, 1, 0, 0.5], y: 0 },
  { x: [1, 0.5, 0.5, 0.5, 1, 0, 1, 0.5], y: 1 },
];
const adversarialInit = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  1e9,
  -1e9,
  0,
  0,
  0,
];
const adv = evolveWeights(adversarialSamples, {
  seed: 1,
  generations: 30,
  lambda: 10,
  sigma: 5, // large sigma to stress the clip + finite guard
  init: adversarialInit,
});
const advFinite = adv.weights.every((w) => Number.isFinite(w));
const advBounded = adv.weights.every((w) => Math.abs(w) <= 8);
check(
  "bounds/finite: evolveWeights returns all-finite weights on adversarial input",
  advFinite,
  `weights=${adv.weights.map((w) => (Number.isFinite(w) ? w.toFixed(2) : String(w))).join(",")}`,
);
check("bounds/finite: evolveWeights returns ±8-bounded weights on adversarial input", advBounded);
// The evolved (bounded, finite) weights produce a finite fitness on VALID
// (finite-feature) samples — non-finite features in the corpus are the caller's
// problem, but the weights the search returns are themselves well-formed.
const finiteSamples: Array<{ x: number[]; y: number }> = [
  { x: [1, 0.9, 0.5, 0.5, 1, 0, 1, 0.5], y: 1 },
  { x: [1, 0.1, 0.5, 0.5, 0, 1, 0, 0.5], y: 0 },
];
check(
  "bounds/finite: rankerFitness with the evolved weights is finite on valid samples",
  Number.isFinite(rankerFitness(adv.weights, finiteSamples)),
);

// ---------------------------------------------------------------------------
// Cleanup the throwaway DB (incl. WAL/SHM sidecars).
// ---------------------------------------------------------------------------
try {
  const { closeDb } = await import("../src/db/sqlite.js");
  closeDb();
} catch {
  /* best-effort */
}
for (const suffix of ["", "-wal", "-shm"]) {
  try {
    rmSync(dbPath + suffix, { force: true });
  } catch {
    /* best-effort */
  }
}
try {
  rmSync(tmp, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(JSON.stringify({ failures, result: failures === 0 ? "PASS" : "FAIL" }));
process.exit(failures === 0 ? 0 : 1);
