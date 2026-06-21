// Hypothesis lifecycle selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH, NO
// LLM, NO network; the test path is ledger-read-only by design). Mirrors
// beliefs-selfcheck.ts.
//
// Run: npm --prefix server run hypotheses:selfcheck
//
// Asserts:
//   (A) PURE: evaluateConfidence (Laplace, symmetric, monotone); statusFor
//       transitions (open → supported / refuted / testing; retired sticky).
//   (B) Lifecycle over a temp DB: a causal hypothesis whose ledger strength is
//       high gets SUPPORTED after MIN_TEST_OBS tests and PROMOTES into a belief;
//       a low-strength one is REFUTED; a belief-derived one is supported; dedup
//       by statement; decayTick retires a stale hypothesis; sleepTick forms +
//       tests from the causal frontier.
//   (C) Robustness: test on an unknown id is a no-op; dropping the table never throws.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-hypotheses-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  SUPPORTED_AT,
  REFUTED_AT,
  evaluateConfidence,
  statusFor,
  getHypothesisEngine,
  __createHypothesisEngineForTests,
} = await import("../src/core/hypotheses.js");
const { recordObservation } = await import("../src/core/causalMap.js");
const { getBeliefEngine } = await import("../src/core/beliefs.js");
const { getEventBus } = await import("../src/core/eventBus.js");
const { openDb } = await import("../src/db/sqlite.js");

openDb();

// -----------------------------------------------------------------------------
// (A) PURE.
// -----------------------------------------------------------------------------

check("evaluateConfidence(0,0) = 0.5", evaluateConfidence(0, 0) === 0.5);
check("support raises confidence", evaluateConfidence(3, 0) > 0.5);
check("refute lowers confidence", evaluateConfidence(0, 3) < 0.5);
check("confidence is monotone", evaluateConfidence(4, 1) > evaluateConfidence(2, 1));

check("statusFor open before any test", statusFor(0, 0, "open") === "open");
check("statusFor supported on strong support", statusFor(3, 0, "testing") === "supported");
check("statusFor refuted on strong refute", statusFor(0, 3, "testing") === "refuted");
check("statusFor testing while inconclusive", statusFor(1, 1, "open") === "testing");
check("statusFor retired is sticky", statusFor(5, 0, "retired") === "retired");
check("thresholds ordered", REFUTED_AT < SUPPORTED_AT);

// -----------------------------------------------------------------------------
// (B) Lifecycle over a temp DB.
// -----------------------------------------------------------------------------

const engine = getHypothesisEngine();

let reflections = 0;
const off = getEventBus().on("cognition", (e: { event?: { reason?: string } }) => {
  if ((e?.event?.reason ?? "").startsWith("hypothesis:")) reflections += 1;
});

// Causal SUPPORTED: a cause that strongly produces "success".
for (let i = 0; i < 5; i++) recordObservation({ causeClass: "run-tests", effectClass: "success", occurred: true });
{
  const h = engine.formHypothesisFromObservation('Performing "run-tests" tends to cause "success".', { causeClass: "run-tests", effectClass: "success" });
  check("formHypothesis creates an open hypothesis", h !== null && h.status === "open");
  const id = h!.id;
  engine.test(id);
  const after2 = engine.test(id);
  check("causal hypothesis becomes supported", after2.hypothesis?.status === "supported", `conf=${after2.hypothesis?.confidence.toFixed(2)}`);
  const promoted = getBeliefEngine().listBeliefs({ limit: 50 }).some((b) => b.statement.includes("run-tests"));
  check("supported hypothesis PROMOTES into a belief", promoted);
}

// Causal REFUTED: a cause that rarely produces "failure".
for (let i = 0; i < 6; i++) recordObservation({ causeClass: "open-file", effectClass: "failure", occurred: false });
{
  const h = engine.formHypothesisFromObservation('Performing "open-file" tends to cause "failure".', { causeClass: "open-file", effectClass: "failure" });
  engine.test(h!.id);
  const r = engine.test(h!.id);
  check("low-strength causal hypothesis is refuted", r.hypothesis?.status === "refuted", `conf=${r.hypothesis?.confidence.toFixed(2)}`);
}

// Belief-derived SUPPORTED.
{
  const belief = getBeliefEngine().formBeliefFromFact("The borrow checker prevents data races in safe Rust", []);
  const h = engine.formHypothesisFromObservation("Safe Rust is free of data races by construction", { sourceBeliefId: belief!.id });
  engine.test(h!.id);
  const r = engine.test(h!.id);
  check("belief-derived hypothesis is supported", r.hypothesis?.status === "supported");
}

// Dedup.
{
  const a = engine.formHypothesisFromObservation("A clearly distinct testable statement about widgets");
  const b = engine.formHypothesisFromObservation("A clearly distinct testable statement about widgets");
  check("forming the same statement dedups", a !== null && b !== null && a!.id === b!.id);
}

check("test emitted hypothesis reflections", reflections > 0);
off();

// decayTick retires a stale hypothesis (old clock → old updated_at).
{
  const stale = __createHypothesisEngineForTests(getEventBus(), () => "2020-01-01T00:00:00.000Z");
  const h = stale.formHypothesisFromObservation("An ancient untested hypothesis that should go stale");
  const { retired } = stale.decayTick(new Date());
  check("decayTick retires a stale hypothesis", retired >= 1);
  check("retired hypothesis has retired status", stale.byId(h!.id)?.status === "retired");
}

// sleepTick forms + tests from the causal frontier.
{
  recordObservation({ causeClass: "scan-dir", effectClass: "deps-changed", occurred: true });
  const report = engine.sleepTick(new Date());
  check("sleepTick forms and/or tests hypotheses", report.tested >= 1 || report.formed >= 1, `formed=${report.formed} tested=${report.tested}`);
  const stats = engine.hypothesisStats();
  check("hypothesisStats tallies the ledger", stats.total >= 3 && stats.supported >= 1);
  check("stats JSON-serializable", JSON.parse(JSON.stringify(stats)).total === stats.total);
}

// -----------------------------------------------------------------------------
// (C) Robustness.
// -----------------------------------------------------------------------------

check("test on an unknown id is a no-op", engine.test("hyp-does-not-exist").support === null);

{
  openDb().exec("DROP TABLE IF EXISTS hypotheses");
  let threw = false;
  try {
    engine.formHypothesisFromObservation("after the table is gone, nothing should throw");
    engine.test("anything");
    engine.sleepTick(new Date());
    engine.hypothesisStats();
    engine.listHypotheses();
  } catch {
    threw = true;
  }
  check("no method throws with the table gone", threw === false);
}

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
