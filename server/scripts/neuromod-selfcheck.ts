// Neuromodulator bus selfcheck — hermetic (throwaway DB via BRAIN_DB_PATH,
// no LLM, no network). Mirrors brainstate-selfcheck.ts.
//
// Run: npm --prefix server run neuromod:selfcheck
//
// Asserts:
//   (A) PURE math: decay halves the deviation per half-life, is a no-op at
//       dt<=0, and converges to baseline; pulses clamp; the learning-rate
//       scale is EXACTLY 1.0 at baseline (the no-regression contract);
//       the NE/ACh consumer gates open at their floors; pulsesForCycle maps
//       cited/uncited/contradictory cycles onto the right signs.
//   (B) The persisted singleton over a temp DB with an injected clock:
//       onCycle/onFeedback/onSurprise move levels; lazy decay applies over
//       time; state survives a fresh instance; status() derives consumers.
//   (C) Failure isolation: with brain_metadata dropped, no method throws and
//       levels degrade to baseline (every consumer a no-op).

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const tmp = mkdtempSync(join(tmpdir(), "brain-neuromod-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");

const {
  BASELINE,
  HALF_LIFE_MS,
  NE_BROADEN_FLOOR,
  ACH_AUGMENT_FLOOR,
  decayLevel,
  decayLevels,
  applyPulse,
  learningRateScale,
  shouldBroadenFromArousal,
  wantsFreshData,
  pulsesForCycle,
  __createNeuromodulatorsForTests,
} = await import("../src/core/neuromodulators.js");
const { openDb } = await import("../src/db/sqlite.js");

openDb();

// -----------------------------------------------------------------------------
// (A) PURE math.
// -----------------------------------------------------------------------------

// One half-life halves the deviation from baseline.
{
  const after = decayLevel(1.0, 0.2, 10 * 60_000, 10 * 60_000);
  check("decayLevel halves the deviation per half-life", Math.abs(after - (0.2 + 0.8 / 2)) < 1e-9, `after=${after}`);
  check("decayLevel dt=0 is a no-op", decayLevel(0.9, 0.2, 0, 10 * 60_000) === 0.9);
  check("decayLevel converges to baseline", Math.abs(decayLevel(1, 0.2, 1e9, 10 * 60_000) - 0.2) < 1e-3);
  check("decayLevel decays upward toward baseline too", decayLevel(0, 0.5, 60_000, 60_000) > 0);
}

// decayLevels respects per-modulator half-lives (NE fades fastest).
{
  const hot = { dopamine: 1, norepinephrine: 1, acetylcholine: 1 };
  const later = decayLevels(hot, 20 * 60_000);
  const neDrop = 1 - later.norepinephrine;
  const daDrop = 1 - later.dopamine;
  check("NE decays faster than DA (shorter half-life)", neDrop > daDrop, `ne=${later.norepinephrine.toFixed(3)} da=${later.dopamine.toFixed(3)}`);
  check("half-life table sanity", HALF_LIFE_MS.norepinephrine < HALF_LIFE_MS.dopamine);
}

check("applyPulse clamps above", applyPulse(0.9, 0.5) === 1);
check("applyPulse clamps below", applyPulse(0.1, -0.5) === 0);
check("applyPulse ignores NaN delta", applyPulse(0.4, Number.NaN) === 0.4);

// Learning-rate scale: EXACTLY 1.0 at baseline dopamine — the contract that
// makes the modulator a strict no-op until reward has moved it.
check("learningRateScale at baseline dopamine = 1.0", learningRateScale({ ...BASELINE }) === 1.0);
check("learningRateScale monotone in dopamine", learningRateScale({ ...BASELINE, dopamine: 1 }) > learningRateScale({ ...BASELINE, dopamine: 0 }));
check("learningRateScale bounded [0.5, 1.5]",
  learningRateScale({ ...BASELINE, dopamine: 0 }) === 0.5 && learningRateScale({ ...BASELINE, dopamine: 1 }) === 1.5);

check("NE gate closed at baseline", shouldBroadenFromArousal({ ...BASELINE }) === false);
check("NE gate opens at the floor", shouldBroadenFromArousal({ ...BASELINE, norepinephrine: NE_BROADEN_FLOOR }) === true);
check("ACh gate closed at baseline", wantsFreshData({ ...BASELINE }) === false);
check("ACh gate opens at the floor", wantsFreshData({ ...BASELINE, acetylcholine: ACH_AUGMENT_FLOOR }) === true);

// pulsesForCycle signs.
{
  const cited = pulsesForCycle({ confidence: 0.8, citedCount: 3, contradictions: 0 });
  check("cited cycle pulses dopamine up", cited.dopamine > 0);
  check("cited confident cycle relieves acetylcholine", cited.acetylcholine < 0);
  const uncited = pulsesForCycle({ confidence: 0.2, citedCount: 0, contradictions: 0 });
  check("uncited cycle pulses dopamine down", uncited.dopamine < 0);
  check("uncertain cycle builds acetylcholine", uncited.acetylcholine > 0);
  const contradicted = pulsesForCycle({ confidence: 0.5, citedCount: 1, contradictions: 2 });
  check("contradictions pulse norepinephrine", contradicted.norepinephrine > 0);
  check("no contradictions → no NE pulse", cited.norepinephrine === 0);
}

// -----------------------------------------------------------------------------
// (B) Persisted singleton with injected clock.
// -----------------------------------------------------------------------------

let clk = 1_000_000;
const bus = __createNeuromodulatorsForTests(() => clk);

const initial = bus.levels();
check("cold store reads baseline levels", Math.abs(initial.dopamine - BASELINE.dopamine) < 1e-9);

bus.onCycle({ confidence: 0.9, citedCount: 4, contradictions: 0 });
let lv = bus.levels();
check("onCycle moves dopamine above baseline", lv.dopamine > BASELINE.dopamine, `da=${lv.dopamine}`);

bus.onFeedback(1);
const afterUp = bus.levels().dopamine;
check("👍 pulses dopamine further", afterUp > lv.dopamine);
bus.onFeedback(-1);
check("👎 pulls dopamine back down", bus.levels().dopamine < afterUp);

bus.onSurprise(1);
lv = bus.levels();
check("surprise pulses norepinephrine", lv.norepinephrine > BASELINE.norepinephrine, `ne=${lv.norepinephrine}`);

// Lazy decay: jump the clock far ahead — levels return near baseline.
clk += 24 * 60 * 60 * 1000;
lv = bus.levels();
check("lazy decay returns levels to ~baseline after a day", Math.abs(lv.norepinephrine - BASELINE.norepinephrine) < 0.01 && Math.abs(lv.dopamine - BASELINE.dopamine) < 0.01);

// Persistence: a fresh instance (same DB) sees the stored state.
{
  bus.onSurprise(0.8);
  const reborn = __createNeuromodulatorsForTests(() => clk);
  check("state persists across instances", reborn.levels().norepinephrine > BASELINE.norepinephrine);
}

// status() derives the consumer signals coherently.
{
  const status = bus.status();
  check("status carries levels + baseline + consumers",
    typeof status.learningRateScale === "number" &&
    typeof status.broadenFromArousal === "boolean" &&
    typeof status.wantsFreshData === "boolean" &&
    status.pulses > 0);
  check("status is JSON-serializable", JSON.parse(JSON.stringify(status)).pulses === status.pulses);
}

// -----------------------------------------------------------------------------
// (C) Failure isolation.
// -----------------------------------------------------------------------------

openDb().exec("DROP TABLE IF EXISTS brain_metadata");
let threw = false;
try {
  bus.onCycle({ confidence: 0.5, citedCount: 1, contradictions: 1 });
  bus.onFeedback(1);
  bus.onSurprise(0.5);
  bus.levels();
  bus.status();
} catch {
  threw = true;
}
check("no method throws with brain_metadata gone", threw === false);
check("broken store degrades to baseline (consumers no-op)",
  learningRateScale(bus.levels()) === 1.0 && shouldBroadenFromArousal(bus.levels()) === false);

const result = failures === 0 ? "PASS" : "FAIL";
console.log(JSON.stringify({ failures, result }, null, 2));
process.exit(failures === 0 ? 0 : 1);
