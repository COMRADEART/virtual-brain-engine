// Predictive-processing selfcheck — hermetic (throwaway DB, no LLM).
//
// Run: npm --prefix server run predictive:selfcheck
//
// Asserts:
//   (A) bucketFor is deterministic and word-order independent.
//   (B) The COLD-START contract: no prediction until MIN_GLOBAL_OBS
//       observations → computeSurprise returns 0 / no knowledge gap → the
//       pipeline is unperturbed on a young brain.
//   (C) EMA learning: after warm-up the model predicts from the global stat;
//       a warm BUCKET overrides the global; observation counts advance.
//   (D) Surprise: perfect prediction → ~0; large miss → large; bounded [0,1].
//   (E) Knowledge gap: fires exactly when the brain EXPECTED to know
//       (≥ KNOW_FLOOR) and didn't (≤ GAP_CEIL); never on a cold model.
//   (F) Persistence round-trips through brain_metadata; a broken store
//       degrades to the empty state (no throw).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-predictive-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  MIN_GLOBAL_OBS,
  MIN_BUCKET_OBS,
  KNOW_FLOOR,
  GAP_CEIL,
  bucketFor,
  emptyPredictiveState,
  predictRetrieval,
  computeSurprise,
  observeRetrieval,
  loadPredictiveState,
  savePredictiveState,
} = await import("../src/reasoning/predictiveProcessing.js");
const { openDb } = await import("../src/db/sqlite.js");

openDb();

// (A) bucketFor.
check("bucketFor deterministic", bucketFor("how do I deploy") === bucketFor("how do I deploy"));
check("bucketFor word-order independent", bucketFor("deploy the server") === bucketFor("server the deploy"));
check("bucketFor shaped like a bucket key", /^b\d+$/.test(bucketFor("anything at all")));

// (B) Cold start.
{
  const cold = emptyPredictiveState();
  const p = predictRetrieval(cold, "what is my deploy script");
  check("cold model predicts nothing", p.basis === "none");
  const sr = computeSurprise(p, { topScore: 0.9, confidence: 0.9 });
  check("no prediction → zero surprise", sr.surprise === 0);
  check("no prediction → no knowledge gap", sr.knowledgeGap === false);
}

// (C) EMA learning + bucket override.
{
  let state = emptyPredictiveState();
  // Warm the GLOBAL stat with strong retrievals on diverse queries.
  const queries = ["alpha one", "beta two", "gamma three", "delta four", "epsilon five", "zeta six"];
  for (const q of queries.slice(0, MIN_GLOBAL_OBS)) {
    state = observeRetrieval(state, q, { topScore: 0.8, confidence: 0.7 });
  }
  check("observations advance", state.observations === MIN_GLOBAL_OBS);
  const p = predictRetrieval(state, "a brand new unseen question");
  check("warm global predicts", p.basis === "global" && p.expectedTopScore > 0.5, `basis=${p.basis} top=${p.expectedTopScore.toFixed(2)}`);

  // Warm one BUCKET with weak retrievals — it must override the global.
  const bucketQuery = "obscure niche topic xyzzy";
  for (let i = 0; i < MIN_BUCKET_OBS; i += 1) {
    state = observeRetrieval(state, bucketQuery, { topScore: 0.1, confidence: 0.2 });
  }
  const pb = predictRetrieval(state, bucketQuery);
  check("warm bucket overrides the global", pb.basis === "bucket" && pb.expectedTopScore < p.expectedTopScore, `basis=${pb.basis} top=${pb.expectedTopScore.toFixed(2)}`);

  // (D) Surprise magnitudes.
  const exact = computeSurprise(p, { topScore: p.expectedTopScore, confidence: p.expectedConfidence });
  check("perfect prediction → ~zero surprise", exact.surprise < 1e-9);
  const miss = computeSurprise(p, { topScore: 0, confidence: 0 });
  check("large miss → large surprise", miss.surprise > 0.3, `s=${miss.surprise.toFixed(2)}`);
  check("surprise bounded [0,1]", miss.surprise <= 1 && exact.surprise >= 0);

  // (E) Knowledge gap.
  const confident = { expectedTopScore: Math.max(KNOW_FLOOR, 0.7), expectedConfidence: 0.7, basis: "global" as const };
  check("expected-to-know + weak actual → knowledge gap", computeSurprise(confident, { topScore: GAP_CEIL, confidence: 0.2 }).knowledgeGap === true);
  check("expected-to-know + strong actual → no gap", computeSurprise(confident, { topScore: 0.8, confidence: 0.8 }).knowledgeGap === false);
  const humble = { expectedTopScore: 0.2, expectedConfidence: 0.2, basis: "global" as const };
  check("didn't expect to know → no gap even when weak", computeSurprise(humble, { topScore: 0.1, confidence: 0.1 }).knowledgeGap === false);

  // (F) Persistence.
  savePredictiveState(state);
  const reloaded = loadPredictiveState();
  check("state round-trips through brain_metadata", reloaded.observations === state.observations && predictRetrieval(reloaded, bucketQuery).basis === "bucket");
}

// Broken store degrades.
openDb().exec("DROP TABLE IF EXISTS brain_metadata");
let threw = false;
let degraded = null;
try {
  degraded = loadPredictiveState();
  savePredictiveState(emptyPredictiveState());
} catch {
  threw = true;
}
check("broken store: no throw, empty state", threw === false && degraded !== null && degraded.observations === 0);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
