// energy budget selfcheck — gate for the H1 "homeostatic energy budget" slice.
//
// Hermetic (temp DB via BRAIN_DB_PATH):
//   (A) energyToBudget (pure): NO-REGRESSION FLOOR at/above FULL_FLOOR (zero
//       penalty, full retrieval, optional on); monotone ramp below it; the
//       mayRunOptional gate at OPTIONAL_FLOOR; energyDeficit = 1 − fraction;
//       clamp of out-of-range input.
//   (B) fullEnergyBudget is the rested no-op.
//   (C) currentEnergyBudget returns a FULL budget when ENERGY_BUDGET is off
//       (so callers can call it unconditionally) and a valid budget when on.
//   (D) organism.getEnergyFraction reads a finite fraction in [0,1].
//
// Run: npm --prefix server run energybudget:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-energycheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const eb = await import("../src/core/energyBudget.js");
const { getPersistentOrganism } = await import("../src/core/organism.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

openDb();

// =============================================================================
// (A) energyToBudget — pure
// =============================================================================
const full = eb.energyToBudget(1);
check(
  "full energy is a strict no-op (penalty 0, scale 1, optional on, deficit 0)",
  full.depthPenalty === 0 && full.retrievalScale === 1 && full.mayRunOptional === true && full.energyDeficit === 0,
  JSON.stringify(full),
);
const floor = eb.energyToBudget(eb.FULL_FLOOR);
check(
  "AT the FULL_FLOOR boundary the budget is still a no-op (no-regression edge)",
  floor.depthPenalty === 0 && floor.retrievalScale === 1 && floor.mayRunOptional === true,
  JSON.stringify(floor),
);
const quarter = eb.energyToBudget(0.25);
check(
  "at 0.25 energy: depthPenalty 0.1, retrievalScale 0.8, optional still on, deficit 0.75",
  Math.abs(quarter.depthPenalty - 0.1) < 1e-9 &&
    Math.abs(quarter.retrievalScale - 0.8) < 1e-9 &&
    quarter.mayRunOptional === true &&
    Math.abs(quarter.energyDeficit - 0.75) < 1e-9,
  JSON.stringify(quarter),
);
const empty = eb.energyToBudget(0);
check(
  "depleted: depthPenalty hits MAX (0.2), retrievalScale hits MIN (0.6), optional OFF, deficit 1",
  Math.abs(empty.depthPenalty - eb.MAX_DEPTH_PENALTY) < 1e-9 &&
    Math.abs(empty.retrievalScale - eb.MIN_RETRIEVAL_SCALE) < 1e-9 &&
    empty.mayRunOptional === false &&
    empty.energyDeficit === 1,
  JSON.stringify(empty),
);
const low = eb.energyToBudget(0.1);
check("below OPTIONAL_FLOOR (0.1) the optional gate closes", low.mayRunOptional === false);
check(
  "monotone: lower energy → more depth penalty, less retrieval",
  empty.depthPenalty > quarter.depthPenalty && empty.retrievalScale < quarter.retrievalScale,
);
const overshoot = eb.energyToBudget(2);
const undershoot = eb.energyToBudget(-1);
check("clamps out-of-range input (2 → no-op, −1 → depleted)", overshoot.depthPenalty === 0 && undershoot.mayRunOptional === false);

// =============================================================================
// (B) fullEnergyBudget
// =============================================================================
const fb = eb.fullEnergyBudget();
check("fullEnergyBudget() is the rested no-op", fb.depthPenalty === 0 && fb.retrievalScale === 1 && fb.mayRunOptional === true);

// =============================================================================
// (C) currentEnergyBudget — flag gate
// =============================================================================
const prev = CONFIG.energyBudget;
CONFIG.energyBudget = false;
const offBudget = eb.currentEnergyBudget();
check(
  "currentEnergyBudget() with ENERGY_BUDGET off is a FULL no-op budget",
  offBudget.depthPenalty === 0 && offBudget.retrievalScale === 1 && offBudget.mayRunOptional === true,
  JSON.stringify(offBudget),
);
CONFIG.energyBudget = true;
let onThrew = false;
let onBudget = eb.fullEnergyBudget();
try {
  onBudget = eb.currentEnergyBudget();
} catch {
  onThrew = true;
}
check(
  "currentEnergyBudget() with ENERGY_BUDGET on reads the organism without throwing",
  !onThrew &&
    onBudget.fraction >= 0 &&
    onBudget.fraction <= 1 &&
    onBudget.depthPenalty >= 0 &&
    onBudget.retrievalScale <= 1,
  JSON.stringify(onBudget),
);
CONFIG.energyBudget = prev;

// =============================================================================
// (D) organism.getEnergyFraction
// =============================================================================
const frac = getPersistentOrganism().getEnergyFraction();
check("organism.getEnergyFraction() is a finite fraction in [0,1]", Number.isFinite(frac) && frac >= 0 && frac <= 1, `frac=${frac}`);

// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
