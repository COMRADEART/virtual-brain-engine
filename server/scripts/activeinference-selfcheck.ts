// active inference selfcheck — gate for the C3 keystone loop-closure slice.
//
// Pure-math + persistence, all hermetic (temp DB via BRAIN_DB_PATH):
//   (A) buildActiveInferenceContext: null/none prediction -> 0; arousal/ACh fold
//       to above-baseline.
//   (B) expectedFreeEnergy: monotone in retrieval gap / uncertainty; energy
//       deficit dampens.
//   (C) NO-REGRESSION FLOOR: a sub-warm policy NEVER acts, even at max EFE
//       (decide -> "defer", broaden/augment false) — the cold-brain guarantee.
//   (D) thresholds: a warm (zero-weight) policy holds on low EFE, broadens on
//       high EFE, and adds the web vote only at very high EFE.
//   (E) learning: learnActiveInference moves predictSurprise toward the realised
//       surprise and increments observations.
//   (F) egress safety: decide() is pure (augment is only a VOTE; no network is
//       reachable from this module — it has no fetch import).
//   (G) persistence round-trip via brain_metadata.
//
// Run: npm --prefix server run activeinference:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-aicheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const ai = await import("../src/reasoning/activeInference.js");
import type { ActiveInferenceContext } from "../../shared/activeInference.js";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb();

const HIGH_EFE: ActiveInferenceContext = {
  expectedTopScore: 0.1,
  expectedConfidence: 0.2,
  uncertainty: 0.8,
  arousal: 0.3,
  cholinergic: 0.2,
  energyDeficit: 0,
};
const MAX_EFE: ActiveInferenceContext = {
  expectedTopScore: 0,
  expectedConfidence: 0,
  uncertainty: 1,
  arousal: 1,
  cholinergic: 1,
  energyDeficit: 0,
};
const LOW_EFE: ActiveInferenceContext = {
  expectedTopScore: 0.95,
  expectedConfidence: 0.9,
  uncertainty: 0.05,
  arousal: 0,
  cholinergic: 0,
  energyDeficit: 0,
};

// =============================================================================
// (A) buildActiveInferenceContext
// =============================================================================
const ctxNull = ai.buildActiveInferenceContext({
  prediction: null,
  uncertainty: 0.5,
  norepinephrine: 0.5,
  acetylcholine: 0.7,
});
check("null prediction -> expectedTopScore 0", ctxNull.expectedTopScore === 0);
check("arousal folds to above-baseline (NE 0.5 -> 0.3)", Math.abs(ctxNull.arousal - 0.3) < 1e-9, `${ctxNull.arousal}`);
check("cholinergic folds to above-baseline (ACh 0.7 -> 0.5)", Math.abs(ctxNull.cholinergic - 0.5) < 1e-9, `${ctxNull.cholinergic}`);
const ctxNone = ai.buildActiveInferenceContext({
  prediction: { expectedTopScore: 0.9, expectedConfidence: 0.9, basis: "none" },
  uncertainty: 0,
  norepinephrine: 0.2,
  acetylcholine: 0.2,
});
check("basis 'none' prediction is ignored (expectedTopScore 0)", ctxNone.expectedTopScore === 0);

// =============================================================================
// (B) expectedFreeEnergy
// =============================================================================
check("EFE higher for a big retrieval gap than a small one", ai.expectedFreeEnergy(HIGH_EFE) > ai.expectedFreeEnergy(LOW_EFE));
const drained: ActiveInferenceContext = { ...HIGH_EFE, energyDeficit: 1 };
check("energy deficit dampens EFE (foraging is costly when depleted)", ai.expectedFreeEnergy(drained) < ai.expectedFreeEnergy(HIGH_EFE));
check("EFE stays in [0,1]", ai.expectedFreeEnergy(MAX_EFE) <= 1 && ai.expectedFreeEnergy(LOW_EFE) >= 0);

// =============================================================================
// (C) NO-REGRESSION FLOOR — a sub-warm policy never acts
// =============================================================================
const cold = ai.emptyActiveInferencePolicy();
const coldDecision = ai.decideActiveInference(MAX_EFE, cold);
check(
  "cold policy DEFERS even at max EFE (no perturbation on a cold brain)",
  coldDecision.acted === false && coldDecision.broaden === false && coldDecision.augment === false && coldDecision.action === "defer",
  JSON.stringify(coldDecision),
);
const almostWarm = { weights: new Array<number>(ai.FEATURE_DIM).fill(0), observations: ai.WARM_AT - 1 };
check("a policy one short of WARM_AT still defers", ai.decideActiveInference(MAX_EFE, almostWarm).acted === false);

// =============================================================================
// (D) thresholds — a warm, zero-weight policy (predictSurprise = 0.5)
// =============================================================================
const warm = { weights: new Array<number>(ai.FEATURE_DIM).fill(0), observations: ai.WARM_AT };
const lowDec = ai.decideActiveInference(LOW_EFE, warm);
check("warm policy HOLDS on low EFE (no needless foraging)", lowDec.acted === false && lowDec.action === "hold", JSON.stringify(lowDec));
const highDec = ai.decideActiveInference(HIGH_EFE, warm);
check("warm policy BROADENS on high EFE", highDec.broaden === true && highDec.action === "broaden", JSON.stringify(highDec));
const maxDec = ai.decideActiveInference(MAX_EFE, warm);
check("warm policy adds the WEB vote at very high EFE", maxDec.broaden === true && maxDec.augment === true && maxDec.action === "forage+web", JSON.stringify(maxDec));

// =============================================================================
// (E) learning — predictSurprise tracks realised surprise; observations grow
// =============================================================================
let policy = ai.emptyActiveInferencePolicy();
const before = ai.predictSurprise(HIGH_EFE, policy);
for (let i = 0; i < 40; i++) policy = ai.learnActiveInference(policy, HIGH_EFE, 0.9);
const after = ai.predictSurprise(HIGH_EFE, policy);
check("predictSurprise rises toward a high realised surprise after learning", after > before + 0.05, `before=${before.toFixed(3)} after=${after.toFixed(3)}`);
check("learning increments observations", policy.observations === 40, `obs=${policy.observations}`);
let lowPolicy = ai.emptyActiveInferencePolicy();
for (let i = 0; i < 40; i++) lowPolicy = ai.learnActiveInference(lowPolicy, LOW_EFE, 0.05);
check("predictSurprise stays low for a low-surprise context", ai.predictSurprise(LOW_EFE, lowPolicy) < 0.5, `${ai.predictSurprise(LOW_EFE, lowPolicy).toFixed(3)}`);

// =============================================================================
// (F) egress safety — decide is pure, augment is a vote (no network reachable)
// =============================================================================
let threw = false;
try {
  ai.decideActiveInference(MAX_EFE, warm); // must not reach out anywhere
} catch {
  threw = true;
}
check("decideActiveInference is pure (no throw, no I/O)", threw === false);

// =============================================================================
// (G) persistence round-trip
// =============================================================================
ai.saveActiveInferenceState(policy);
const loaded = ai.loadActiveInferenceState();
check(
  "save -> load round-trips weights + observations",
  loaded.observations === policy.observations && loaded.weights.length === ai.FEATURE_DIM && Math.abs(loaded.weights[1] - policy.weights[1]) < 1e-9,
  `obs=${loaded.observations}`,
);

// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
