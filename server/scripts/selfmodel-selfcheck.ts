// Self-model (calibration + competence) selfcheck — hermetic (throwaway DB).
//
// Run: npm --prefix server run selfmodel:selfcheck
//
// Asserts:
//   (A) Calibration bins: binIndex maps [0,1] onto the 5 bins; observeOutcome
//       counts; calibrateConfidence passes a COLD bin through EXACTLY (the
//       no-regression contract) and pulls a measured-overconfident bin DOWN.
//   (B) Competence: observeCycle EMAs confidence + grounding per domain;
//       isWeakDomain is false when cold, true for a measured-weak domain;
//       the map is bounded; feedback tallies attach to the domain.
//   (C) confidenceForRun reads routing_log (and returns null for unknown runs).
//   (D) Persistence round-trips; broken store degrades to empty (no throw).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-selfmodel-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  BIN_COUNT,
  MIN_BIN_OBS,
  MIN_COMPETENCE_CYCLES,
  WEAK_COMPETENCE_FLOOR,
  binIndex,
  emptySelfModelState,
  observeOutcome,
  calibrateConfidence,
  domainFor,
  observeCycle,
  observeDomainFeedback,
  isWeakDomain,
  loadSelfModelState,
  saveSelfModelState,
  confidenceForRun,
  calibrationSummary,
} = await import("../src/core/selfModel.js");
const { openDb } = await import("../src/db/sqlite.js");

const db = openDb();

// -----------------------------------------------------------------------------
// (A) Calibration.
// -----------------------------------------------------------------------------

check("binIndex maps 0 to the first bin", binIndex(0) === 0);
check("binIndex maps 1 to the last bin", binIndex(1) === BIN_COUNT - 1);
check("binIndex mid-scale", binIndex(0.5) === Math.floor(0.5 * BIN_COUNT));

{
  let state = emptySelfModelState();
  // COLD: stated confidence passes through EXACTLY.
  check("cold bin passes stated confidence through exactly", calibrateConfidence(state, 0.9) === 0.9);

  // The brain keeps claiming ~0.9 and keeps being wrong → the 0.8-1.0 bin
  // fills with failures → calibrated confidence must drop well below 0.9.
  for (let i = 0; i < MIN_BIN_OBS * 2; i += 1) {
    state = observeOutcome(state, 0.9, false);
  }
  const corrected = calibrateConfidence(state, 0.9);
  check("measured-overconfident bin pulls confidence down", corrected < 0.5, `corrected=${corrected.toFixed(3)}`);
  check("feedback observations tallied", state.feedbackObservations === MIN_BIN_OBS * 2);
  // Other bins remain cold → untouched.
  check("other bins still pass through", calibrateConfidence(state, 0.3) === 0.3);
  // An accurate bin barely moves.
  let good = emptySelfModelState();
  for (let i = 0; i < MIN_BIN_OBS * 4; i += 1) good = observeOutcome(good, 0.9, i % 10 !== 0); // ~90% right
  const kept = calibrateConfidence(good, 0.9);
  check("well-calibrated bin stays near stated", Math.abs(kept - 0.9) < 0.1, `kept=${kept.toFixed(3)}`);
  check("calibrationSummary shapes per bin", calibrationSummary(state).length === BIN_COUNT);
}

// -----------------------------------------------------------------------------
// (B) Competence.
// -----------------------------------------------------------------------------

check("domainFor: project name wins", domainFor("star") === "star");
check("domainFor: empty → (general)", domainFor("") === "(general)" && domainFor(null) === "(general)");

{
  let state = emptySelfModelState();
  check("cold domain is NOT weak (no prior)", isWeakDomain(state, "star") === false);

  // A domain the brain repeatedly fails in becomes measured-weak.
  for (let i = 0; i < MIN_COMPETENCE_CYCLES + 2; i += 1) {
    state = observeCycle(state, { projectName: "darkzone", confidence: 0.1, cited: false });
  }
  check("measured-weak domain detected", isWeakDomain(state, "darkzone") === true);
  const stat = state.competence[domainFor("darkzone")];
  check("competence EMA tracks low confidence", stat.confidence < WEAK_COMPETENCE_FLOOR && stat.grounding === 0);

  // A strong domain is not weak.
  for (let i = 0; i < MIN_COMPETENCE_CYCLES + 2; i += 1) {
    state = observeCycle(state, { projectName: "homefield", confidence: 0.9, cited: true });
  }
  check("strong domain is not weak", isWeakDomain(state, "homefield") === false);

  state = observeDomainFeedback(state, "homefield", 1);
  state = observeDomainFeedback(state, "homefield", -1);
  const hf = state.competence[domainFor("homefield")];
  check("domain feedback tallies", hf.up === 1 && hf.down === 1);

  // Bounded map: pour in many domains; the cap holds.
  for (let i = 0; i < 80; i += 1) {
    state = observeCycle(state, { projectName: `proj-${i}`, confidence: 0.5, cited: false });
  }
  check("competence map is bounded", Object.keys(state.competence).length <= 64, `n=${Object.keys(state.competence).length}`);

  // (D) Persistence.
  saveSelfModelState(state);
  const reloaded = loadSelfModelState();
  check("state round-trips", isWeakDomain(reloaded, "darkzone") === true && reloaded.feedbackObservations === state.feedbackObservations);
}

// -----------------------------------------------------------------------------
// (C) confidenceForRun reads routing_log.
// -----------------------------------------------------------------------------

db.prepare(
  `INSERT INTO routing_log (id, run_id, profile, model, experts, difficulty, depth, cited_count, retrieved_count, confidence, latency_ms, created_at)
   VALUES ('rl1', 'run-abc', 'general', 'm', '[]', 0.5, 'full', 2, 5, 0.66, 100, ?)`,
).run(new Date().toISOString());
check("confidenceForRun reads the logged confidence", Math.abs((confidenceForRun("run-abc") ?? 0) - 0.66) < 1e-9);
check("unknown run → null (skip calibration honestly)", confidenceForRun("run-nope") === null);

// Broken store degrades.
db.exec("DROP TABLE IF EXISTS brain_metadata");
db.exec("DROP TABLE IF EXISTS routing_log");
let threw = false;
try {
  loadSelfModelState();
  saveSelfModelState(emptySelfModelState());
  confidenceForRun("x");
} catch {
  threw = true;
}
check("broken store: no throw", threw === false);
check("broken store loads the empty state", loadSelfModelState().feedbackObservations === 0);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
