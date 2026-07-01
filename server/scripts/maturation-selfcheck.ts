// maturation selfcheck — gate for the H2 "developmental activation" slice.
//
// Hermetic (temp DB via BRAIN_DB_PATH): the resolver reads CONFIG + the
// persisted developmental stage (seeded directly into brain_metadata) + the
// energy budget.
//   (A) NO-REGRESSION: with MATURATION off, isFeatureActive(x) === CONFIG.x.
//   (B) static override: a set static flag wins regardless of stage.
//   (C) developmental gate: with MATURATION on + static off, a feature is locked
//       below its required stage and active at/above it.
//   (D) SECURITY is never developmental: the map contains ONLY cognitive
//       features — never localOnly/allowShell/civilization.
//   (E) maturationStatus shape + reasons.
//
// Run: npm --prefix server run maturation:selfcheck

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmp = mkdtempSync(join(tmpdir(), "brain-maturationcheck-"));
process.env.BRAIN_DATA_DIR = tmp;
process.env.BRAIN_DB_PATH = join(tmp, "test.sqlite");
process.env.PERCEPTION_WORKER_URL = "http://127.0.0.1:1";

const { openDb } = await import("../src/db/sqlite.js");
const { CONFIG } = await import("../src/config.js");
const { isFeatureActive, maturationStatus, MATURATION_STAGE } = await import("../src/core/maturation.js");

let failures = 0;
function check(label: string, ok: boolean, extra = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

const db = openDb();
function setStage(stage: number): void {
  db.prepare(
    "INSERT INTO brain_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run("developmental-stage-v1", JSON.stringify({ stage, reachedAt: "2026-06-17T00:00:00.000Z", history: [] }));
}

// Keep energy out of the way for the pure stage/flag logic (covered separately
// by energybudget:selfcheck).
CONFIG.energyBudget = false;

// =============================================================================
// (A) NO-REGRESSION — MATURATION off → isFeatureActive === the static flag
// =============================================================================
CONFIG.maturation = false;
setStage(1); // youngest brain
CONFIG.creativityEnabled = true;
check("MATURATION off + static ON → active (=== CONFIG flag)", isFeatureActive("creativity") === true);
CONFIG.creativityEnabled = false;
check("MATURATION off + static OFF → inactive even at... well, stage 1", isFeatureActive("creativity") === false);
CONFIG.theoryOfMind = true;
check("MATURATION off respects each feature's own static flag (ToM)", isFeatureActive("theory-of-mind") === true);
CONFIG.theoryOfMind = false;

// =============================================================================
// (B) static override wins regardless of stage
// =============================================================================
CONFIG.maturation = true;
setStage(1);
CONFIG.creativityEnabled = true;
check("static flag ON overrides an immature stage", isFeatureActive("creativity") === true);
CONFIG.creativityEnabled = false;

// =============================================================================
// (C) developmental gate — static OFF, grown into by stage
// =============================================================================
setStage(1); // belief-grounding unlocks at 2 (the stage where beliefs exist)
check("belief-grounding LOCKED below its stage (1 < 2)", isFeatureActive("belief-grounding") === false);
setStage(2);
check("belief-grounding ACTIVE once grown into (stage 2)", isFeatureActive("belief-grounding") === true);
setStage(4); // creativity unlocks at 5
check("creativity LOCKED below its stage (4 < 5)", isFeatureActive("creativity") === false);
setStage(5);
check("creativity ACTIVE once grown into (stage 5)", isFeatureActive("creativity") === true);
setStage(5);
check("theory-of-mind still LOCKED at stage 5 (needs 6)", isFeatureActive("theory-of-mind") === false);
setStage(6);
check("theory-of-mind ACTIVE at stage 6", isFeatureActive("theory-of-mind") === true);
setStage(9);
check("adaptive-controller + evolution-loop unlock at the top stage (9)", isFeatureActive("adaptive-controller") && isFeatureActive("evolution-loop"));

// Loop-closers routed through maturation (the C3/H4 "activate the loops" slice).
// Static flags off here, so these prove the developmental gate alone.
CONFIG.activeInference = false;
CONFIG.workspaceEventDriven = false;
setStage(6);
check("event-workspace LOCKED below its stage (6 < 7)", isFeatureActive("event-workspace") === false);
setStage(7);
check("event-workspace ACTIVE once grown into (stage 7)", isFeatureActive("event-workspace") === true);
check("active-inference still LOCKED at stage 7 (needs 8)", isFeatureActive("active-inference") === false);
setStage(8);
check("active-inference ACTIVE at stage 8 (the keystone loop-closer)", isFeatureActive("active-inference") === true);

// =============================================================================
// (D) SECURITY is never developmental
// =============================================================================
const keys = Object.keys(MATURATION_STAGE);
check(
  "maturation map contains ONLY cognitive features — no security/egress flag",
  !keys.includes("localOnly") &&
    !keys.includes("allowShell") &&
    !keys.includes("civilizationEnabled") &&
    !keys.includes("local-only") &&
    !keys.includes("allow-shell"),
  `keys=[${keys.join(", ")}]`,
);
check("maturation map covers exactly the 9 dark cognitive features", keys.length === 9, `n=${keys.length}`);

// =============================================================================
// (E) maturationStatus shape + reasons
// =============================================================================
CONFIG.maturation = true;
setStage(5);
const status = maturationStatus();
check("maturationStatus reports enabled + stage", status.enabled === true && status.stage === 5);
const creativity = status.features.find((f) => f.feature === "creativity");
const tom = status.features.find((f) => f.feature === "theory-of-mind");
check("status: creativity is active + matured at stage 5", !!creativity && creativity.active === true && creativity.matured === true);
check("status: theory-of-mind is locked at stage 5 with a clear reason", !!tom && tom.active === false && /locked until stage 6/.test(tom.reason), tom?.reason);
check("status flags expensive features (creativity expensive, ToM not)", !!creativity && creativity.expensive === true && !!tom && tom.expensive === false);

// =============================================================================
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
